// 内容脚本：桥接 chrome 消息与 ITRCore，并负责页面右下角的翻译进度徽章。
// 徽章使用 Shadow DOM 隔离样式；全部用 DOM API 构建，兼容启用
// Trusted Types（require-trusted-types-for）的严格 CSP 站点（如 GitHub）。
// 配合 manifest 的 all_frames 注入，iframe 内文档同样可翻译。

(() => {
  'use strict';

  if (window.__itrInjected) return;
  window.__itrInjected = true;

  const core = ITRCore.create();
  let cachedSettings = null;
  let lastRun = null; // { settings, hooks }，供“重试失败”复用
  let rescanTimer = null;

  // ---------------------------------------------------------------- 徽章 UI（TT 安全：纯 DOM API）

  function createBadge() {
    const host = document.createElement('div');
    host.className = 'itr-tb-host';
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
      .wrap {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      }
      .badge {
        display: none; align-items: center; gap: 8px;
        padding: 8px 14px; border-radius: 999px;
        background: rgba(17, 24, 39, .92); color: #f9fafb;
        font-size: 13px; line-height: 1; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.25);
        user-select: none;
      }
      .badge.show { display: inline-flex; }
      .badge.error { background: rgba(153, 27, 27, .95); }
      .spinner {
        width: 12px; height: 12px; border-radius: 50%;
        border: 2px solid rgba(255,255,255,.25); border-top-color: #fff;
        animation: spin .8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .panel {
        display: none; width: 300px; padding: 12px; border-radius: 10px;
        background: rgba(17, 24, 39, .96); color: #e5e7eb; font-size: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,.3);
      }
      .panel.show { display: block; }
      .panel .title { font-weight: 600; color: #fff; margin-bottom: 8px; }
      .panel .errors { max-height: 130px; overflow: auto; margin-bottom: 8px; border-top: 1px solid rgba(255,255,255,.12); padding-top: 6px; }
      .panel .errors div { padding: 2px 0; color: #fca5a5; word-break: break-all; }
      .panel .row { display: flex; gap: 6px; }
      .panel button {
        flex: 1; padding: 6px 0; border: none; border-radius: 6px;
        background: rgba(255,255,255,.14); color: #fff; font-size: 12px; cursor: pointer;
      }
      .panel button:hover { background: rgba(255,255,255,.24); }
      .hidden { display: none !important; }
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '翻译详情';
    const errorsBox = document.createElement('div');
    errorsBox.className = 'errors';
    const row = document.createElement('div');
    row.className = 'row';
    const btnRetry = document.createElement('button');
    btnRetry.className = 'retry';
    btnRetry.textContent = '重试失败';
    const btnRestore = document.createElement('button');
    btnRestore.className = 'restore';
    btnRestore.textContent = '恢复原文';
    const btnClose = document.createElement('button');
    btnClose.className = 'close';
    btnClose.textContent = '关闭';
    row.append(btnRetry, btnRestore, btnClose);
    panel.append(title, errorsBox, row);

    const badge = document.createElement('div');
    badge.className = 'badge';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const txt = document.createElement('span');
    txt.className = 'txt';
    badge.append(spinner, txt);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.append(panel, badge);
    shadow.append(style, wrap);

    const errors = [];
    let fadeTimer = null;

    function showBadge(cls, text, withSpinner) {
      clearTimeout(fadeTimer);
      badge.className = 'badge show' + (cls ? ' ' + cls : '');
      spinner.style.display = withSpinner ? '' : 'none';
      txt.textContent = text;
    }

    function pushError(msg) {
      if (errors.length < 6) errors.push(msg);
      errorsBox.replaceChildren();
      errors.forEach((m) => {
        const div = document.createElement('div');
        div.textContent = '· ' + m;
        errorsBox.appendChild(div);
      });
    }

    badge.addEventListener('click', () => panel.classList.toggle('show'));
    btnClose.addEventListener('click', () => panel.classList.remove('show'));
    btnRestore.addEventListener('click', () => {
      panel.classList.remove('show');
      restorePage();
    });
    btnRetry.addEventListener('click', () => {
      panel.classList.remove('show');
      retryPage();
    });

    return {
      start() {
        errors.length = 0;
        errorsBox.replaceChildren();
        panel.classList.remove('show');
        showBadge('', '准备翻译…', true);
      },
      progress(done, total) { showBadge('', `翻译中 ${done}/${total}`, true); },
      notice(msg) { showBadge('', msg, false); setTimeout(hide, 3500); },
      onError(msg) { pushError(msg); showBadge('error', '部分失败，点击查看', false); },
      finish(total, failed, aborted) {
        if (aborted) return; // onAborted 已提示
        if (failed > 0) showBadge('error', `已翻译，${failed} 块失败，点击查看`, false);
        else {
          showBadge('', `✓ 已翻译 ${total} 块`, false);
          fadeTimer = setTimeout(hide, 3000);
        }
      },
      hide() { panel.classList.remove('show'); badge.className = 'badge'; }
    };
  }

  let badge = null;
  try { badge = createBadge(); } catch (e) { badge = null; }
  const hide = () => badge && badge.hide();

  // ---------------------------------------------------------------- 页面操作

  async function getSettings() {
    const res = await chrome.runtime.sendMessage({ type: 'itr:getSettings' });
    return res && res.ok ? res.settings : null;
  }

  function hostInList(settings, key) {
    const host = location.hostname.toLowerCase();
    return (settings[key] || []).some((entry) => {
      const e = String(entry).toLowerCase().trim();
      return e && (host === e || host.endsWith('.' + e));
    });
  }

  const isBlocked = (settings) => hostInList(settings, 'blacklist');
  const isAutoSite = (settings) => hostInList(settings, 'autoTranslateSites');

  function makeHooks(settings) {
    return {
      translateFn: async (texts) => {
        const res = await chrome.runtime.sendMessage({
          type: 'itr:translate',
          texts,
          from: settings.from,
          to: settings.to,
          provider: settings.provider
        });
        if (!res || !res.ok) throw new Error((res && res.error) || '翻译服务暂时不可用');
        // 后台部分块失败时：文本回退为原文返回，这里登记为失败以便重试
        if (res.failedTexts && res.failedTexts.length) {
          for (const text of res.failedTexts) {
            if (!core.state.failedTexts.includes(text)) core.state.failedTexts.push(text);
          }
          if (res.error) {
            core.state.lastError = res.error;
            badge && badge.onError(res.error);
          }
        }
        return res.results;
      },
      onProgress: (done, total) => badge && badge.progress(done, total),
      onError: (msg) => badge && badge.onError(msg),
      onNotice: (msg) => badge && badge.notice(msg),
      onAborted: () => badge && badge.notice('页面语言似乎与目标语言相同，已停止翻译')
    };
  }

  async function startPage(force) {
    if (core.state.translating) return { ok: false, error: '正在翻译中，请稍候' };
    const settings = cachedSettings || (cachedSettings = await getSettings());
    if (!settings) return { ok: false, error: '无法读取设置，请重试' };
    if (!force && isBlocked(settings)) {
      return { ok: false, blocked: true, error: '该站点已被设置为不翻译' };
    }
    badge && badge.start();
    const hooks = makeHooks(settings);
    lastRun = { settings, hooks };
    // 提前置位：core.translate 完成后据此启动动态内容监听
    core.state.enabled = true;
    const result = await core.translate(settings, hooks);
    // 翻译途中被“恢复原文”打断：restore 已复位状态并隐藏徽章，这里静默退出
    if (result && result.cancelled) return result;
    if (result && result.ok) {
      if (result.aborted) {
        // 页面语言与目标一致：复位开关，允许用户再次点击重试
        core.state.enabled = false;
        badge && badge.finish(0, 0, true);
      } else if (result.total > 0) {
        badge && badge.finish(result.applied || 0, result.failed || 0, false);
      } else {
        core.state.enabled = false;
        badge && badge.notice('没有找到可翻译的内容');
      }
    } else {
      core.state.enabled = false;
      if (result && result.error) badge && badge.onError(result.error);
    }
    return result;
  }

  async function restorePage() {
    lastRun = null;
    core.restore();
    badge && badge.hide();
    // 通知后台中止未完成的翻译请求：不再白白消耗 token 与带宽
    try {
      chrome.runtime.sendMessage({ type: 'itr:abortActive' }).catch(() => {});
    } catch (e) { /* 忽略 */ }
    return { ok: true };
  }

  async function retryPage() {
    if (!lastRun) return { ok: false, error: '没有可重试的任务' };
    if (core.state.translating) return { ok: false, error: '正在翻译中' };
    badge && badge.start();
    const result = await core.retryFailed(lastRun.settings, lastRun.hooks);
    if (result && result.ok) {
      if (result.failed > 0) badge && badge.onError('仍有部分失败');
      else badge && badge.finish(result.total, 0, false);
    }
    return result;
  }

  async function togglePage() {
    return core.state.enabled || core.state.translating ? restorePage() : startPage();
  }

  // ---------------------------------------------------------------- 点击 / 聚焦后重扫
  // 下拉菜单、popover 等通常只切换 CSS 显示（无 DOM 变更），观察器感知不到；
  // 用户点击 / 聚焦后重新收集一次“现在可见但未翻译”的单元。

  function scheduleRescan() {
    if (!core.state.enabled || core.state.translating || !lastRun) return;
    if (rescanTimer) return;
    rescanTimer = setTimeout(async () => {
      rescanTimer = null;
      if (!core.state.enabled || core.state.translating || !lastRun) return;
      try {
        await core.rescan(lastRun.settings, lastRun.hooks);
      } catch (e) { /* 静默 */ }
    }, 350);
  }
  document.addEventListener('click', scheduleRescan, true);
  document.addEventListener('focusin', scheduleRescan, true);

  // ---------------------------------------------------------------- 消息

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'itr:page') return;

    const actions = {
      getState: async () => ({
        ok: true,
        enabled: core.state.enabled,
        translating: core.state.translating,
        blocked: cachedSettings ? isBlocked(cachedSettings) : false,
        auto: cachedSettings ? isAutoSite(cachedSettings) : false,
        host: location.hostname
      }),
      start: () => startPage(msg.force),
      restore: restorePage,
      toggle: togglePage,
      // 设置变更后重译：先恢复原文再用新设置翻译
      restart: async () => {
        await restorePage();
        return startPage();
      }
    };

    const run = actions[msg.action];
    if (!run) {
      sendResponse({ ok: false, error: '未知操作' });
      return;
    }
    run()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // 异步响应
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.itrSettings) {
      cachedSettings = changes.itrSettings.newValue || null;
    }
  });

  // 预热设置；若当前站点已开启“自动翻译”，页面加载完成后自动翻译（仅顶层框架）
  getSettings()
    .then((s) => {
      cachedSettings = s;
      if (s && isAutoSite(s) && window.top === window && !isBlocked(s)) {
        setTimeout(() => {
          startPage().catch(() => {});
        }, 400);
      }
    })
    .catch(() => {});
})();
