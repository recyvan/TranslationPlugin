// 翻译服务适配层。
// 每个服务都实现同一约定：
//   translate(texts, from, to, cfg) -> Promise<string[]>
//   返回与 texts 等长的结果数组；若服务对“多行合并翻译”返回的行数无法与输入对齐，
//   则返回 null，由上层自动降级为逐条翻译，保证结果顺序永远正确。

import { langName } from '../shared/langs.js';

// ---------------------------------------------------------------- 请求取消与超时

// 活跃请求登记表：用户点击"恢复原文 / 停止"时中止所有未完成的请求，
// 避免已取消的翻译继续消耗 token 与带宽
const activeControllers = new Set();

export function abortActiveRequests() {
  for (const ctrl of activeControllers) {
    try {
      ctrl.abort();
    } catch (e) { /* 忽略 */ }
  }
  activeControllers.clear();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  activeControllers.add(ctrl);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // 超时与用户取消分别标记：超时允许重试一次，取消则立即停止
      const err = new Error(timedOut ? '请求超时' : '翻译已取消');
      err.cancelled = !timedOut;
      if (timedOut) err.retryable = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    activeControllers.delete(ctrl);
  }
}

function httpError(status, prefix) {
  let msg = `${prefix}请求失败（HTTP ${status}）`;
  if (status === 429) msg = `${prefix}请求过于频繁（HTTP 429），请稍后重试`;
  if (status === 403 || status === 401) msg = `${prefix}请求被拒绝（HTTP ${status}）`;
  const err = new Error(msg);
  err.retryable = status === 429 || status >= 500;
  return err;
}

// ---------------------------------------------------------------- Google 免费接口
// 无需密钥。使用 translate_a/single 公开端点，dj=1 返回 JSON 句子数组。
// 多条文本用 \n 合并后一次请求，翻译结果按 \n 拆开对齐。

// GET 请求的 URL 有长度限制，按编码后的长度估算；超限时二分拆分
function encodedLength(texts) {
  let n = 0;
  for (const t of texts) n += encodeURIComponent(t).length + 1;
  return n;
}

const GOOGLE_URL_LIMIT = 6000;

async function googleTranslate(texts, from, to) {
  if (texts.length > 1 && encodedLength(texts) > GOOGLE_URL_LIMIT) {
    const mid = Math.ceil(texts.length / 2);
    const [a, b] = await Promise.all([
      googleTranslate(texts.slice(0, mid), from, to),
      googleTranslate(texts.slice(mid), from, to)
    ]);
    if (!a || !b) return null;
    return [...a, ...b];
  }

  const joined = texts.join('\n');
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dj=1&dt=t' +
    `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}` +
    `&q=${encodeURIComponent(joined)}`;

  let resp;
  try {
    resp = await fetchWithTimeout(url, { method: 'GET' }, 20000);
  } catch (e) {
    if (e && (e.cancelled || e.message === '请求超时')) throw e;
    const err = new Error('谷歌翻译接口连接失败（该域名在国内需配置代理）');
    err.retryable = true;
    throw err;
  }
  if (!resp.ok) throw httpError(resp.status, '谷歌翻译接口');

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error('谷歌翻译接口返回了无法解析的内容');
  }
  const sentences = data && Array.isArray(data.sentences) ? data.sentences : null;
  if (!sentences) throw new Error('谷歌翻译接口返回格式异常');

  const out = sentences
    .map((s) => (s && typeof s.trans === 'string' ? s.trans : ''))
    .join('');

  // 单条文本直接返回，不再按行拆分
  if (texts.length === 1) return [out.trim()];

  const parts = out.split('\n');
  if (parts.length !== texts.length) return null; // 对不齐 → 上层逐条重试
  return parts.map((p) => p.trim());
}

// ---------------------------------------------------------------- 微软必应翻译（免费，无需密钥）
// 通过 Edge 浏览器翻译服务的公开端点：先从 edge.microsoft.com 获取临时令牌（约 10 分钟有效），
// 再调用 api-edge.cognitive.microsofttranslator.com。该接口原生支持文本数组，结果天然对齐。

let msAuthToken = null;
let msTokenTime = 0;
let msAuthBrokenUntil = 0; // 鉴权 404 后短期熔断，直接走备用服务

async function getMicrosoftToken() {
  if (msAuthToken && Date.now() - msTokenTime < 8 * 60 * 1000) return msAuthToken;
  if (Date.now() < msAuthBrokenUntil) {
    throw new Error('必应翻译鉴权失败（HTTP 404）：微软域名直连常命中国内节点，插件将自动改用谷歌翻译');
  }
  let resp;
  try {
    resp = await fetchWithTimeout('https://edge.microsoft.com/translate/auth', { method: 'GET' }, 15000);
  } catch (e) {
    if (e && (e.cancelled || e.message === '请求超时')) throw e;
    const err = new Error('必应翻译鉴权连接失败（该域名在国内需配置代理）');
    err.retryable = true;
    throw err;
  }
  if (!resp.ok) {
    if (resp.status === 404) {
      // 微软域名直连时可能命中国内 CDN 节点，该节点不提供此路径；短期熔断
      msAuthBrokenUntil = Date.now() + 5 * 60 * 1000;
      throw new Error('必应翻译鉴权失败（HTTP 404）：微软域名直连常命中国内节点，插件将自动改用谷歌翻译');
    }
    throw httpError(resp.status, '必应翻译鉴权');
  }
  const token = (await resp.text()).trim();
  if (!token || token.length < 20) throw new Error('必应翻译鉴权失败：未获取到有效令牌');
  msAuthToken = token;
  msTokenTime = Date.now();
  return token;
}

async function microsoftTranslate(texts, from, to) {
  const token = await getMicrosoftToken();
  const url =
    'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0' +
    (from && from !== 'auto' ? `&from=${encodeURIComponent(from)}` : '') +
    `&to=${encodeURIComponent(to)}`;

  let resp;
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(texts.map((t) => ({ Text: t })))
      },
      20000
    );
  } catch (e) {
    if (e && (e.cancelled || e.message === '请求超时')) throw e;
    const err = new Error('必应翻译接口连接失败（该域名在国内需配置代理）');
    err.retryable = true;
    throw err;
  }
  if (!resp.ok) {
    if (resp.status === 401) {
      // 令牌过期：作废缓存，下次请求重新获取
      msAuthToken = null;
      const err = new Error('必应翻译令牌过期，请重试');
      err.retryable = true;
      throw err;
    }
    throw httpError(resp.status, '必应翻译接口');
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error('必应翻译接口返回了无法解析的内容');
  }
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error('必应翻译接口返回格式异常');
  }
  return data.map(
    (item) =>
      (item && item.translations && item.translations[0] && item.translations[0].text) || ''
  );
}

// ---------------------------------------------------------------- AI 翻译（OpenAI 兼容 + Claude 兼容）

// 面向网页翻译调优的默认提示词：{to}/{from} 会被替换为目标/源语言名称
const DEFAULT_AI_PROMPT = [
  '你是内嵌在浏览器翻译扩展中的专业翻译引擎，负责把用户提供的网页文本翻译成{to}。',
  '翻译规则：',
  '1. 只输出译文本身：不要解释、不要备注、不要添加引号或前后缀。',
  '2. 代码、命令、URL、邮箱、文件路径、变量名、HTML 标签、占位符（如 {0}、%s）保持原样，不要翻译。',
  '3. 品牌名、产品名、人名保留原文；若在{to}中有通用译名则使用译名。',
  '4. 译文要自然、地道、符合{to}的表达习惯；界面按钮、菜单等 UI 文案保持简洁；正文保持原文语气。',
  '5. 不遗漏、不增删任何内容；保留原文的换行与段落结构。',
  '6. 源语言：{from}。若文本本身就是{to}，原样输出即可。'
].join('\n');

// 可选翻译风格（设置中选择，追加在系统提示词之后）
const AI_STYLE_DIRECTIVES = {
  general: '',
  academic:
    '翻译风格要求：面向学术论文与文献翻译。专业术语遵循对应学科的规范译法，' +
    '首次出现的关键术语可在译文后用括号保留英文原文；句式严谨书面，避免口语化表达；' +
    '逻辑连接词要显化（如“因此”“然而”“换言之”），长句可按{to}学术习惯拆分重组，但不得丢失信息。',
  tech:
    '翻译风格要求：面向计算机与软件技术文档。技术术语采用业界通用译法' +
    '（如 cache→缓存、hash→哈希、repository→仓库），没有通行译名的术语保留英文；' +
    '代码、命令、API 名称、配置项、文件名、报错信息一律保留原文不译；' +
    '语句简洁直接、指向明确，避免冗余修饰；操作步骤保持原有编号与顺序。'
};

const AI_BATCH_INSTRUCTION = [
  '请把下面的 {count} 行分别翻译成{to}。',
  '要求：输出恰好 {count} 行，每行格式为“行号. 译文”，行号与输入一一对应；',
  '不要合并行、不要增删行、不要调整顺序，除了“行号. 译文”外不要输出任何其他内容。'
].join(' ');

// AI token 用量统计：优先使用接口返回的真实 usage，缺失时按字符数粗略估算。
// 并发请求会把用量累加到这里，由后台在每个翻译任务结束后取走（takeAiTokens）。
let aiTokenAccumulator = 0;

export function takeAiTokens() {
  const value = aiTokenAccumulator;
  aiTokenAccumulator = 0;
  return value;
}

function estimateTokens(text) {
  // 中文字符约 1 字/token，英文约 4 字符/token，取折中估算
  const cjk = (text.match(/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function recordAiUsage(data, promptText, completionText) {
  if (data && data.usage) {
    if (Number.isFinite(data.usage.prompt_tokens)) {
      aiTokenAccumulator += (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      return;
    }
    if (Number.isFinite(data.usage.input_tokens)) {
      // Claude 格式的 usage 字段
      aiTokenAccumulator += (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0);
      return;
    }
  }
  aiTokenAccumulator += estimateTokens(promptText) + estimateTokens(completionText);
}

function normalizeBaseUrl(baseUrl, apiFormat) {
  let b = String(baseUrl || '').trim();
  if (!b) throw new Error('未配置 AI 接口地址');
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  b = b.replace(/\/+$/, '');
  if (apiFormat === 'claude') {
    if (/\/v1\/messages$/.test(b)) return b;
    if (/\/v1$/.test(b)) return b + '/messages';
    return b + '/v1/messages';
  }
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

function parseNumberedLines(content, count) {
  // 去掉可能的 markdown 代码围栏
  const fenced = content.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : content;
  const map = new Map();
  // 容忍 “**1.**” “1、” “1)” 等常见输出格式
  const re = /^\s*\**\s*(\d{1,3})\s*\**\s*[.、．:：)]\s?(.*)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const idx = parseInt(m[1], 10);
    if (idx >= 1 && idx <= count && !map.has(idx)) map.set(idx, m[2].replace(/\**\s*$/, '').trim());
  }
  return map;
}

async function aiTranslate(texts, from, to, cfg) {
  if (!cfg || !cfg.apiKey) throw new Error('尚未配置 AI 服务的 API Key');
  if (!cfg.model) throw new Error('尚未配置 AI 模型名称');

  const toName = to || '简体中文';
  const fromName = from && from !== 'auto' ? langName(from) || from : '自动检测的源语言';
  const style = cfg.style && AI_STYLE_DIRECTIVES[cfg.style] ? cfg.style : 'general';
  const systemPrompt =
    (cfg.prompt || DEFAULT_AI_PROMPT)
      .replaceAll('{to}', toName)
      .replaceAll('{from}', fromName) +
    (style === 'general' ? '' : '\n' + AI_STYLE_DIRECTIVES[style].replaceAll('{to}', toName));
  const multi = texts.length > 1;

  const userContent = multi
    ? AI_BATCH_INSTRUCTION.replaceAll('{count}', String(texts.length)).replaceAll('{to}', toName) +
      `\n\n` +
      texts.map((t, i) => `${i + 1}. ${t.replace(/\s*\n\s*/g, ' ')}`).join('\n')
    : `请把下面的文本翻译成${toName}，只输出译文：\n\n${texts[0]}`;

  const isClaude = cfg.apiFormat === 'claude';
  const endpoint = normalizeBaseUrl(cfg.baseUrl, cfg.apiFormat);

  let resp;
  try {
    resp = await fetchWithTimeout(
      endpoint,
      buildAiRequest(isClaude, cfg, systemPrompt, userContent),
      60000
    );
  } catch (e) {
    if (e && (e.cancelled || e.message === '请求超时')) throw e;
    const err = new Error(`AI 接口连接失败（${endpoint}）`);
    err.retryable = true;
    throw err;
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = (j.error && (j.error.message || j.error.type)) || j.message || '';
    } catch (e) { /* 忽略响应体解析失败 */ }
    let msg = `AI 接口错误（HTTP ${resp.status}）`;
    if (resp.status === 401) msg = 'AI 接口鉴权失败：API Key 无效（HTTP 401）';
    if (resp.status === 404) {
      msg =
        cfg.apiFormat === 'claude'
          ? 'AI 接口地址不存在（HTTP 404），Claude 格式的地址通常应填 https://api.anthropic.com'
          : 'AI 接口地址或模型不存在（HTTP 404），请检查 Base URL 是否需要以 /v1 结尾';
    }
    if (resp.status === 429) msg = 'AI 接口请求过于频繁或额度不足（HTTP 429）';
    if (detail) msg += `：${detail}`;
    const err = new Error(msg);
    err.retryable = resp.status === 429 || resp.status >= 500;
    throw err;
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error('AI 接口返回了无法解析的内容');
  }

  let content = '';
  if (isClaude) {
    // Claude Messages API：content 为分块文本数组
    if (Array.isArray(data && data.content)) {
      content = data.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
    }
  } else if (
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    typeof data.choices[0].message.content === 'string'
  ) {
    content = data.choices[0].message.content;
  }
  if (!content.trim()) throw new Error('AI 接口返回了空内容');
  recordAiUsage(data, userContent, content);

  if (texts.length === 1) {
    // 单条：整个回复即译文（去掉可能的引号包裹）
    return [content.trim().replace(/^["“](.*)["”]$/s, '$1').trim()];
  }

  const map = parseNumberedLines(content, texts.length);
  if (map.size < texts.length) return null; // 行数不齐 → 上层逐条重试
  return texts.map((_, i) => map.get(i + 1) || '');
}

function buildAiRequest(isClaude, cfg, systemPrompt, userContent) {
  if (isClaude) {
    // Claude Messages API：max_tokens 必填；推理模型不支持 temperature
    const body = {
      model: cfg.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    };
    if (!/reasoner|thinking|r1|o1|o3|o4/i.test(cfg.model)) {
      body.temperature = Number.isFinite(cfg.temperature) ? cfg.temperature : 0.2;
    }
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    };
  }
  const body = {
    model: cfg.model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ]
  };
  if (!/reasoner|thinking|r1|o1|o3|o4/i.test(cfg.model)) {
    body.temperature = Number.isFinite(cfg.temperature) ? cfg.temperature : 0.2;
  }
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify(body)
  };
}

// ---------------------------------------------------------------- 服务注册表

export const PROVIDERS = {
  google: {
    label: '谷歌翻译（免费接口）',
    needsConfig: false,
    translate: googleTranslate
  },
  microsoft: {
    label: '必应翻译（免费，无需密钥）',
    needsConfig: false,
    translate: microsoftTranslate
  },
  ai: {
    label: 'AI 翻译（自定义）',
    needsConfig: true,
    configHint: '需要填写接口地址、API Key 和模型',
    translate: aiTranslate
  }
};

export function getProvider(name) {
  return PROVIDERS[name] || null;
}

// 每个服务的单次请求体积上限。
// google 按 URL 编码后长度控制；microsoft 用 JSON 数组（单条上限 10k 字符，保守控制）；
// ai 按字符与行数控制，避免超出上下文或输出截断。
export const CHUNK_LIMITS = {
  google: { chars: 1500, lines: 50 },
  microsoft: { chars: 2000, lines: 40 },
  ai: { chars: 2800, lines: 36 }
};
