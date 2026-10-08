// 代理管理：把用户的代理设置应用到浏览器（chrome.proxy API）。
// 四种模式：
//   system  —— 不干预，使用浏览器/系统默认代理（默认）
//   direct  —— 强制直连
//   custom  + scope=all      —— 全局固定服务器代理（HTTP/HTTPS/SOCKS5）
//   custom  + scope=apiOnly  —— PAC 脚本：仅翻译相关 API 域名走代理，其余直连
// 注意：该设置作用于整个浏览器；扩展更新或浏览器重启后会自动重新应用。

import { aiProfileBaseUrls } from '../shared/settings.js';

const API_HOSTS = [
  'translate.googleapis.com',
  'edge.microsoft.com',
  'api-edge.cognitive.microsofttranslator.com'
];

function proxyRuleString(protocol, host, port) {
  if (protocol === 'socks5') return `SOCKS5 ${host}:${port}`;
  if (protocol === 'https') return `HTTPS ${host}:${port}`;
  return `PROXY ${host}:${port}`;
}

// 从 AI 接口地址提取主机名，一并纳入"仅翻译 API"代理范围
function aiHost(baseUrl) {
  try {
    let b = String(baseUrl || '').trim();
    if (!b) return '';
    if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
    return new URL(b).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

// 导出供开发脚本（tools/check.js）做 PAC 语法校验
export function buildPacScript(settings, proxyStr) {
  const hosts = new Set(API_HOSTS);
  // 把所有已配置的 AI 方案地址都纳入代理范围。
  // 此前这里读取的是已被多方案重构移除的 settings.ai.baseUrl，
  // 导致自定义 AI 接口从未进入 PAC 脚本，走代理时该方案请求会直连失败。
  for (const baseUrl of aiProfileBaseUrls(settings)) {
    const host = aiHost(baseUrl);
    if (host) hosts.add(host);
  }

  const entries = [...hosts].map((h) => `"${h}":1`).join(',');
  // 单引号转义，防止主机名破坏脚本（主机名本身不含引号，防御性处理）
  const safeProxy = proxyStr.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return `
function FindProxyForURL(url, host) {
  var d = {${entries}};
  var h = (host || '').toLowerCase();
  var parts = h.split('.');
  for (var i = 0; i < parts.length - 1; i++) {
    if (d[parts.slice(i).join('.')] === 1) return '${safeProxy}';
  }
  return 'DIRECT';
}`;
}

async function clearProxy() {
  try {
    await chrome.proxy.settings.clear({ scope: 'regular' });
  } catch (e) {
    // chrome.proxy 不可用时静默（例如浏览器不支持）
  }
}

// 这些 levelOfControl 状态下本插件无法修改代理：
// controlled_by_other_extensions —— 被其他代理扩展占用（SwitchyOmega、Clash 扩展等）
// not_controllable               —— 被系统策略锁定
const CONFLICT_LEVELS = ['controlled_by_other_extensions', 'not_controllable'];

export async function applyProxy(settings) {
  if (!chrome.proxy || !chrome.proxy.settings) {
    return { ok: false, unsupported: true };
  }

  const p = (settings && settings.proxy) || { mode: 'system' };

  try {
    // 应用前检查代理控制权，避免与其他代理扩展冲突（写入会直接抛错）
    const detail = await chrome.proxy.settings.get({ scope: 'regular' });
    const level = detail && detail.levelOfControl;
    if (p.mode !== 'system' && CONFLICT_LEVELS.includes(level)) {
      return { ok: false, conflict: true, level };
    }

    if (p.mode === 'direct') {
      await chrome.proxy.settings.set({
        value: { mode: 'direct' },
        scope: 'regular'
      });
      return { ok: true };
    }

    if (p.mode !== 'custom' || !p.host || !p.port) {
      await clearProxy();
      return { ok: true };
    }

    const port = parseInt(p.port, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      await clearProxy();
      return { ok: true };
    }

    const proxyStr = proxyRuleString(p.protocol, p.host, port);

    if (p.scope === 'apiOnly') {
      await chrome.proxy.settings.set({
        value: {
          mode: 'pac_script',
          pacScript: { data: buildPacScript(settings, proxyStr), mandatory: true }
        },
        scope: 'regular'
      });
      return { ok: true };
    }

    // 全局固定服务器代理
    const scheme = p.protocol === 'socks5' ? 'socks5' : p.protocol === 'https' ? 'https' : 'http';
    const server = { scheme, host: p.host, port };
    await chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          proxyForHttp: [server],
          proxyForHttps: [server],
          bypassList: ['localhost', '127.0.0.1', '<local>']
        }
      },
      scope: 'regular'
    });
    return { ok: true };
  } catch (e) {
    // 其他扩展在写入瞬间抢占控制权等情况
    return { ok: false, error: (e && e.message) || String(e), conflict: true };
  }
}

// 把 chrome.proxy 当前生效值转成可读描述
function describeProxyValue(value) {
  if (!value || value.mode === 'system' || !value.mode) return '浏览器默认';
  if (value.mode === 'direct') return '强制直连';
  if (value.mode === 'pac_script') return 'PAC（仅翻译 API 走代理）';
  if (value.mode === 'fixed_servers') {
    const s = value.rules && (value.rules.proxyForHttps || value.rules.proxyForHttp || [])[0];
    return s ? `全局 ${s.scheme}://${s.host}:${s.port}` : '全局代理';
  }
  return value.mode;
}

// 供设置页展示：当前实际生效的代理 + 冲突警告
export async function getProxyStatus() {
  if (!chrome.proxy || !chrome.proxy.settings) {
    return { ok: true, level: 'not_controllable', value: null, current: '浏览器默认（浏览器不支持代理 API）', warning: '' };
  }
  try {
    const detail = await chrome.proxy.settings.get({ scope: 'regular' });
    const level = detail ? detail.levelOfControl : '';
    let warning = '';
    if (level === 'controlled_by_other_extensions') {
      warning =
        '检测到其他代理扩展正在控制浏览器代理（如 SwitchyOmega、Clash/油猴类扩展）。' +
        '同一时刻只允许一个扩展控制代理，本插件的代理设置不会生效。' +
        '请在那个扩展里为翻译 API 配置规则，或暂时停用它后再保存本插件的代理设置。';
    } else if (level === 'not_controllable') {
      warning = '浏览器代理由企业策略/系统策略控制，本插件无法修改代理设置。';
    }
    return {
      ok: true,
      level,
      value: detail ? detail.value : null,
      current: describeProxyValue(detail ? detail.value : null),
      warning
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), current: '', warning: '' };
  }
}
