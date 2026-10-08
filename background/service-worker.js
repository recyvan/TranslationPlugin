// 后台 Service Worker：统一负责翻译请求（绕过 CORS）、设置存储、缓存与重试。
// 内容脚本 / 弹窗 / 设置页都通过 chrome.runtime.sendMessage 与这里通信。

import { STORAGE_KEY } from '../shared/defaults.js';
import { providerLang } from '../shared/langs.js';
import { mergeDefaults, resolveAiProfile, applyPartial } from '../shared/settings.js';
import { getProvider, CHUNK_LIMITS, takeAiTokens, abortActiveRequests } from './providers.js';
import { applyProxy, getProxyStatus } from './proxy.js';

// ---------------------------------------------------------------- 设置读写（内存缓存）
// 每个翻译批次都会读设置，缓存在 Service Worker 内存中避免频繁 storage IO；
// 任何页面修改设置都会触发 storage.onChanged 同步刷新缓存。

let settingsCache = null;
let settingsPromise = null;

// 设置的合并、迁移与 AI 方案解析统一放在 shared/settings.js（纯函数、可测试）。
// 这里只保留带内存缓存的读写逻辑。

async function getSettings() {
  if (settingsCache) return settingsCache;
  if (!settingsPromise) {
    settingsPromise = chrome.storage.local
      .get(STORAGE_KEY)
      .then((data) => {
        settingsCache = mergeDefaults(data && data[STORAGE_KEY]);
        settingsPromise = null;
        return settingsCache;
      })
      .catch((e) => {
        settingsPromise = null;
        throw e;
      });
  }
  return settingsPromise;
}

async function saveSettings(partial) {
  const current = await getSettings();
  // 深合并后再规范化：部分更新（例如弹窗切换 AI 方案时只提交 { ai: { activeId } }）
  // 若按浅合并处理会整个替换 ai 对象，已保存的方案与 API Key 会被清空。
  const next = applyPartial(current, partial || {});
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  settingsCache = next;
  return next;
}

// ---------------------------------------------------------------- 用量统计（按服务分类）
// 按实际使用的翻译服务分桶记录：google / ai:<模型名>。
// 数据结构：{ days: { 日期: { 服务: {chars, requests, aiTokens} } }, total: { 服务: {...} } }

const USAGE_KEY = 'itrUsage2';
let usageCache = null;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function newBucket() {
  return { chars: 0, requests: 0, aiTokens: 0 };
}

async function loadUsage() {
  if (usageCache) return usageCache;
  const data = await chrome.storage.local.get(USAGE_KEY);
  usageCache =
    data && data[USAGE_KEY] && data[USAGE_KEY].total
      ? data[USAGE_KEY]
      : { days: {}, total: {} };
  return usageCache;
}

async function recordUsage(serviceKey, chars, requests, aiTokens) {
  if (!chars && !requests) return;
  try {
    const usage = await loadUsage();
    const addTo = (obj) => {
      const bucket = obj[serviceKey] || (obj[serviceKey] = newBucket());
      bucket.chars += chars;
      bucket.requests += requests;
      if (aiTokens > 0) bucket.aiTokens += aiTokens;
    };
    const dayKey = todayKey();
    const day = usage.days[dayKey] || (usage.days[dayKey] = {});
    addTo(day);
    addTo(usage.total);
    // 只保留最近 30 天
    const keys = Object.keys(usage.days).sort();
    while (keys.length > 30) delete usage.days[keys.shift()];
    await chrome.storage.local.set({ [USAGE_KEY]: usage });
    usageCache = usage;
  } catch (e) { /* 统计失败不影响翻译 */ }
}

async function handleGetUsage() {
  const usage = await loadUsage();
  const today = usage.days[todayKey()] || {};
  return { ok: true, today, total: usage.total };
}

async function handleResetUsage() {
  usageCache = { days: {}, total: {} };
  await chrome.storage.local.set({ [USAGE_KEY]: usageCache });
  return { ok: true };
}

// ---------------------------------------------------------------- 缓存

const cache = new Map();
const CACHE_MAX = 6000;

function cacheKey(provider, from, to, text) {
  return `${provider}|${from}>${to}|${text}`;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    let dropped = 0;
    const target = Math.floor(CACHE_MAX / 4);
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++dropped >= target) break;
    }
  }
  cache.set(key, value);
}

// ---------------------------------------------------------------- 并发池与重试

async function runPool(items, limit, worker) {
  let index = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 单个批次翻译：先整体尝试；返回 null（行数对不齐）时，小批次逐条、
// 大批次二分重试（请求数从 N 降到约 2·log₂N），保证结果顺序永远正确
async function translateChunk(provider, texts, from, to, settings) {
  const prov = getProvider(provider);
  const pFrom = provider === 'ai' ? from : providerLang(provider, from);
  const pTo = providerLang(provider, to);
  const cfg = settings[provider] || {};

  const first = await prov.translate(texts, pFrom, pTo, cfg);
  if (first) return first;

  if (texts.length >= 4) {
    const mid = Math.ceil(texts.length / 2);
    const [a, b] = await Promise.all([
      translateChunk(provider, texts.slice(0, mid), from, to, settings),
      translateChunk(provider, texts.slice(mid), from, to, settings)
    ]);
    return [...a, ...b];
  }

  const out = [];
  for (const text of texts) {
    const one = await prov.translate([text], pFrom, pTo, cfg);
    out.push(one ? one[0] : '');
  }
  return out;
}

async function translateWithRetry(provider, texts, from, to, settings) {
  let lastErr;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await translateChunk(provider, texts, from, to, settings);
    } catch (e) {
      lastErr = e;
      if (e && e.cancelled) break; // 用户取消：不重试
      if (!e || !e.retryable || attempt === 2) break;
      await sleep(800 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

// 按服务的体积上限把一批唯一文本切分为多个请求块
const utf8 = new TextEncoder();

function chunkTexts(provider, texts) {
  const limits = CHUNK_LIMITS[provider] || { chars: 1500, lines: 40 };
  const chunks = [];
  let cur = [];
  let chars = 0;
  let bytes = 0;
  for (const text of texts) {
    const b = limits.bytes ? utf8.encode(text).length : 0;
    const overChars = limits.chars && cur.length > 0 && chars + text.length > limits.chars;
    const overBytes = limits.bytes && cur.length > 0 && bytes + b > limits.bytes;
    if (cur.length >= limits.lines || overChars || overBytes) {
      chunks.push(cur);
      cur = [];
      chars = 0;
      bytes = 0;
    }
    cur.push(text);
    chars += text.length;
    bytes += b;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---------------------------------------------------------------- 消息处理：翻译

async function handleTranslate(msg) {
  const settings = await getSettings();
  const provider = msg.provider || settings.provider;
  const prov = getProvider(provider);
  if (!prov) return { ok: false, error: `未知的翻译服务：${provider}` };

  // AI 多方案：始终使用 activeId 指向的方案，不在方案间自动切换
  let aiProfile = null;
  if (provider === 'ai') {
    aiProfile = resolveAiProfile(settings, settings.ai.activeId);
    if (!aiProfile || !(aiProfile.baseUrl && aiProfile.apiKey && aiProfile.model)) {
      return { ok: false, error: '尚未配置 AI 翻译方案：请填写接口地址、API Key 和模型名称' };
    }
  }

  const from = msg.from || settings.from || 'auto';
  const to = msg.to || settings.to || 'zh-CN';
  const texts = (msg.texts || []).map((t) => String(t));
  if (!texts.length) return { ok: true, results: [] };

  // AI 使用所选方案作为该服务的生效配置；其他服务用全局设置
  const effSettings = provider === 'ai'
    ? { ...settings, ai: { ...aiProfile, style: settings.ai.style } }
    : settings;
  // 用量按实际使用的服务分桶：AI 记录到具体模型
  const serviceKey = provider === 'ai' ? 'ai:' + (aiProfile.model || '未知模型') : provider;

  const results = new Array(texts.length);
  const missing = [];
  texts.forEach((text, i) => {
    const hit = settings.cacheEnabled
      ? cache.get(cacheKey(provider, from, to, text))
      : undefined;
    if (hit !== undefined) results[i] = hit;
    else missing.push(i);
  });

  if (missing.length) {
    const uniqueTexts = [...new Set(missing.map((i) => texts[i]))];
    const chunks = chunkTexts(provider, uniqueTexts);
    const limit =
      provider === 'ai'
        ? Math.max(1, settings.ai.concurrency || 3)
        : Math.max(1, settings.concurrency || 3);

    const resultMap = new Map();
    const failedTexts = [];
    let lastError = '';
    await runPool(chunks, limit, async (chunk) => {
      try {
        const out = await translateWithRetry(provider, chunk, from, to, effSettings);
        chunk.forEach((text, j) => resultMap.set(text, out[j] != null ? out[j] : ''));
      } catch (e) {
        // 单块失败不影响其他块：失败文本回退为原文，并通过 failedTexts 告知调用方
        lastError = (e && e.message) || '翻译请求失败';
        chunk.forEach((text) => {
          resultMap.set(text, text);
          failedTexts.push(text);
        });
      }
    });

    // 用量统计：按实际使用的服务分桶记录
    const aiTokens = provider === 'ai' ? takeAiTokens() : 0;
    recordUsage(
      serviceKey,
      uniqueTexts.reduce((n, t) => n + t.length, 0),
      chunks.length,
      aiTokens
    );

    missing.forEach((i) => {
      const text = texts[i];
      const value = resultMap.has(text) ? resultMap.get(text) : text;
      results[i] = value;
      if (settings.cacheEnabled && !failedTexts.includes(text)) {
        cacheSet(cacheKey(provider, from, to, text), value);
      }
    });

    // 全部块都失败时返回明确错误
    if (failedTexts.length && failedTexts.length === uniqueTexts.length) {
      return { ok: false, error: lastError || '翻译请求失败' };
    }
    return {
      ok: true,
      results,
      failedTexts: failedTexts.length ? failedTexts : undefined,
      error: lastError || undefined
    };
  }

  return { ok: true, results };
}

// ---------------------------------------------------------------- 消息处理：设置

async function handleGetSettings() {
  return { ok: true, settings: await getSettings() };
}

async function handleSaveSettings(msg) {
  const settings = await saveSettings(msg.settings);
  // 设置变化后立即重新应用代理
  try {
    await applyProxy(settings);
  } catch (e) { /* 代理应用失败不阻塞保存 */ }
  return { ok: true, settings };
}

// 服务连通性测试：翻译固定例句，返回耗时与结果。
// AI 支持指定方案（设置页测试的是“正在编辑”的方案，而非当前使用的方案）。
async function handleTestProvider(msg) {
  const settings = await getSettings();
  const provider = msg.provider || settings.provider;
  const from = msg.from || 'auto';
  const to = msg.to || settings.to || 'zh-CN';

  let effSettings = settings;
  let serviceKey = provider;
  if (provider === 'ai') {
    const profile = resolveAiProfile(settings, msg.aiProfileId);
    if (!profile || !(profile.baseUrl && profile.apiKey && profile.model)) {
      return { ok: false, error: '该 AI 方案配置不完整：请填写接口地址、API Key 和模型名称', provider };
    }
    effSettings = { ...settings, ai: { ...profile, style: settings.ai.style } };
    serviceKey = 'ai:' + (profile.model || '未知模型');
  }

  const sample = ['Hello, world! This is a connection test.'];
  const t0 = Date.now();
  try {
    const out = await translateWithRetry(provider, sample, from, to, effSettings);
    recordUsage(serviceKey, sample[0].length, 1, provider === 'ai' ? takeAiTokens() : 0);
    return { ok: true, text: out[0] || '', ms: Date.now() - t0, provider };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '测试失败', provider };
  }
}

async function handleClearCache() {
  cache.clear();
  return { ok: true };
}

async function handleProxyStatus() {
  return getProxyStatus();
}

// ---------------------------------------------------------------- 右键菜单（可开关）

async function syncContextMenus(settings) {
  if (!chrome.contextMenus) return;
  const enabled = !settings || settings.contextMenu !== false;
  try {
    await new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve()));
    if (enabled) {
      chrome.contextMenus.create({ id: 'itr-page', title: '翻译整个网页', contexts: ['page'] });
      chrome.contextMenus.create({ id: 'itr-restore', title: '恢复原文', contexts: ['page'] });
    }
  } catch (e) { /* 菜单同步失败不影响其他功能 */ }
}

// ---------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('itr:')) return;

  const handlers = {
    'itr:getSettings': handleGetSettings,
    'itr:saveSettings': handleSaveSettings,
    'itr:translate': handleTranslate,
    'itr:testProvider': handleTestProvider,
    'itr:clearCache': handleClearCache,
    'itr:proxyStatus': handleProxyStatus,
    'itr:abortActive': () => {
      abortActiveRequests();
      return { ok: true };
    },
    'itr:getUsage': handleGetUsage,
    'itr:resetUsage': handleResetUsage
  };
  const handler = handlers[msg.type];
  if (!handler) {
    sendResponse({ ok: false, error: `未知消息类型：${msg.type}` });
    return;
  }

  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true; // 异步响应
});

// ---------------------------------------------------------------- 安装与快捷指令

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });

  try {
    await applyProxy(settings);
  } catch (e) { /* 忽略代理应用失败 */ }

  await syncContextMenus(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  // 浏览器重启后按当前设置重新应用代理与右键菜单
  try {
    const settings = await getSettings();
    await applyProxy(settings);
    await syncContextMenus(settings);
  } catch (e) { /* 忽略 */ }
});

// 设置被任何页面修改时：刷新缓存、重新应用代理与右键菜单
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEY]) {
    settingsCache = mergeDefaults(changes[STORAGE_KEY].newValue);
    const settings = settingsCache;
    applyProxy(settings).catch(() => {});
    syncContextMenus(settings);
  }
  if (changes[USAGE_KEY]) {
    usageCache = changes[USAGE_KEY].newValue || usageCache;
  }
});

async function sendToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (e) {
      // 页面不支持内容脚本（如 chrome:// 页面），忽略
    }
  } catch (e) {
    // 无活动标签页，忽略
  }
}

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'toggle-translate') {
    sendToActiveTab({ type: 'itr:page', action: 'toggle' });
  }
});

chrome.contextMenus?.onClicked.addListener((info) => {
  if (info.menuItemId === 'itr-page') {
    sendToActiveTab({ type: 'itr:page', action: 'start' });
  } else if (info.menuItemId === 'itr-restore') {
    sendToActiveTab({ type: 'itr:page', action: 'restore' });
  }
});
