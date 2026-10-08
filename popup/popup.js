// 弹窗逻辑：状态展示、整页翻译开关、快捷设置与快速翻译。
// 使用逻辑：
//   - 主按钮随页面状态变化：翻译此页 → 停止翻译 → 恢复原文
//   - 页面已翻译时修改语言/模式/服务，自动用新设置重译当前页
//   - 当前服务未配置完整时给出提醒，避免无效请求
//   - 勾选“不翻译此站点”时立即恢复原文

import { LANGS, SOURCE_LANGS } from '../shared/langs.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let currentTab = null;
let pageState = null; // 内容脚本回报的状态

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

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (isError ? ' err' : '');
}

function providerConfigured(p) {
  if (!settings) return true;
  if (p === 'ai') {
    const profile = resolveActiveProfile();
    return !!(profile && profile.baseUrl && profile.apiKey && profile.model);
  }
  return true;
}

// 当前使用的 AI 方案（activeId 指向；多方案由用户手动切换，不自动选择）
function resolveActiveProfile() {
  if (!settings || !settings.ai) return null;
  const profiles = settings.ai.profiles || [];
  return profiles.find((p) => p.id === settings.ai.activeId) || profiles[0] || null;
}

function updateAiProfileRow() {
  const row = $('rowAiProfile');
  const sel = $('selAiProfile');
  if (!settings || settings.provider !== 'ai' || !(settings.ai.profiles || []).length) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  sel.innerHTML = '';
  for (const p of settings.ai.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || '未命名方案';
    sel.appendChild(opt);
  }
  sel.value = settings.ai.activeId;
}

function updateProviderHint() {
  const hint = $('providerHint');
  if (settings && !providerConfigured(settings.provider)) {
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
  updateAiProfileRow();
}

function updateButton() {
  const btn = $('btnTranslate');
  if (!pageState) {
    btn.disabled = true;
    btn.textContent = '翻译此页';
    setStatus('此页面不支持翻译', true);
    updateProviderHint();
    return;
  }
  btn.disabled = false;
  if (pageState.translating) {
    btn.textContent = '停止翻译';
    setStatus('翻译中…点击按钮可停止');
  } else if (pageState.enabled) {
    btn.textContent = '恢复原文';
    setStatus('页面已翻译');
  } else {
    btn.textContent = '翻译此页';
    setStatus('未翻译');
  }
  updateProviderHint();
}

async function loadPageState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  const hostInfo = $('hostInfo');
  if (tab && tab.url && /^https?:/i.test(tab.url)) {
    hostInfo.textContent = new URL(tab.url).hostname;
  } else {
    hostInfo.textContent = '不支持当前页面';
  }

  try {
    pageState = await chrome.tabs.sendMessage(tab.id, { type: 'itr:page', action: 'getState' });
  } catch (e) {
    pageState = null;
  }
  updateButton();

  // 站点黑名单 / 自动翻译勾选状态
  const host = pageState && pageState.host ? pageState.host : '';
  $('blockRow').style.display = host ? '' : 'none';
  $('autoRow').style.display = host ? '' : 'none';
  if (host && settings) {
    const inList = (key) =>
      (settings[key] || []).some((e) => host === e || host.endsWith('.' + e));
    $('chkBlock').checked = inList('blacklist');
    $('chkAuto').checked = inList('autoTranslateSites');
  }
}

async function saveSettingsPartial(partial) {
  const res = await chrome.runtime.sendMessage({ type: 'itr:saveSettings', settings: partial });
  if (res && res.ok) settings = res.settings;
  return res && res.ok;
}

// 页面处于已翻译状态时，设置变更后自动用新设置重译
async function onQuickSettingChanged(partial) {
  const ok = await saveSettingsPartial(partial);
  if (!ok) {
    setStatus('保存设置失败', true);
    return;
  }
  updateProviderHint();

  if (pageState && pageState.enabled && !pageState.translating && currentTab && currentTab.id) {
    if (!providerConfigured(settings.provider)) {
      setStatus('当前服务未配置，请先到设置中完善', true);
      return;
    }
    try {
      await chrome.tabs.sendMessage(currentTab.id, { type: 'itr:page', action: 'restart' });
    } catch (e) { /* 页面可能已跳转 */ }
  }
  setTimeout(loadPageState, 500);
}

function bindSettingsControls() {
  $('selTo').addEventListener('change', (e) => onQuickSettingChanged({ to: e.target.value }));
  $('selFrom').addEventListener('change', (e) => onQuickSettingChanged({ from: e.target.value }));
  $('selMode').addEventListener('change', (e) => onQuickSettingChanged({ displayMode: e.target.value }));
  $('selProvider').addEventListener('change', (e) => onQuickSettingChanged({ provider: e.target.value }));

  // AI 方案快速切换（手动选择，立即保存生效；不自动切换）
  $('selAiProfile').addEventListener('change', async (e) => {
    const ok = await saveSettingsPartial({ ai: { activeId: e.target.value } });
    if (ok) {
      updateProviderHint();
      setStatus('已切换 AI 方案：' + (resolveActiveProfile() || {}).name);
      if (pageState && pageState.enabled && !pageState.translating && currentTab && currentTab.id) {
        try {
          await chrome.tabs.sendMessage(currentTab.id, { type: 'itr:page', action: 'restart' });
        } catch (err) { /* 页面可能已跳转 */ }
      }
      setTimeout(loadPageState, 500);
    }
  });

  const toggleSiteList = async (key, checked, okText, offText) => {
    if (!pageState || !pageState.host) return;
    const host = pageState.host;
    const list = new Set(settings[key] || []);
    if (checked) list.add(host);
    else list.delete(host);
    await saveSettingsPartial({ [key]: [...list] });
    setStatus(checked ? okText : offText);
    setTimeout(loadPageState, 300);
  };

  $('chkBlock').addEventListener('change', async (e) => {
    await toggleSiteList('blacklist', e.target.checked, '已加入不翻译名单', '已移出不翻译名单');
    // 加入黑名单时立即恢复原文，让设置即刻生效
    if (e.target.checked && pageState.enabled && currentTab && currentTab.id) {
      try {
        await chrome.tabs.sendMessage(currentTab.id, { type: 'itr:page', action: 'restore' });
      } catch (err) { /* 忽略 */ }
    }
  });

  $('chkAuto').addEventListener('change', (e) => {
    toggleSiteList(
      'autoTranslateSites',
      e.target.checked,
      '已开启：打开此站点自动翻译',
      '已关闭自动翻译'
    );
  });

  const openOptions = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
  $('lnkOptions').addEventListener('click', openOptions);
  $('lnkGoOptions').addEventListener('click', openOptions);
}

function bindTranslateButton() {
  $('btnTranslate').addEventListener('click', async () => {
    if (!currentTab || !currentTab.id) return;
    const btn = $('btnTranslate');
    btn.disabled = true;
    // 翻译中点击 = 停止（恢复原文）；已翻译点击 = 恢复原文；否则开始翻译
    const action =
      pageState && (pageState.translating || pageState.enabled) ? 'restore' : 'start';
    try {
      const res = await chrome.tabs.sendMessage(currentTab.id, {
        type: 'itr:page',
        action
      });
      if (!res || !res.ok) {
        setStatus((res && res.error) || '操作失败', true);
        if (res && res.blocked) $('chkBlock').checked = true;
      }
    } catch (e) {
      setStatus('无法连接页面，请刷新后重试', true);
    }
    // 稍等内容脚本更新状态后刷新展示
    setTimeout(loadPageState, 400);
    setTimeout(loadPageState, 1500);
  });
}

function bindQuickTranslate() {
  const input = $('quickInput');
  const result = $('quickResult');
  const run = async () => {
    const text = input.value.trim();
    if (!text) return;
    result.hidden = false;
    result.textContent = '翻译中…';
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'itr:translate',
        texts: [text],
        from: settings ? settings.from : 'auto',
        to: settings ? settings.to : 'zh-CN'
      });
      if (res && res.ok) {
        result.textContent = res.results[0] || '（无结果）';
      } else {
        result.textContent = '翻译失败：' + ((res && res.error) || '未知错误');
      }
    } catch (e) {
      result.textContent = '翻译失败：' + (e && e.message);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  });
}

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'itr:getSettings' });
  settings = res && res.ok ? res.settings : null;
  if (!settings) {
    setStatus('读取设置失败', true);
    return;
  }

  fillSelect($('selTo'), LANGS, settings.to);
  fillSelect($('selFrom'), SOURCE_LANGS, settings.from);
  $('selMode').value = settings.displayMode;
  $('selProvider').value = settings.provider;

  bindSettingsControls();
  bindTranslateButton();
  bindQuickTranslate();
  await loadPageState();
}

init().catch((e) => setStatus('初始化失败：' + (e && e.message), true));
