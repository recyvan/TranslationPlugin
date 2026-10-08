// 设置页逻辑：设置读写、AI 多方案管理（增删改/切换，不自动切换）、
// 服务连通性测试、按服务分类的用量统计、代理管理与高级功能。

import { LANGS, SOURCE_LANGS } from '../shared/langs.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- AI 方案（内存态）

let aiProfiles = [];   // 方案列表（保存设置时整体写回）
let aiActiveId = null; // 当前使用的方案
let aiEditId = null;   // 正在编辑的方案

function makeProfile(name) {
  return {
    id: 'profile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: name || '新方案',
    baseUrl: '',
    apiKey: '',
    model: '',
    apiFormat: 'openai',
    temperature: 0.2,
    prompt: ''
  };
}

function currentEditProfile() {
  return aiProfiles.find((p) => p.id === aiEditId) || aiProfiles[0] || null;
}

function renderAiSelects() {
  if (!aiProfiles.some((p) => p.id === aiEditId)) {
    aiEditId = aiProfiles[0] ? aiProfiles[0].id : null;
  }
  if (!aiProfiles.some((p) => p.id === aiActiveId)) {
    aiActiveId = aiProfiles[0] ? aiProfiles[0].id : null;
  }
  for (const [sel, selected] of [[$('selAiActive'), aiActiveId], [$('selAiProfile'), aiEditId]]) {
    sel.innerHTML = '';
    for (const p of aiProfiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || '未命名方案';
      sel.appendChild(opt);
    }
    sel.value = selected;
  }
}

function fillProfileForm(p) {
  $('inAiName').value = p.name || '';
  $('selAiFormat').value = p.apiFormat || 'openai';
  $('inAiBase').value = p.baseUrl || '';
  $('inAiKey').value = p.apiKey || '';
  $('inAiModel').value = p.model || '';
  $('inAiTemp').value = Number.isFinite(p.temperature) ? p.temperature : 0.2;
  $('inAiPrompt').value = p.prompt || '';
}

function readProfileForm() {
  const temp = parseFloat($('inAiTemp').value);
  return {
    id: aiEditId,
    name: $('inAiName').value.trim().slice(0, 40) || '未命名方案',
    baseUrl: $('inAiBase').value.trim(),
    apiKey: $('inAiKey').value.trim(),
    model: $('inAiModel').value.trim(),
    apiFormat: $('selAiFormat').value === 'claude' ? 'claude' : 'openai',
    temperature: Number.isFinite(temp) ? Math.min(1, Math.max(0, temp)) : 0.2,
    prompt: $('inAiPrompt').value
  };
}

// 把表单内容合并进内存中的方案列表（不落盘；点「保存设置」时统一写回）
function syncEditIntoProfiles() {
  if (!aiEditId) return;
  const updated = readProfileForm();
  const idx = aiProfiles.findIndex((p) => p.id === aiEditId);
  if (idx >= 0) aiProfiles[idx] = updated;
  else aiProfiles.push(updated);
}

function aiProfileTip(text, isError) {
  const el = $('aiProfileTip');
  el.textContent = text;
  el.style.color = isError ? '#ef4444' : '#16a34a';
  setTimeout(() => (el.textContent = ''), 3500);
}

// ---------------------------------------------------------------- 加载 / 保存

function fillSelect(sel, list, value) {
  sel.innerHTML = '';
  for (const item of list) {
    const opt = document.createElement('option');
    opt.value = item.code;
    opt.textContent = item.name;
    sel.appendChild(opt);
  }
  sel.value = value;
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'itr:getSettings' });
  if (!res || !res.ok) throw new Error((res && res.error) || '读取设置失败');
  const s = res.settings;

  $('selProvider').value = s.provider;
  fillSelect($('selTo'), LANGS, s.to);
  fillSelect($('selFrom'), SOURCE_LANGS, s.from);
  $('selMode').value = s.displayMode;
  $('inColor').value = s.translationColor;
  $('inConcurrency').value = s.concurrency;
  $('chkCache').checked = !!s.cacheEnabled;
  $('chkSkipSame').checked = !!s.autoDetectSkip;
  $('chkContextMenu').checked = s.contextMenu !== false;

  aiProfiles = (s.ai.profiles && s.ai.profiles.length ? s.ai.profiles : [makeProfile('默认方案')])
    .map((p) => ({ ...p }));
  aiActiveId = s.ai.activeId;
  aiEditId = aiActiveId;
  renderAiSelects();
  fillProfileForm(currentEditProfile());
  $('selAiStyle').value = s.ai.style || 'general';
  $('inAiConcurrency').value = s.ai.concurrency;

  $('selProxyMode').value = s.proxy.mode;
  $('selProxyScope').value = s.proxy.scope;
  $('selProxyProtocol').value = s.proxy.protocol;
  $('inProxyHost').value = s.proxy.host || '';
  $('inProxyPort').value = s.proxy.port || '';

  $('inBlacklist').value = (s.blacklist || []).join('\n');

  updateProxyFields();
  refreshProxyStatus();
}

function collect() {
  const num = (el, min, max, dflt) => {
    const v = parseInt(el.value, 10);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
  };
  syncEditIntoProfiles();
  return {
    provider: $('selProvider').value,
    to: $('selTo').value,
    from: $('selFrom').value,
    displayMode: $('selMode').value,
    translationColor: $('inColor').value,
    concurrency: num($('inConcurrency'), 1, 6, 3),
    cacheEnabled: $('chkCache').checked,
    autoDetectSkip: $('chkSkipSame').checked,
    contextMenu: $('chkContextMenu').checked,
    ai: {
      activeId: aiActiveId,
      profiles: aiProfiles,
      style: $('selAiStyle').value,
      concurrency: num($('inAiConcurrency'), 1, 4, 3)
    },
    proxy: {
      mode: $('selProxyMode').value,
      scope: $('selProxyScope').value,
      protocol: $('selProxyProtocol').value,
      host: $('inProxyHost').value.trim(),
      port: $('inProxyPort').value.trim()
    },
    blacklist: $('inBlacklist').value
      .split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  };
}

function tip(text, isError) {
  const el = $('saveTip');
  el.textContent = text;
  el.style.color = isError ? '#ef4444' : '';
}

async function save() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'itr:saveSettings',
      settings: collect()
    });
    if (res && res.ok) {
      tip('已保存 ✓');
      refreshProxyStatus();
      renderAiSelects();
    } else {
      tip('保存失败：' + ((res && res.error) || '未知错误'), true);
    }
  } catch (e) {
    tip('保存失败：' + (e && e.message), true);
  }
  setTimeout(() => (tip('')), 2500);
}

// ---------------------------------------------------------------- 服务测试

function setTestResult(el, text, isError) {
  el.textContent = text;
  el.style.color = isError ? '#ef4444' : '#16a34a';
}

async function testProvider(resultEl, provider, aiProfileId) {
  setTestResult(resultEl, '测试中…', false);
  // 先保存当前表单，保证测试用的就是用户看到的配置
  const saved = await chrome.runtime.sendMessage({ type: 'itr:saveSettings', settings: collect() });
  if (!saved || !saved.ok) {
    setTestResult(resultEl, '保存设置失败，无法测试', true);
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'itr:testProvider',
    provider: provider || $('selProvider').value,
    aiProfileId: aiProfileId
  });
  if (res && res.ok) {
    setTestResult(resultEl, `✓ 连通正常（${res.ms}ms）：${res.text || '（空结果）'}`, false);
  } else {
    setTestResult(resultEl, `✗ ${(res && res.error) || '测试失败'}`, true);
  }
}

// ---------------------------------------------------------------- 模型列表

async function fetchModels() {
  const resultEl = $('testAiResult');
  const baseUrl = $('inAiBase').value.trim();
  const apiKey = $('inAiKey').value.trim();
  const isClaude = $('selAiFormat').value === 'claude';
  if (!baseUrl || !apiKey) {
    setTestResult(resultEl, '请先填写接口地址和 API Key', true);
    return;
  }
  setTestResult(resultEl, '获取模型列表中…', false);

  let modelsUrl;
  try {
    let b = baseUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
    b = b.replace(/\/chat\/completions$/, '').replace(/\/v1\/messages$/, '');
    if (isClaude && !/\/v1$/.test(b)) b += '/v1';
    modelsUrl = b + '/models';
  } catch (e) {
    setTestResult(resultEl, '接口地址格式不正确', true);
    return;
  }

  const headers = isClaude
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey}` };

  try {
    const resp = await fetch(modelsUrl, { headers });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const list = (data.data || data.models || [])
      .map((m) => m.id || m.name || '')
      .filter(Boolean)
      .sort();
    if (!list.length) throw new Error('返回列表为空');

    const datalist = $('aiModels');
    datalist.innerHTML = '';
    for (const id of list) {
      const opt = document.createElement('option');
      opt.value = id;
      datalist.appendChild(opt);
    }
    setTestResult(resultEl, `✓ 获取到 ${list.length} 个模型，可在“模型名称”下拉选择`, false);
  } catch (e) {
    setTestResult(resultEl, `✗ 获取失败（${e && e.message}），可手动填写模型名`, true);
  }
}

// ---------------------------------------------------------------- 代理

function updateProxyFields() {
  const custom = $('selProxyMode').value === 'custom';
  for (const id of ['selProxyScope', 'selProxyProtocol', 'inProxyHost', 'inProxyPort']) {
    $(id).disabled = !custom;
  }
}

async function refreshProxyStatus() {
  const el = $('proxyStatus');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'itr:proxyStatus' });
    if (!res || !res.ok) {
      el.textContent = '';
      return;
    }
    if (res.warning) {
      el.textContent = '⚠ ' + res.warning;
      el.style.color = '#ef4444';
      return;
    }
    el.textContent = '当前代理：' + (res.current || '浏览器默认');
    el.style.color = '';
  } catch (e) {
    el.textContent = '';
  }
}

// ---------------------------------------------------------------- 用量统计（按服务分类）

const SERVICE_LABELS = { google: '谷歌翻译' };

function serviceLabel(key) {
  return SERVICE_LABELS[key] || (key.indexOf('ai:') === 0 ? 'AI · ' + key.slice(3) : key);
}

function fmtUsage(u) {
  const tokenPart = u.aiTokens > 0 ? ` · ${u.aiTokens.toLocaleString()} token` : '';
  return `${(u.chars || 0).toLocaleString()} 字符 · ${(u.requests || 0).toLocaleString()} 次请求${tokenPart}`;
}

function renderUsageRows(el, data) {
  el.replaceChildren();
  const keys = Object.keys(data || {}).sort((a, b) => (data[b].chars || 0) - (data[a].chars || 0));
  if (!keys.length) {
    const row = document.createElement('div');
    row.className = 'usage-row';
    row.textContent = '暂无数据';
    el.appendChild(row);
    return;
  }
  for (const key of keys) {
    const row = document.createElement('div');
    row.className = 'usage-row';
    const left = document.createElement('span');
    left.textContent = serviceLabel(key);
    const right = document.createElement('span');
    right.textContent = fmtUsage(data[key]);
    row.append(left, right);
    el.appendChild(row);
  }
}

async function refreshUsage() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'itr:getUsage' });
    if (res && res.ok) {
      renderUsageRows($('usageToday'), res.today);
      renderUsageRows($('usageTotal'), res.total);
    }
  } catch (e) { /* 忽略 */ }
}

async function resetUsage() {
  await chrome.runtime.sendMessage({ type: 'itr:resetUsage' });
  const el = $('usageResult');
  el.textContent = '已清空';
  el.style.color = '#16a34a';
  setTimeout(() => (el.textContent = ''), 2500);
  refreshUsage();
}

// ---------------------------------------------------------------- 高级功能

function setAdvanced(text, isError) {
  const el = $('advancedResult');
  el.textContent = text;
  el.style.color = isError ? '#ef4444' : '#16a34a';
  setTimeout(() => (el.textContent = ''), 4000);
}

function exportSettings() {
  const data = collect();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'translate-extension-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  setAdvanced('已导出设置文件');
}

function importSettings(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!data || typeof data !== 'object' || !data.to || !data.provider) {
        throw new Error('文件格式不正确');
      }
      const res = await chrome.runtime.sendMessage({ type: 'itr:saveSettings', settings: data });
      if (!res || !res.ok) throw new Error((res && res.error) || '保存失败');
      await loadSettings();
      setAdvanced('导入成功 ✓');
    } catch (e) {
      setAdvanced('导入失败：' + (e && e.message), true);
    }
  };
  reader.readAsText(file);
}

async function clearCache() {
  const res = await chrome.runtime.sendMessage({ type: 'itr:clearCache' });
  setAdvanced(res && res.ok ? '缓存已清除' : '清除失败', !(res && res.ok));
}

async function resetSettings() {
  if (!confirm('确定要恢复默认设置吗？所有配置（含 API 密钥）都会被清除。')) return;
  await chrome.storage.local.remove('itrSettings');
  const res = await chrome.runtime.sendMessage({ type: 'itr:getSettings' });
  if (res && res.ok) {
    await chrome.runtime.sendMessage({ type: 'itr:saveSettings', settings: res.settings });
    await loadSettings();
    setAdvanced('已恢复默认设置');
  }
}

// ---------------------------------------------------------------- 导航与初始化

function bindNav() {
  const links = document.querySelectorAll('.nav a');
  links.forEach((a) => {
    a.addEventListener('click', () => {
      links.forEach((x) => x.classList.remove('active'));
      a.classList.add('active');
    });
  });
}

loadSettings()
  .then(() => {
    bindNav();
    $('btnSave').addEventListener('click', save);
    $('btnTestGeneral').addEventListener('click', () => testProvider($('testGeneralResult'), null));
    $('btnTestAi').addEventListener('click', () => testProvider($('testAiResult'), 'ai', aiEditId));
    $('btnFetchModels').addEventListener('click', fetchModels);
    $('selProxyMode').addEventListener('change', updateProxyFields);
    $('btnExport').addEventListener('click', exportSettings);
    $('btnImport').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) importSettings(e.target.files[0]);
      e.target.value = '';
    });
    $('btnClearCache').addEventListener('click', clearCache);
    $('btnReset').addEventListener('click', resetSettings);
    $('btnResetUsage').addEventListener('click', resetUsage);
    $('btnReapplyProxy').addEventListener('click', async () => {
      await save();
      refreshProxyStatus();
    });
    refreshUsage();

    // AI 方案管理
    $('selAiProfile').addEventListener('change', (e) => {
      syncEditIntoProfiles();
      aiEditId = e.target.value;
      renderAiSelects();
      fillProfileForm(currentEditProfile());
    });
    $('selAiActive').addEventListener('change', async (e) => {
      aiActiveId = e.target.value;
      renderAiSelects();
      await save(); // 切换使用中的方案立即生效
    });
    $('btnAiNew').addEventListener('click', () => {
      syncEditIntoProfiles();
      const p = makeProfile('方案 ' + (aiProfiles.length + 1));
      aiProfiles.push(p);
      aiEditId = p.id;
      renderAiSelects();
      fillProfileForm(p);
      aiProfileTip('已创建新方案，填写后点击「保存设置」');
    });
    $('btnAiDelete').addEventListener('click', async () => {
      if (aiProfiles.length <= 1) {
        aiProfileTip('至少保留一个方案', true);
        return;
      }
      if (!confirm(`确定删除方案「${currentEditProfile().name}」吗？`)) return;
      aiProfiles = aiProfiles.filter((p) => p.id !== aiEditId);
      if (aiActiveId === aiEditId) aiActiveId = aiProfiles[0].id;
      aiEditId = aiActiveId;
      renderAiSelects();
      fillProfileForm(currentEditProfile());
      await save();
      aiProfileTip('已删除');
    });
  })
  .catch((e) => tip(e && e.message ? e.message : String(e), true));
