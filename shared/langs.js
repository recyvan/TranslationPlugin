// 支持的目标语言列表，以及各翻译服务的语言代码映射。
// background（service worker）与弹窗、设置页均以 ES Module 方式引入。

export const LANGS = [
  { code: 'zh-CN', name: '简体中文', google: 'zh-CN', microsoft: 'zh-Hans', ai: '简体中文' },
  { code: 'zh-TW', name: '繁體中文', google: 'zh-TW', microsoft: 'zh-Hant', ai: '繁体中文' },
  { code: 'en', name: 'English', google: 'en', microsoft: 'en', ai: '英语' },
  { code: 'ja', name: '日本語', google: 'ja', microsoft: 'ja', ai: '日语' },
  { code: 'ko', name: '한국어', google: 'ko', microsoft: 'ko', ai: '韩语' },
  { code: 'fr', name: 'Français', google: 'fr', microsoft: 'fr', ai: '法语' },
  { code: 'de', name: 'Deutsch', google: 'de', microsoft: 'de', ai: '德语' },
  { code: 'es', name: 'Español', google: 'es', microsoft: 'es', ai: '西班牙语' },
  { code: 'ru', name: 'Русский', google: 'ru', microsoft: 'ru', ai: '俄语' },
  { code: 'pt', name: 'Português', google: 'pt', microsoft: 'pt', ai: '葡萄牙语' },
  { code: 'it', name: 'Italiano', google: 'it', microsoft: 'it', ai: '意大利语' },
  { code: 'ar', name: 'العربية', google: 'ar', microsoft: 'ar', ai: '阿拉伯语' },
  { code: 'th', name: 'ไทย', google: 'th', microsoft: 'th', ai: '泰语' },
  { code: 'vi', name: 'Tiếng Việt', google: 'vi', microsoft: 'vi', ai: '越南语' }
];

export const SOURCE_LANGS = [
  { code: 'auto', name: '自动检测' },
  ...LANGS.map((l) => ({ code: l.code, name: l.name }))
];

export function langName(code) {
  const found = LANGS.find((l) => l.code === code);
  return found ? found.name : code;
}

// 把通用语言代码转换为具体服务所需的代码；AI 服务返回语言中文名称（用于提示词）。
export function providerLang(provider, code) {
  const lang = LANGS.find((l) => l.code === code);
  if (provider === 'ai') return (lang && lang.ai) || code;
  return (lang && (lang[provider] || lang.google)) || code;
}
