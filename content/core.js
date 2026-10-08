// 整页翻译核心（与 chrome API 解耦，便于在测试页中复用）。
//
// 核心模型：**段落级翻译单元（unit）**。
//   - 一个单元 = 一个“叶子块”元素（其子级不再包含块级元素，如 <p>/<h1>/<li>/<td>），
//     或容器块中直接承载的文本；也支持元素属性单元（placeholder/title/alt/aria-label）。
//   - 整段合并翻译：同一单元内的多个内联片段（<b>/<a> 等切开句子）合并为一段文本
//     一次性送翻，上下文完整 → 译文质量更高，请求数与 token 消耗更低。
//   - 双语对照：译文以整行形式插到段落下方（叶子块内 / 容器块锚点后），原文不动；
//     flex / 定高溢出容器自动降级为行内译文，避免破坏布局。
//   - 仅译文：单元只有一个文本节点时原位替换；多节点时首个节点写入整段译文、
//     其余置空（保持“纯译文”阅读体验，恢复原文时全部还原）。
// 覆盖能力：开放 Shadow DOM（含嵌套）、iframe 内文档（配合 all_frames 注入）、
//   表单属性、点击/聚焦后新显示的内容、框架（Vue/React）回写文本的对抗恢复。
// 职责：收集单元 → 批量请求 → 写回 DOM → 恢复原文 / 动态内容监听 / 失败重试。

(function (global) {
  'use strict';

  // 这些元素内的文本不翻译；.itr-bi 是本插件插入的译文节点，.itr-tb-host 是页内徽章宿主
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'iframe', 'canvas', 'svg', 'math',
    'object', 'embed', 'code', 'pre', 'kbd', 'samp', 'var', 'textarea', 'select',
    'option', 'input',
    '[contenteditable="true"]', '[contenteditable=""]',
    '[translate="no"]', '.notranslate',
    '.itr-bi', '.itr-tb-host'
  ].join(',');

  // 需要翻译的元素属性（表单占位、提示、无障碍标签、图片替代文本）
  const ATTR_NAMES = ['placeholder', 'title', 'alt', 'aria-label'];

  const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
  const LETTER_RE = /\p{L}/u;
  const BLOCK_DISPLAY_RE = /^(block|flex|grid|list-item|table|flow-root)/;

  const MAX_UNITS = 1500;        // 单次整页翻译的段落单元上限
  const MAX_ATTR_UNITS = 300;    // 单次属性翻译单元上限
  const BATCH_CHARS = 1200;      // 每批字符预算
  const BATCH_LINES = 40;        // 每批条数上限

  function isTranslatableText(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (!LETTER_RE.test(trimmed)) return false;
    // 纯链接 / 邮箱地址没有可翻译的自然语言内容，跳过以节省请求
    if (/^(https?:\/\/|www\.)\S+$/i.test(trimmed)) return false;
    if (/^\S+@\S+\.\S+$/.test(trimmed)) return false;
    if (!CJK_RE.test(trimmed) && trimmed.length < 2) return false;
    return true;
  }

  function isVisible(el) {
    try {
      if (el.checkVisibility) {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
    } catch (e) { /* 老内核直接视为可见 */ }
    return true;
  }

  function normalizeText(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function create() {
    // 计算样式按元素缓存：同一元素的 display / overflow / height 会在
    // 块级判定与写回降级判断中多次读取，避免重复调用 getComputedStyle
    let styleCache = new WeakMap();

    function css(el) {
      let cs = styleCache.get(el);
      if (cs === undefined) {
        cs = getComputedStyle(el);
        styleCache.set(el, cs);
      }
      return cs;
    }

    const state = {
      enabled: false,          // 用户开关：是否处于“已翻译”状态
      translating: false,      // 是否正在翻译
      gen: 0,                  // 代次计数：restore/再次翻译会使旧任务作废
      processed: new WeakSet(),// 已收集过的文本节点
      processedAttrs: new WeakMap(), // 已收集过的元素属性 el -> Set(attr)
      nodeWatch: new WeakMap(),// 已登记的文本节点 -> { original, expected }，用于框架回写对抗
      entries: [],             // 已应用的翻译记录，用于恢复原文
      observer: null,
      failedUnits: [],         // 翻译失败的单元（供重试）
      unitSeq: 0,
      lastError: ''
    };

    // -------------------------------------------------- 基础收集工具

    // 在子树内收集可翻译文本节点（按元素缓存可见性，降低开销）。
    // 会进入开放 Shadow DOM（含嵌套）；声明了 shadowRoot 的宿主元素，
    // 其 light DOM 不参与渲染，自动跳过。
    // hostList：调用方预计算的全页 Shadow 宿主列表（可为空数组=快速路径）；
    //   不传时在子树内自行扫描（观察器 / 动态内容路径）。
    function collectInSubtree(root, limit, matchFn, hostList) {
      const items = [];
      const visibleCache = new Map();
      const seenRoots = new Set();

      const walkText = (walkerRoot, shadowHosts) => {
        const inShadowHostLightDom = (parent) => {
          for (let i = 0; i < shadowHosts.length; i++) {
            if (shadowHosts[i] === parent || shadowHosts[i].contains(parent)) return true;
          }
          return false;
        };

        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          if (items.length >= limit) return;
          if (!matchFn(node)) continue;
          const parent = node.parentElement;
          if (!parent || parent.closest(SKIP_SELECTOR)) continue;
          if (shadowHosts.length && inShadowHostLightDom(parent)) continue;
          let visible = visibleCache.get(parent);
          if (visible === undefined) {
            visible = isVisible(parent);
            visibleCache.set(parent, visible);
          }
          if (!visible) continue;
          const text = normalizeText(node.nodeValue);
          if (!isTranslatableText(text)) continue;
          items.push({ node, text });
        }
      };

      const walk = (walkerRoot, hosts) => {
        if (seenRoots.has(walkerRoot)) return;
        seenRoots.add(walkerRoot);

        // 宿主列表：优先用调用方预计算的结果（仅保留当前子树内的）；
        // 未提供时自行扫描；进入 shadow 树内部后总是重新扫描（嵌套 shadow）
        let shadowHosts = hosts;
        if (shadowHosts === undefined) {
          shadowHosts = findShadowHosts(walkerRoot);
        } else {
          shadowHosts = shadowHosts.filter(
            (h) => h === walkerRoot || (walkerRoot.contains && walkerRoot.contains(h))
          );
        }

        walkText(walkerRoot, shadowHosts);
        if (items.length >= limit) return;

        // 递归进入 Shadow Root（Shadow 内可能还有嵌套 Shadow）
        for (const host of shadowHosts) {
          if (items.length >= limit) return;
          walk(host.shadowRoot, undefined);
        }
      };

      walk(root, hostList);
      return items;
    }

    // nodes 允许两种形态：{node, text} 收集项，或裸文本节点（内部统一解开）
    function makeUnit(el, nodes, isContainer) {
      const items = nodes.map((n) => (n && n.node ? n.node : n));
      return {
        el,
        nodes: items,
        text: items.map((n) => normalizeText(n.nodeValue)).join(' '),
        isContainer: !!isContainer
      };
    }

    function markUnit(unit) {
      for (const n of unit.nodes) state.processed.add(n);
    }

    // 容器块中直接承载的文本（不含块级子元素内的文本）
    function directTextNodes(el) {
      const nodes = [];
      for (const n of el.childNodes) {
        if (n.nodeType !== Node.TEXT_NODE) continue;
        if (state.processed.has(n)) continue;
        const text = normalizeText(n.nodeValue);
        if (!isTranslatableText(text)) continue;
        nodes.push(n);
      }
      return nodes;
    }

    // -------------------------------------------------- 属性翻译单元

    // 属性宿主的排除规则：与文本规则不同——input/textarea 自身要保留
    // （其 placeholder 需要翻译），只排除结构性的跳过场景
    const ATTR_HOST_SKIP = [
      'code', 'pre', 'kbd', 'samp', 'var', 'noscript', 'template',
      '[contenteditable="true"]', '[contenteditable=""]',
      '[translate="no"]', '.notranslate', '.itr-bi', '.itr-tb-host'
    ].join(',');

    function collectAttrUnits(limit) {
      const units = [];
      // 单次元素遍历收集所有目标属性（替代对每个属性各做一次全 DOM 查询）
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
      let el;
      while ((el = walker.nextNode()) && units.length < limit) {
        // 廉价预检：是否带任一目标属性（绝大多数元素不带，直接跳过）
        const present = [];
        for (const attr of ATTR_NAMES) {
          if (el.hasAttribute(attr)) present.push(attr);
        }
        if (!present.length) continue;

        if (el.closest(ATTR_HOST_SKIP)) continue;
        // 非表单元素沿用完整文本排除规则（如 svg 内、select 内的 title）
        if (!/^(INPUT|TEXTAREA)$/.test(el.tagName) && el.closest(SKIP_SELECTOR)) continue;
        if (!isVisible(el)) continue;

        let set = state.processedAttrs.get(el);
        for (const attr of present) {
          if (units.length >= limit) break;
          if (set && set.has(attr)) continue;
          const original = el.getAttribute(attr);
          const text = normalizeText(original || '');
          if (!isTranslatableText(text)) continue;
          if (!set) {
            set = new Set();
            state.processedAttrs.set(el, set);
          }
          set.add(attr);
          units.push({ attrUnit: true, el, attr, text, original });
        }
      }
      return units;
    }

    function applyAttrUnit(unit, translation, settings) {
      if (!translation || translation === unit.text) return true;
      if (!unit.el.isConnected) return false;
      // title 悬浮提示做成双语；其余属性直接替换（原值记录在案，可恢复）
      const value = unit.attr === 'title' ? unit.original + '\n' + translation : translation;
      unit.el.setAttribute(unit.attr, value);
      state.entries.push({ attrEntry: true, el: unit.el, name: unit.attr, value: unit.original });
      return true;
    }

    // -------------------------------------------------- 整页单元收集

    // 页面级一次性的 Shadow 宿主扫描（light DOM 遍历不进入 shadow 树，
    // 嵌套 shadow 由 collectInSubtree 在进入 shadow 内部时自行扫描）
    function findShadowHosts(root) {
      const hosts = [];
      try {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        let el;
        while ((el = walker.nextNode()) && hosts.length <= 500) {
          if (el.shadowRoot) hosts.push(el);
        }
      } catch (e) { /* 忽略 */ }
      return hosts;
    }

    function collectUnits(limit) {
      const units = [];
      // 一次扫描得到全页 Shadow 宿主：绝大多数页面为空数组，
      // collectInSubtree 据此跳过元素级二次遍历（快速路径）
      const shadowHosts = findShadowHosts(document.body);
      const isBlock = (el) => {
        return BLOCK_DISPLAY_RE.test(css(el).display);
      };

      const visit = (el) => {
        if (units.length >= limit) return;

        // 带 Shadow Root 的宿主只渲染 Shadow 内容，light DOM 不处理
        if (el.shadowRoot) {
          if (el.closest && el.closest(SKIP_SELECTOR)) return;
          visit(el.shadowRoot);
          return;
        }

        const blockChildren = [];
        for (const child of el.children) {
          if (child.closest(SKIP_SELECTOR)) continue;
          if (isBlock(child)) blockChildren.push(child);
        }

        if (blockChildren.length) {
          // 容器块：递归处理块级子元素，直接文本单独成单元
          for (const child of blockChildren) visit(child);
          // 行内子元素（自定义元素 / 带 Shadow 的宿主 / 直接承载文本的行内元素）
          // 不属于任何叶子块，各自作为独立单元收集
          for (const child of el.children) {
            if (units.length >= limit) break;
            if (blockChildren.includes(child)) continue;
            if (child.closest && child.closest(SKIP_SELECTOR)) continue;
            if (child.shadowRoot) {
              visit(child);
              continue;
            }
            if (!isVisible(child)) continue;
            const found = collectInSubtree(
              child,
              limit - units.length,
              (n) => !state.processed.has(n)
            );
            if (found.length) {
              const unit = makeUnit(child, found, false);
              markUnit(unit);
              units.push(unit);
            }
          }
          if (units.length < limit && isVisible(el)) {
            const nodes = directTextNodes(el);
            if (nodes.length) {
              const unit = makeUnit(el, nodes, true);
              markUnit(unit);
              units.push(unit);
            }
          }
        } else {
          // 叶子块：整块内容（含内联子元素、Shadow DOM）作为一个翻译单元
          if (el.closest && el.closest(SKIP_SELECTOR)) return;
          if (!isVisible(el)) return;
          const found = collectInSubtree(
            el,
            limit - units.length,
            (n) => !state.processed.has(n),
            shadowHosts
          );
          if (found.length) {
            const unit = makeUnit(el, found, false);
            markUnit(unit);
            units.push(unit);
          }
        }
      };

      if (document.body) visit(document.body);
      return units;
    }

    // 动态内容：新出现的文本节点 → 按最近的块级祖先分组为单元
    function nearestBlockAncestor(node) {
      let el = node.parentElement;
      // Shadow Root 顶层文本节点的 parentElement 为 null，落到宿主元素
      if (!el && node.parentNode && node.parentNode.host) el = node.parentNode.host;
      while (el && el !== document.body) {
        if (!el.closest(SKIP_SELECTOR) && BLOCK_DISPLAY_RE.test(css(el).display)) {
          return el;
        }
        el = el.parentElement;
      }
      return document.body;
    }

    function collectFreshUnits(roots, limit) {
      const freshNodes = [];
      const seen = new Set();
      for (const root of roots) {
        const target = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
        if (!target || (target.closest && target.closest(SKIP_SELECTOR))) continue;
        const found = collectInSubtree(
          target,
          limit - freshNodes.length,
          (n) => !state.processed.has(n) && !seen.has(n)
        );
        for (const item of found) {
          if (!seen.has(item.node)) {
            seen.add(item.node);
            state.processed.add(item.node);
            freshNodes.push(item.node);
          }
        }
        if (freshNodes.length >= limit) break;
      }
      if (!freshNodes.length) return [];

      const groups = new Map();
      for (const node of freshNodes) {
        const el = nearestBlockAncestor(node);
        if (!groups.has(el)) groups.set(el, []);
        groups.get(el).push(node);
      }
      const units = [];
      for (const [el, nodes] of groups) {
        units.push(makeUnit(el, nodes, false));
      }
      return units;
    }

    // -------------------------------------------------- 分批与并发

    // 按当前服务适配批次上限：与后台各服务的请求体积上限对齐，
    // 避免"内容端小批次 + 服务端大上限"造成的请求数浪费（AI 尤其明显）
    function batchCapsFor(provider) {
      if (provider === 'ai') return { chars: 2800, lines: 36 };
      if (provider === 'microsoft') return { chars: 2000, lines: 40 };
      return { chars: 1200, lines: 50 };
    }

    function buildBatches(texts, caps) {
      const cap = caps || { chars: BATCH_CHARS, lines: BATCH_LINES };
      const batches = [];
      let cur = [];
      let chars = 0;
      for (const text of texts) {
        if (cur.length >= cap.lines || (cur.length && chars + text.length > cap.chars)) {
          batches.push(cur);
          cur = [];
          chars = 0;
        }
        cur.push(text);
        chars += text.length;
      }
      if (cur.length) batches.push(cur);
      return batches;
    }

    async function runPool(tasks, limit, worker) {
      let index = 0;
      const size = Math.max(1, Math.min(limit, tasks.length));
      const runners = Array.from({ length: size }, async () => {
        while (index < tasks.length) {
          const i = index++;
          await worker(tasks[i], i);
        }
      });
      await Promise.all(runners);
    }

    // -------------------------------------------------- 写回 DOM

    function applyUnit(unit, translation, settings) {
      if (!unit.nodes.every((n) => n.isConnected)) return false;
      if (!translation || translation === unit.text) return true;

      const entry = {
        nodes: unit.nodes.map((n) => ({ node: n, original: n.nodeValue })),
        span: null
      };

      if (settings.displayMode === 'replace') {
        // 纯译文：整段译文写入首个节点，其余片段置空（恢复原文时全部还原）
        unit.nodes.forEach((n, i) => {
          const expected = i === 0 ? translation : '';
          state.nodeWatch.set(n, { original: entry.nodes[i].original, expected });
          n.nodeValue = expected;
        });
      } else {
        const span = document.createElement('span');
        span.setAttribute('dir', 'auto'); // 目标语言为 RTL（如阿拉伯语）时自动调整方向
        span.textContent = translation;
        span.style.color = settings.translationColor || '#3b82f6';
        // 容器块 / 文本节点都在块内：紧跟最后一个文本节点；叶子块：作为块的最后一行
        const allDirect = unit.nodes.every((n) => n.parentElement === unit.el);
        let constrained = false;
        try {
          const cs = css(unit.el);
          // flex 行内容器与“定高 + 溢出裁剪”的元素里，整行译文会挤爆布局，降级为行内
          constrained =
            /flex/.test(cs.display) ||
            ((cs.overflowY === 'hidden' || cs.overflow === 'hidden') && cs.height !== 'auto');
        } catch (e) { /* 忽略样式读取失败 */ }

        if (constrained) {
          span.className = 'itr-bi';
          unit.nodes[unit.nodes.length - 1].after(span);
        } else if (unit.isContainer || allDirect) {
          span.className = 'itr-bi itr-bi-block';
          unit.nodes[unit.nodes.length - 1].after(span);
        } else {
          span.className = 'itr-bi itr-bi-block';
          unit.el.appendChild(span);
        }
        entry.span = span;
        // 登记原文节点：框架（Vue 等）通过 nodeValue 改写文本时可以发现并重新翻译
        unit.nodes.forEach((n, i) => {
          state.nodeWatch.set(n, { original: entry.nodes[i].original, expected: entry.nodes[i].original });
        });
      }
      state.entries.push(entry);
      return true;
    }

    // -------------------------------------------------- 批量翻译 + 应用（观察器 / 重扫共用）

    async function translateAndApplyUnits(units, settings, hooks, gen) {
      const uniqueTexts = [...new Set(units.map((u) => u.text))];
      hooks.onProgress && hooks.onProgress(0, uniqueTexts.length);
      const results = new Map();
      const failedTexts = new Set();
      const batches = buildBatches(uniqueTexts, batchCapsFor(settings.provider));
      await runPool(batches, 2, async (batch) => {
        try {
          const out = await hooks.translateFn(batch);
          batch.forEach((t, i) => results.set(t, out[i] != null ? out[i] : ''));
        } catch (e) {
          batch.forEach((t) => failedTexts.add(t));
          state.lastError = e && e.message ? e.message : String(e);
          hooks.onError && hooks.onError(state.lastError);
        }
      });
      if (gen !== state.gen) return { cancelled: true };
      let applied = 0;
      for (const unit of units) {
        if (gen !== state.gen) break;
        const t = results.get(unit.text);
        if (t === undefined) {
          if (failedTexts.has(unit.text)) state.failedUnits.push(unit);
          continue;
        }
        const ok = unit.attrUnit
          ? applyAttrUnit(unit, t, settings)
          : applyUnit(unit, t, settings);
        if (ok) applied++;
      }
      return { applied, failed: state.failedUnits.length };
    }

    // -------------------------------------------------- 主流程：整页翻译

    async function translate(settings, hooks) {
      if (state.translating) return { ok: false, error: '正在翻译中，请稍候' };
      if (!document.body) return { ok: false, error: '页面没有可翻译的内容' };

      state.translating = true;
      state.gen++;
      const gen = state.gen;
      state.failedUnits = [];
      state.lastError = '';

      try {
        const units = collectUnits(MAX_UNITS);
        if (units.length < MAX_UNITS) units.push(...collectAttrUnits(MAX_ATTR_UNITS));
        if (!units.length) return { ok: true, total: 0 };
        if (units.length >= MAX_UNITS) {
          hooks.onNotice && hooks.onNotice(`页面过长，本次最多翻译 ${MAX_UNITS} 个段落`);
        }
        units.forEach((u) => { u.id = state.unitSeq++; });

        const uniqueTexts = [...new Set(units.map((u) => u.text))];
        hooks.onProgress(0, uniqueTexts.length);

        let aborted = false;
        let firstChecked = false;
        const results = new Map();
        const failedTexts = new Set();
        const batches = buildBatches(uniqueTexts, batchCapsFor(settings.provider));
        const limit = Math.max(1, Math.min(settings.concurrency || 3, 6));
        let doneBatches = 0;

        await runPool(batches, limit, async (batch) => {
          if (aborted || gen !== state.gen) return;
          try {
            const out = await hooks.translateFn(batch);
            if (aborted || gen !== state.gen) return;
            // 首批同语言检测：绝大多数译文与原文相同则认为页面已是目标语言
            if (!firstChecked && settings.autoDetectSkip !== false) {
              firstChecked = true;
              const same = batch.filter((t, i) => String(out[i] || '').trim() === t.trim()).length;
              if (same >= Math.ceil(batch.length * 0.9)) {
                aborted = true;
                hooks.onAborted && hooks.onAborted();
                return;
              }
            }
            batch.forEach((t, i) => results.set(t, out[i] != null ? out[i] : ''));
          } catch (e) {
            batch.forEach((t) => failedTexts.add(t));
            state.lastError = e && e.message ? e.message : String(e);
            hooks.onError(state.lastError);
          }
          doneBatches++;
          hooks.onProgress(doneBatches, batches.length);
        });

        if (gen !== state.gen) return { ok: true, cancelled: true };

        // 写回 DOM（相同段落复用同一译文）
        let appliedCount = 0;
        for (const unit of units) {
          if (gen !== state.gen) break;
          const t = results.get(unit.text);
          if (t === undefined) {
            if (failedTexts.has(unit.text)) state.failedUnits.push(unit);
            continue;
          }
          const ok = unit.attrUnit
            ? applyAttrUnit(unit, t, settings)
            : applyUnit(unit, t, settings);
          if (ok) appliedCount++;
        }

        if (!aborted && state.enabled) {
          startObserver(settings, hooks);
        }

        return {
          ok: true,
          total: units.length,
          applied: appliedCount,
          failed: state.failedUnits.length,
          aborted
        };
      } finally {
        if (gen === state.gen) state.translating = false;
      }
    }

    // -------------------------------------------------- 动态内容监听

    // 框架回写对抗：Vue/React 等直接改写 nodeValue。
    //  - 被改回原文 → 重新写入译文（我方写入的变更会被 expected 比对忽略，无循环）
    //  - 被改成全新内容 → 解除登记、重新翻译
    function handleCharMutations(mutations) {
      const refreshedRoots = [];
      for (const m of mutations) {
        const node = m.target;
        const info = state.nodeWatch.get(node);
        if (!info) continue;
        const cur = node.nodeValue;
        if (cur === info.expected) continue;
        if (cur === info.original) {
          if (info.expected !== info.original) node.nodeValue = info.expected;
          continue;
        }
        state.processed.delete(node);
        state.nodeWatch.delete(node);
        if (node.parentElement) refreshedRoots.push(node.parentElement);
      }
      return refreshedRoots;
    }

    function startObserver(settings, hooks) {
      if (state.observer) state.observer.disconnect();
      let timer = null;
      // MutationObserver 回调投递时记录即被消费，必须在这里收集；
      // 定时器触发时再合并 takeRecords 捞取尚未投递的记录。
      let pendingMutations = [];
      const gen = state.gen;
      const shadowObserved = new WeakSet();

      // 为主文档与页面中已存在的开放 Shadow Root 挂观察器
      const attachShadowObservers = () => {
        if (!state.observer) return;
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
          let el;
          let count = 0;
          while ((el = walker.nextNode()) && count < 200) {
            if (el.shadowRoot && !shadowObserved.has(el.shadowRoot)) {
              shadowObserved.add(el.shadowRoot);
              state.observer.observe(el.shadowRoot, { childList: true, subtree: true, characterData: true });
              count++;
            }
          }
        } catch (e) { /* 忽略 */ }
      };

      const runScan = (mutations) => {
        const charMuts = [];
        const roots = [];
        for (const m of mutations) {
          if (m.type === 'characterData') {
            if (state.nodeWatch.has(m.target)) charMuts.push(m);
            continue;
          }
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE) {
              if (!n.closest || !n.closest(SKIP_SELECTOR)) roots.push(n);
            } else if (n.nodeType === Node.TEXT_NODE) {
              if (n.parentElement && !n.parentElement.closest(SKIP_SELECTOR)) {
                roots.push(n.parentElement);
              }
            }
          }
        }
        roots.push(...handleCharMutations(charMuts));
        if (!roots.length) return;

        const run = async () => {
          if (!state.enabled || gen !== state.gen) return;
          try {
            const units = collectFreshUnits(roots, 600);
            if (!units.length) return;
            await translateAndApplyUnits(units, settings, hooks, gen);
            attachShadowObservers();
          } catch (e) { /* 动态内容翻译失败静默，不影响页面 */ }
        };
        run();
      };

      state.observer = new MutationObserver((mutations) => {
        if (!state.enabled || gen !== state.gen) return;
        // 预过滤：本插件自己插入的译文节点也会触发变更，直接忽略
        let relevant = false;
        for (const m of mutations) {
          if (m.type === 'characterData') {
            if (state.nodeWatch.has(m.target)) {
              relevant = true;
              break;
            }
            continue;
          }
          for (const n of m.addedNodes) {
            const el = n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement;
            if (el && !el.closest('.itr-bi') && !el.closest('.itr-tb-host')) {
              relevant = true;
              break;
            }
          }
          if (relevant) break;
        }
        if (!relevant) return;
        pendingMutations.push(...mutations);
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          const batch = pendingMutations;
          pendingMutations = [];
          const undelivered = state.observer && state.observer.takeRecords();
          if (undelivered && undelivered.length) batch.push(...undelivered);
          runScan(batch);
        }, 500);
      });
      state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      attachShadowObservers();
    }

    // -------------------------------------------------- 点击 / 聚焦后重扫
    // 下拉菜单、popover 等内容通常只是切换 CSS 显示（无 DOM 变更），
    // 用户点击 / 聚焦后重新收集一次“现在可见但未翻译”的单元。

    async function rescan(settings, hooks) {
      if (state.translating || !state.enabled) return { ok: false };
      state.translating = true;
      const gen = state.gen;
      try {
        const units = collectUnits(400);
        if (units.length < 400) units.push(...collectAttrUnits(200));
        if (units.length) {
          await translateAndApplyUnits(units, settings, hooks, gen);
        }
        if (state.observer) attachShadowObserversOf(state.observer);
        return { ok: true, total: units.length };
      } finally {
        if (gen === state.gen) state.translating = false;
      }
    }

    // 重扫时为页面上新出现的 Shadow Root 挂观察器（复用当前 observer 实例）
    function attachShadowObserversOf(observer) {
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
        let el;
        let count = 0;
        while ((el = walker.nextNode()) && count < 200) {
          if (el.shadowRoot && !el.shadowRoot.__itrObserved) {
            el.shadowRoot.__itrObserved = true;
            observer.observe(el.shadowRoot, { childList: true, subtree: true, characterData: true });
            count++;
          }
        }
      } catch (e) { /* 忽略 */ }
    }

    // -------------------------------------------------- 失败重试

    async function retryFailed(settings, hooks) {
      // 同一单元可能因重复批次被登记多次，按收集序号去重
      const seen = new Set();
      const failed = [];
      for (const unit of state.failedUnits) {
        if (!unit.el.isConnected || seen.has(unit.id)) continue;
        seen.add(unit.id);
        failed.push(unit);
      }
      if (!failed.length) {
        state.failedUnits = [];
        return { ok: true, total: 0 };
      }

      state.translating = true;
      const gen = state.gen;
      try {
        hooks.onProgress(0, failed.length);
        const results = new Map();
        const batches = buildBatches([...new Set(failed.map((u) => u.text))]);
        await runPool(batches, 2, async (batch) => {
          try {
            const out = await hooks.translateFn(batch);
            batch.forEach((t, i) => results.set(t, out[i] != null ? out[i] : ''));
          } catch (e) {
            state.lastError = e && e.message ? e.message : String(e);
            hooks.onError(state.lastError);
          }
        });

        if (gen !== state.gen) return { ok: true, cancelled: true };
        const stillFailed = [];
        let applied = 0;
        for (const unit of failed) {
          const t = results.get(unit.text);
          const ok = t !== undefined && t !== '' && (unit.attrUnit
            ? applyAttrUnit(unit, t, settings)
            : applyUnit(unit, t, settings));
          if (ok) {
            applied++;
          } else {
            stillFailed.push(unit);
          }
        }
        state.failedUnits = stillFailed;
        hooks.onProgress(failed.length, failed.length);
        return { ok: true, total: failed.length, failed: stillFailed.length };
      } finally {
        if (gen === state.gen) state.translating = false;
      }
    }

    // -------------------------------------------------- 恢复原文

    function restore() {
      if (state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }
      state.gen++; // 使进行中的翻译任务全部作废
      for (const entry of state.entries) {
        try {
          if (entry.attrEntry) {
            if (entry.el.isConnected) entry.el.setAttribute(entry.name, entry.value);
            continue;
          }
          for (const n of entry.nodes) {
            if (n.node.isConnected) n.node.nodeValue = n.original;
          }
          if (entry.span) entry.span.remove();
        } catch (e) { /* 节点可能已被页面移除 */ }
      }
      state.entries = [];
      state.processed = new WeakSet();
      state.processedAttrs = new WeakMap();
      state.nodeWatch = new WeakMap();
      styleCache = new WeakMap();
      state.failedUnits = [];
      state.enabled = false;
      state.translating = false;
      return { ok: true };
    }

    return { state, translate, restore, retryFailed, rescan };
  }

  global.ITRCore = { create };
})(typeof self !== 'undefined' ? self : this);
