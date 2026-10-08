// 默认设置与存储键名。设置统一存放在 chrome.storage.local 的 itrSettings 下。

export const STORAGE_KEY = 'itrSettings';

export const DEFAULT_SETTINGS = {
  // 默认翻译服务: google | ai
  provider: 'google',
  // 源语言：auto 表示自动检测
  from: 'auto',
  // 目标语言：通用代码（各服务内部再映射）
  to: 'zh-CN',
  // 显示模式：bilingual 双语对照 | replace 译文替换
  displayMode: 'bilingual',
  // 双语模式下译文颜色
  translationColor: '#3b82f6',
  // 是否启用翻译缓存
  cacheEnabled: true,
  // 基础翻译服务的并发请求数
  concurrency: 3,
  // 页面语言与目标语言相同时自动跳过
  autoDetectSkip: true,
  // 站点黑名单（不启用翻译的域名），如 ['mail.example.com', 'example.org']
  blacklist: [],
  // 自动翻译站点名单：勾选"自动翻译此站点"后记录域名，打开该站页面时自动翻译
  autoTranslateSites: [],
  // 是否在右键菜单中显示翻译选项
  contextMenu: true,
  // AI 翻译（OpenAI 兼容 / Claude 兼容接口）配置
  ai: {
    // 当前使用的方案 id（翻译时生效；插件不会在方案间自动切换）
    activeId: '',
    // 多套 API 方案：{ id, name, baseUrl, apiKey, model, apiFormat, temperature, prompt }
    profiles: [],
    // 翻译风格：general 通用 | academic 学术 | tech 计算机技术（追加到系统提示词）
    style: 'general',
    concurrency: 3
  },
  // 代理设置：mode = system 使用系统/浏览器默认 | direct 强制直连 | custom 自定义代理
  proxy: {
    mode: 'system',
    protocol: 'http', // http | https | socks5
    host: '',
    port: '',
    // custom 生效范围：all 全局 | apiOnly 仅翻译相关 API
    scope: 'apiOnly'
  }
};
