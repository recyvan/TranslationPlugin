// 自动化验收：在 harness.html 中运行，覆盖段落级单元翻译、跳过规则、双语显示、
// 恢复原文、替换模式、黑名单、重复段落复用、动态内容等核心行为。
// 结果写入 #log 与 document.title。

(async () => {
  'use strict';

  window.__itrDbg = {}; // 供 core.js 内的调试计数器使用（发布版无副作用）

  // 自定义元素：开放 Shadow DOM（验证 Web Components 覆盖）
  class ItrShadowCard extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) {
        const sh = this.attachShadow({ mode: 'open' });
        const p = document.createElement('p');
        p.textContent = 'Shadow dom paragraph content';
        sh.appendChild(p);
      }
    }
  }
  customElements.define('itr-shadow-card', ItrShadowCard);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const assert = (name, cond) => {
    results.push({ name, ok: !!cond });
  };
  const dispatch = (msg) => window.__itrDispatch(msg);

  try {
    await sleep(150);

    // ---- 场景 1：双语模式（段落级单元） ----
    const st0 = await dispatch({ type: 'itr:page', action: 'getState' });
    assert('getState 可用', st0 && st0.ok === true);

    const started = await dispatch({ type: 'itr:page', action: 'start' });
    assert('start 成功', started && started.ok === true);
    assert('收集到翻译单元', started && started.total > 5);
    assert('没有失败块', started && started.failed === 0);
    await sleep(150);

    const spans = document.querySelectorAll('.itr-bi');
    assert('插入了双语译文节点', spans.length > 5);

    const h1 = document.querySelector('h1');
    assert('原文保留（双语）', h1.textContent.indexOf('The quick brown fox') === 0);
    assert('标题下方出现整行译文', !!h1.querySelector('.itr-bi.itr-bi-block'));

    const li = document.querySelector('li');
    assert('列表项被翻译', !!li.querySelector('.itr-bi'));

    // 跳过规则
    assert('notranslate 区域被跳过',
      document.querySelector('.notranslate').textContent.trim() === 'NOT_TRANSLATED_MARKER' &&
      !document.querySelector('.notranslate .itr-bi'));
    assert('pre 代码块被跳过', !document.querySelector('pre .itr-bi'));
    const ta = document.querySelector('textarea');
    assert('textarea 内容未变', ta.value === 'textarea content untouched');

    // 段落级合并：含多个内联片段的段落只产生一个整段译文
    const richP = document.querySelector('p');
    const richSpans = richP.querySelectorAll('.itr-bi');
    assert('多片段段落合并为一个整段译文', richSpans.length === 1);
    assert('整段译文包含完整上下文',
      richSpans.length === 1 && richSpans[0].textContent.indexOf('译「Hello world') === 0);
    assert('段内内联原文（加粗/链接）保持不动',
      richP.querySelector('b').textContent === 'bold text' &&
      richP.querySelector('a').textContent === 'a link');

    // 相同段落只翻译一次并复用
    const dupTexts = [...document.querySelectorAll('p.dup')]
      .map((p) => p.querySelector('.itr-bi') && p.querySelector('.itr-bi').textContent);
    assert('两个相同段落各自有译文且内容一致',
      dupTexts.length === 2 && dupTexts[0] && dupTexts[0] === dupTexts[1]);

    // Shadow DOM 覆盖：自定义元素内的文本被翻译，译文插在 shadow 内
    const card = document.querySelector('itr-shadow-card');
    const shadowSpan = card && card.shadowRoot && card.shadowRoot.querySelector('.itr-bi');
    assert('Shadow DOM 内容被翻译', !!shadowSpan && shadowSpan.textContent.indexOf('译「Shadow dom') === 0);
    assert('Shadow DOM 原文保留',
      !!card.shadowRoot.querySelector('p') &&
      card.shadowRoot.querySelector('p').textContent.indexOf('Shadow dom paragraph content') === 0);

    // 表单属性翻译：placeholder 替换、title 双语
    const input = document.getElementById('nameInput');
    assert('placeholder 被翻译', input.placeholder.indexOf('译「Please enter your name') === 0);
    assert('title 做成双语（原文 + 译文）',
      input.title.indexOf('Name field title') === 0 && input.title.indexOf('译「') > 0);

    // 译文颜色应用了设置值
    assert('译文颜色来自设置', spans.length > 0 && spans[0].style.color === 'rgb(255, 0, 0)');

    const st1 = await dispatch({ type: 'itr:page', action: 'getState' });
    assert('翻译后状态为 enabled', st1.enabled === true);

    // ---- 恢复原文 ----
    await dispatch({ type: 'itr:page', action: 'restore' });
    assert('恢复后译文节点全部移除', document.querySelectorAll('.itr-bi').length === 0);
    assert('恢复后原文还原', document.querySelector('h1').textContent === 'The quick brown fox');
    assert('恢复后属性还原',
      input.placeholder === 'Please enter your name' && input.title === 'Name field title');
    assert('恢复后 Shadow DOM 译文移除',
      !(card.shadowRoot.querySelector('.itr-bi')));

    // ---- 场景 2：替换模式 ----
    window.__itrSetSettings({ displayMode: 'replace' });
    const started2 = await dispatch({ type: 'itr:page', action: 'start' });
    assert('替换模式翻译成功', started2 && started2.ok === true);
    await sleep(150);
    assert('替换模式无双语节点', document.querySelectorAll('.itr-bi').length === 0);
    assert('标题被替换为译文', document.querySelector('h1').textContent.indexOf('译「') === 0);
    assert('多片段段落整体替换为整段译文',
      document.querySelector('p').textContent.indexOf('译「Hello world') === 0);

    await dispatch({ type: 'itr:page', action: 'restore' });
    assert('替换模式恢复原文',
      document.querySelector('h1').textContent === 'The quick brown fox' &&
      document.querySelector('p').querySelector('b').textContent === 'bold text');

    // ---- 场景 3：黑名单 ----
    window.__itrSetSettings({ displayMode: 'bilingual', blacklist: [location.hostname] });
    const blocked = await dispatch({ type: 'itr:page', action: 'start' });
    assert('黑名单站点拒绝翻译', blocked && blocked.ok === false && blocked.blocked === true);
    window.__itrSetSettings({ blacklist: [] });

    // ---- 场景 4：restart（设置变更自动重译） ----
    const r1 = await dispatch({ type: 'itr:page', action: 'start' });
    assert('翻译成功（restart 前置）', r1 && r1.ok === true && r1.total > 0);
    window.__itrSetSettings({ displayMode: 'replace' });
    const r2 = await dispatch({ type: 'itr:page', action: 'restart' });
    await sleep(150);
    assert('restart 后按新设置生效（无双语节点）', r2 && r2.ok === true &&
      document.querySelectorAll('.itr-bi').length === 0);

    // ---- 场景 5：动态内容 ----
    window.__itrSetSettings({ displayMode: 'bilingual' });
    const rc = await dispatch({ type: 'itr:page', action: 'restart' });
    await sleep(100);
    const dyn = document.createElement('p');
    dyn.textContent = 'A dynamically added paragraph';
    document.body.appendChild(dyn);
    let dynOk = false;
    for (let i = 0; i < 20 && !dynOk; i++) {
      await sleep(200);
      dynOk = !!dyn.querySelector('.itr-bi');
    }
    if (!dynOk) {
      results.push({ name: '诊断 restart=' + JSON.stringify(rc) +
        ' state=' + JSON.stringify(await dispatch({ type: 'itr:page', action: 'getState' })) +
        ' dyn=' + dyn.innerHTML.slice(0, 80) +
        ' dbg=' + JSON.stringify(window.__itrDbg || {}), ok: true });
    }
    assert('动态新增内容被自动翻译', dynOk);

    // ---- 场景 6：点击后重扫（CSS 切换显示的菜单/弹层） ----
    const menu = document.getElementById('delayedMenu');
    menu.style.display = 'block';            // 仅切换显示，无新增 DOM 节点
    document.body.click();                   // 模拟用户点击 → 触发重扫
    let menuOk = false;
    for (let i = 0; i < 15 && !menuOk; i++) {
      await sleep(300);
      menuOk = !!menu.querySelector('.itr-bi');
    }
    assert('点击后重扫翻译了新显示的内容', menuOk);
    await dispatch({ type: 'itr:page', action: 'restore' });
  } catch (e) {
    results.push({ name: '执行异常: ' + (e && e.stack || e), ok: false });
  }

  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.name);
  const logEl = document.getElementById('log');
  logEl.textContent = lines.join('\n') + '\n\n' + (failed.length ? `✗ ${failed.length} 项失败` : '✓ 全部通过');
  document.title = failed.length ? 'HARNESS FAIL' : 'HARNESS PASS';
  console.log(lines.join('\n'));
})();
