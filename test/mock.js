// 测试用 chrome API 模拟：在普通网页中运行 content.js + core.js 的完整逻辑。
// 设置暴露 window.__itrDispatch（模拟扩展向页面发消息）与 window.__itrSetSettings。

(function () {
  'use strict';

  const listeners = [];
  const storageListeners = [];
  let SETTINGS = {
    provider: 'google',
    from: 'auto',
    to: 'zh-CN',
    displayMode: 'bilingual',
    translationColor: '#ff0000',
    concurrency: 2,
    cacheEnabled: true,
    autoDetectSkip: false,
    blacklist: [],
    ai: {},
    proxy: { mode: 'system' }
  };

  window.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        }
      },
      sendMessage: async (msg) => {
        if (msg.type === 'itr:getSettings') return { ok: true, settings: SETTINGS };
        if (msg.type === 'itr:translate') {
          await new Promise((r) => setTimeout(r, 30));
          return { ok: true, results: msg.texts.map((t) => '译「' + t + '」') };
        }
        return { ok: false, error: 'mock: unknown type ' + msg.type };
      }
    },
    storage: {
      onChanged: {
        addListener(fn) {
          storageListeners.push(fn);
        }
      }
    }
  };

  // 模拟扩展（弹窗 / 后台）向页面内容脚本发送消息
  window.__itrDispatch = (msg) =>
    new Promise((resolve) => {
      let responded = false;
      for (const fn of listeners) {
        const sync = fn(msg, null, (resp) => {
          if (!responded) {
            responded = true;
            resolve(resp);
          }
        });
        if (sync !== true && !responded) {
          responded = true;
          resolve(undefined);
        }
      }
    });

  // 修改设置并模拟 chrome.storage.onChanged 通知（与真实行为一致）
  window.__itrSetSettings = (patch) => {
    SETTINGS = { ...SETTINGS, ...patch };
    const changes = { itrSettings: { newValue: SETTINGS, oldValue: SETTINGS } };
    for (const fn of storageListeners) fn(changes, 'local');
  };
  window.__itrGetSettings = () => SETTINGS;
})();
