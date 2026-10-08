// 设置合并、迁移与 AI 方案解析。
//
// 这里全部是纯函数，不依赖任何 chrome API，因此可以被 tools/check.js 直接
// 导入做回归测试（service-worker.js 顶层依赖 chrome，无法在 Node 中导入）。
//
// 设置结构见 shared/defaults.js；存储键为 STORAGE_KEY（itrSettings）。

import { DEFAULT_SETTINGS } from './defaults.js';

// 旧版"单套 AI 配置"的特征字段：出现这些字段且没有 profiles 时，
// 说明是 1.4.0 之前保存的历史数据，需要迁移为多方案结构。
const LEGACY_AI_KEYS = ['baseUrl', 'apiKey', 'model', 'apiFormat', 'temperature', 'prompt'];

// 翻译风格取值（追加到系统提示词，见 background/providers.js 的 AI_STYLE_DIRECTIVES）
const AI_STYLES = ['general', 'academic', 'tech'];

// 深合并：把 patch 合并进 base。嵌套的普通对象递归合并，数组与标量整体替换。
//
// 必须深合并的原因：弹窗的"快速设置"只提交发生变化的字段，例如切换 AI 方案时
// 发送 { ai: { activeId } }。若按浅合并处理，整个 ai 对象会被替换掉，
// 已保存的方案（含 API Key）会全部丢失。
export function deepMerge(base, patch) {
  const out = { ...(base || {}) };
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    const cur = out[key];
    if (
      val && typeof val === 'object' && !Array.isArray(val) &&
      cur && typeof cur === 'object' && !Array.isArray(cur)
    ) {
      out[key] = deepMerge(cur, val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

// 是否为需要迁移的旧版单 AI 配置（仅有散字段、没有 profiles 数组）
function isLegacyAi(ai) {
  return (
    !!ai && typeof ai === 'object' && !Array.isArray(ai) &&
    !Array.isArray(ai.profiles) &&
    LEGACY_AI_KEYS.some((k) => k in ai)
  );
}

// 把任意来源的设置（storage 原始值 / 已合并结果）规范化成完整结构：
// 补齐缺失字段、执行历史迁移、兜底校验取值。
export function mergeDefaults(stored) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') stored = {};

  // 迁移（1）：百度翻译已移除，改用同为免费无密钥的必应翻译
  if (stored.provider === 'baidu') stored = { ...stored, provider: 'microsoft' };

  // 迁移（2）：旧版单配置 → 多方案（profiles），旧字段并入"默认方案"
  if (isLegacyAi(stored.ai)) {
    const legacy = stored.ai;
    stored = {
      ...stored,
      ai: {
        activeId: legacy.activeId || '',
        style: legacy.style,
        concurrency: legacy.concurrency,
        profiles: [
          {
            id: 'profile-legacy',
            name: '默认方案',
            baseUrl: legacy.baseUrl || '',
            apiKey: legacy.apiKey || '',
            model: legacy.model || '',
            apiFormat: legacy.apiFormat === 'claude' ? 'claude' : 'openai',
            temperature: typeof legacy.temperature === 'number' ? legacy.temperature : 0.2,
            prompt: legacy.prompt || ''
          }
        ]
      }
    };
  }

  // 一层深度的字段合并：嵌套对象（ai / proxy）按字段覆盖，数组整体替换。
  // 空值（null/undefined）与类型不符的值一律忽略：损坏或残缺的存储数据
  // 不能把默认结构覆盖成 null，否则后续读取会直接抛错。
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const key of Object.keys(stored)) {
    const val = stored[key];
    if (val === undefined || val === null) continue;
    if (isPlainObject(out[key])) {
      if (isPlainObject(val)) Object.assign(out[key], val);
      continue;
    }
    out[key] = val;
  }

  // 兜底校验：AI 方案结构、风格取值
  if (!Array.isArray(out.ai.profiles)) out.ai.profiles = [];
  out.ai.profiles = out.ai.profiles
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => ({
      id: p.id || 'profile-' + i + '-' + Date.now().toString(36),
      name: String(p.name || '方案 ' + (i + 1)).slice(0, 40),
      baseUrl: String(p.baseUrl || ''),
      apiKey: String(p.apiKey || ''),
      model: String(p.model || ''),
      apiFormat: p.apiFormat === 'claude' ? 'claude' : 'openai',
      temperature: Number.isFinite(p.temperature) ? Math.min(1, Math.max(0, p.temperature)) : 0.2,
      prompt: String(p.prompt || '')
    }));
  if (!out.ai.profiles.length) {
    out.ai.profiles.push({
      id: 'profile-default',
      name: '默认方案',
      baseUrl: '',
      apiKey: '',
      model: '',
      apiFormat: 'openai',
      temperature: 0.2,
      prompt: ''
    });
  }
  if (!out.ai.profiles.some((p) => p.id === out.ai.activeId)) {
    out.ai.activeId = out.ai.profiles[0].id;
  }
  // 校验翻译风格（general / academic / tech）。
  // 注意：这里不能用 apiFormat 的取值（openai / claude）来判断，
  // 否则学术与技术风格每次读取设置都会被重置为"通用"。
  if (!AI_STYLES.includes(out.ai.style)) out.ai.style = 'general';
  return out;
}

// 解析当前应使用的 AI 方案（不自动切换：始终使用 activeId 指向的方案）
export function resolveAiProfile(settings, profileId) {
  const profiles = (settings && settings.ai && settings.ai.profiles) || [];
  return profiles.find((p) => p.id === profileId) || profiles[0] || null;
}

// 把部分更新合并进当前设置并规范化（弹窗快速设置走这条路径）
export function applyPartial(current, partial) {
  return mergeDefaults(deepMerge(current, partial));
}

// 需要纳入"仅翻译 API"代理范围的 AI 接口地址：返回所有已配置方案的 Base URL。
//
// 之所以返回全部方案而不只是当前方案：用户可在弹窗中切换方案，
// PAC 里漏掉任何一个都会让该方案的请求走直连而失败；多包含一个主机名
// 只会让该域名也走代理，没有副作用。
export function aiProfileBaseUrls(settings) {
  const ai = (settings && settings.ai) || {};
  const profiles = Array.isArray(ai.profiles) ? ai.profiles : [];
  const urls = profiles.map((p) => (p && p.baseUrl) || '').filter(Boolean);
  // 兼容尚未迁移的旧结构
  if (!urls.length && ai.baseUrl) urls.push(ai.baseUrl);
  return urls;
}
