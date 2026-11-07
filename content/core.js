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
    // 代码 / 脚本特征：站点常把 JS 源码内联在非 script 标签里（IEEE 的
    // <APM_DO_NOT_TOUCH> 就塞了 4000+ 字符监控脚本）。这些内容不可翻译，
    // 送进模型只会烧 token 并污染写回结果。
    if (looksLikeCode(trimmed)) return false;
    if (!CJK_RE.test(trimmed) && trimmed.length < 2) return false;
    return true;
  }

  // 启发式判断“这段文本是代码而不是自然语言”。
  // 阈值取保守值：宁可漏判（照常翻译），也不要把正常正文误杀。
  function looksLikeCode(s) {
    // 明显的函数/脚本骨架
    if (/^\s*(?:\(function\s*\(|function\s*[\w$]*\s*\(|var\s+[\w$]+\s*=|const\s+[\w$]+\s*=|let\s+[\w$]+\s*=)/.test(s)) {
      return true;
    }
    // 连续出现 JSON/JS 特征符号
    const codeChars = (s.match(/[{}();=<>[\]]/g) || []).length;
    if (s.length > 60 && codeChars / s.length > 0.04) return true;
    // 典型脚本片段
    if (/window\.[\w$]+\s*=|document\.[\w$]+\(|\.prototype\.|=>\s*\{/.test(s)) return true;
    return false;
  }

  function isVisible(el) {
    try {
      if (el.checkVisibility) {
        // checkVisibility 只看 CSS 层的 display/visibility/opacity，不看「有没有渲染尺寸」。
        // 站点的内联 <script>/<APM_DO_NOT_TOUCH> 之类元素 display:inline、visibility:visible，
        // 但渲染尺寸是 0×0（IEEE Xplore 上就有 4025 字符的 JS 源码挂在这种标签里）。
        // 不加尺寸判定会把整段源码当正文翻译，既烧 token 又破坏写回布局。
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      }
    } catch (e) {
      return true; // 老内核直接视为可见
    }

    // 尺寸兜底：元素必须真的占有面积。
    // 注意不能用 getClientRects().length —— 宽高都是 0 的元素（IEEE 的
    // <APM_DO_NOT_TOUCH> 内联脚本）依然会返回 1 个空 rect。
    try {
      const rects = el.getClientRects();
      let area = false;
      for (let i = 0; i < rects.length; i++) {
        if (rects[i].width > 0 && rects[i].height > 0) { area = true; break; }
      }
      if (!area) return false;
    } catch (e) {
      return true;
    }
    return true;
  }

  function normalizeText(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function create() {
    // 计算样式按元素缓存：同一元素的 display / overflow / height 会在
    // 块级判定与写回降级判断中多次读取，避免重复调用 getComputedStyle
    let styleCache = new WeakMap();
    // “是否有块级子元素”的判定结果缓存（isLayoutConstrained 向上查祖先时会重复问）
    let blockChildCache = new WeakMap();

    function css(el) {
      let cs = styleCache.get(el);
      if (cs === undefined) {
        cs = getComputedStyle(el);
        styleCache.set(el, cs);
      }
      return cs;
    }

    // 写回位置是否会“挤压”译文：向上看若干层祖先，遇到下列任一情况就只允许行内译文，
    // 不允许插入 display:block 的整行译文。
    //   · 祖先自身是 flex / grid 容器 —— 新增块级子项会被 flex 拉伸，改变整行高度
    //   · 祖先高度被写死（非 auto）且 overflow 裁剪 —— 译文会被切掉
    //   · 祖先自身是 inline（如 IEEE 的 xpl-results-item），块级子项会打断行盒、撑高父级
    const MAX_LAYOUT_LOOKUP = 4;

    function isLayoutConstrained(el) {
      let cur = el;
      for (let depth = 0; cur && depth <= MAX_LAYOUT_LOOKUP; depth++) {
        let cs;
        try {
          cs = css(cur);
        } catch (e) {
          break; // 跨文档 / 已脱离文档：不再向上判断
        }
        if (!cs) break;

        const display = cs.display || '';
        // 当前元素或祖先是 flex / grid：块级译文会被当作 flex item 处理
        if (/flex|grid/.test(display)) return true;

        // 祖先高度写死且裁剪溢出：块级译文会被切掉（行内同样受影响，但不额外增行）
        if (
          (cs.overflowY === 'hidden' || cs.overflow === 'hidden') &&
          cs.height !== 'auto' &&
          depth > 0
        ) {
          return true;
        }

        // 自身是 inline 且内部含块级子元素时，块级译文会打断行盒并撑高父级
        if (depth > 0 && /^inline/.test(display) && hasBlockChild(cur)) return true;

        cur = cur.parentElement;
        if (cur === document.body || cur === document.documentElement) break;
      }
      return false;
    }

    // 元素是否至少有一个块级子元素（判定结果随元素缓存，同一单元内复用）
    function hasBlockChild(el) {
      let hit = blockChildCache.get(el);
      if (hit !== undefined) return hit;
      hit = false;
      for (const child of el.children) {
        if (BLOCK_DISPLAY_RE.test(css(child).display)) {
          hit = true;
          break;
        }
      }
      blockChildCache.set(el, hit);
      return hit;
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
      // 失败单元对应的原文文本。content.js 的进度徽章按文本去重展示失败项，
      // 此前这里从未定义，徽章读取到 undefined。与 failedUnits 同步维护。
      failedTexts: [],
      pendingWriteChecks: [],
      unitSeq: 0,
      lastError: ''
    };

    // failedUnits 与 failedTexts 必须始终一致：前者供重试，后者供徽章展示。
    // 统一经由这两个函数修改，避免出现“重试时看得到、徽章里看不到”的偏差。
    function addFailedUnit(unit) {
      if (!state.failedUnits.includes(unit)) state.failedUnits.push(unit);
      if (!state.failedTexts.includes(unit.text)) state.failedTexts.push(unit.text);
    }

    function clearFailed() {
      state.failedUnits = [];
      state.failedTexts.length = 0;
    }

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
    // 单单元字符上限：超过就拆成多个单元分别送翻。
    // 这是「兜底」而非主要分组依据——真正的分组看下面的 makeUnits。
    const MAX_UNIT_CHARS = 600;

    function makeUnit(el, nodes, isContainer) {
      const items = nodes.map((n) => (n && n.node ? n.node : n));
      const text = items.map((n) => normalizeText(n.nodeValue)).join(' ');
      return {
        el,
        nodes: items,
        text,
        isContainer: !!isContainer
      };
    }

    // 找文本节点最近的「段落级」祖先：页面排版的基本单位。
    // 译文必须按这个粒度生成，否则一条搜索结果（标题+作者+期刊+年份+摘要）
    // 会被拼成一段 300+ 字的译文，整体塞进某个 span，把布局彻底撑坏。
    function paragraphAncestorOf(node, ceiling) {
      let el = node.parentElement;
      while (el && el !== ceiling && el !== document.body) {
        let display = '';
        try { display = css(el).display || ''; } catch (e) { break; }
        // 段落级容器：块级、且不是纯行内包裹层
        if (BLOCK_DISPLAY_RE.test(display)) return el;
        // 行内容器（span/a/em）继续向上找，但不要越过 flex/grid 子项边界
        if (/flex|grid/.test(display)) return el;
        el = el.parentElement;
      }
      return ceiling || (node.parentElement) || document.body;
    }

    // 把收集到的文本节点切成翻译单元。
    //
    // 分组规则（重构后）：
    //   1. 按「最近的段落级祖先」分组 —— 同一段落内的多个文本节点合成一个单元，
    //      这是保证译文语义完整、且写回位置正确的前提；
    //   2. 组内再按 MAX_UNIT_CHARS 切分，避免单请求过大；
    //   3. 不同段落绝不合并在一个单元里。
    //
    // 旧实现只按字符数把整个 el 下的节点拼成几大块，导致一条搜索结果的
    // 标题、作者、摘要全挤进同一个 span，表现为“格式对不齐 / 无填充错位”。
    function makeUnits(el, nodes, isContainer) {
      const items = nodes.map((n) => (n && n.node ? n.node : n));

      // 按段落祖先分桶，保持原有文档顺序
      const buckets = new Map();
      const order = [];
      for (const n of items) {
        const para = paragraphAncestorOf(n, el);
        let bucket = buckets.get(para);
        if (!bucket) {
          bucket = [];
          buckets.set(para, bucket);
          order.push(para);
        }
        bucket.push(n);
      }

      const units = [];
      for (const para of order) {
        const bucket = buckets.get(para);
        let cur = [];
        let curLen = 0;
        const flush = () => {
          if (!cur.length) return;
          // 单元的 el 用段落祖先（写回时的锚点），而不是最外层容器
          units.push(makeUnit(para, cur, isContainer));
          cur = [];
          curLen = 0;
        };
        for (const n of bucket) {
          const len = normalizeText(n.nodeValue).length;
          if (cur.length && curLen + len > MAX_UNIT_CHARS) flush();
          cur.push(n);
          curLen += len;
        }
        flush();
      }
      return units;
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

      // 递归深度上限：防御病态深嵌套页面（正常页面 <20 层）
      const MAX_DEPTH = 200;

      const visit = (el, depth) => {
        if (units.length >= limit) return;
        if (depth > MAX_DEPTH) return;

        // 带 Shadow Root 的宿主只渲染 Shadow 内容，light DOM 不处理
        if (el.shadowRoot) {
          if (el.closest && el.closest(SKIP_SELECTOR)) return;
          visit(el.shadowRoot, depth + 1);
          return;
        }

        const blockChildren = [];
        for (const child of el.children) {
          if (child.closest(SKIP_SELECTOR)) continue;
          if (isBlock(child)) blockChildren.push(child);
        }

        if (blockChildren.length) {
          // 容器块：块级子元素各自递归
          for (const child of blockChildren) {
            if (units.length >= limit) break;
            visit(child, depth + 1);
          }
          // 非块的子元素分两类处理：
          //   a) 自身内部还有块级后代（例如 inline 包裹层里套着 div）→ 继续递归下钻，
          //      否则那些块级内容永远不会被访问（IEEE 的 body 只有 3 个块级子元素，
          //      而实际正文都在更深层的 inline 包裹里，这就是“只收到 3 个单元”的根因）
          //   b) 纯行内内容 → 就地收集为单元
          for (const child of el.children) {
            if (units.length >= limit) break;
            if (blockChildren.includes(child)) continue;
            if (child.closest && child.closest(SKIP_SELECTOR)) continue;
            if (child.shadowRoot) {
              visit(child, depth + 1);
              continue;
            }
            if (!isVisible(child)) continue;

            if (hasBlockChild(child)) {
              visit(child, depth + 1);
              continue;
            }

            const found = collectInSubtree(
              child,
              limit - units.length,
              (n) => !state.processed.has(n)
            );
            if (found.length) {
              for (const unit of makeUnits(child, found, false)) {
                markUnit(unit);
                units.push(unit);
              }
            }
          }
          if (units.length < limit && isVisible(el)) {
            const nodes = directTextNodes(el);
            if (nodes.length) {
              for (const unit of makeUnits(el, nodes, true)) {
                markUnit(unit);
                units.push(unit);
              }
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
            for (const unit of makeUnits(el, found, false)) {
              markUnit(unit);
              units.push(unit);
            }
          }
        }
      };

      if (document.body) visit(document.body, 0);
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
        units.push(...makeUnits(el, nodes, false));
      }
      return units;
    }

    // -------------------------------------------------- 分批与并发

    // 按当前服务适配批次上限：与后台各服务的请求体积上限对齐，
    // 避免"内容端小批次 + 服务端大上限"造成的请求数浪费（AI 尤其明显）
    function batchCapsFor(provider) {
      if (provider === 'ai') return { chars: 2800, lines: 36 };
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
    //
    // 写回模型（重构版）：
    //   一个翻译单元的译文只能是三种形态之一，由「锚点元素」的排版上下文决定，
    //   不再按 isContainer / allDirect 这类间接推断决定：
    //     1. inline  —— 译文作为行内 span 紧跟在最后一个原文节点之后，与原文同属一个行盒
    //     2. block   —— 译文作为独立一行，插在锚点元素内部末尾（仅当锚点是安全的块级容器）
    //   判定顺序：先看锚点及祖先是否“安全”（非 flex/grid、非定高裁剪、非 inline 包裹），
    //   不安全一律降级 inline。这样译文永远不会把原文挤出原有布局。

    // 译文形态
    const MODE_INLINE = 'inline';
    const MODE_BLOCK = 'block';

    // 决定译文形态。decision 会记录在 entry 上，便于恢复与调试。
    function decideWriteMode(unit) {
      // 有原文节点时，锚点是最后一个原文节点的父元素（译文要贴着它出现）
      const lastNode = unit.nodes[unit.nodes.length - 1];
      const anchor = (lastNode && lastNode.parentElement) || unit.el;
      if (!anchor) return { mode: MODE_INLINE, anchor: unit.el };

      // 行内锚点（span/a/em 等）内部只能再放行内内容
      let display = '';
      try {
        display = css(anchor).display || '';
      } catch (e) { /* 忽略 */ }
      if (/^inline/.test(display) && display !== 'inline-block') {
        return { mode: MODE_INLINE, anchor };
      }

      // 锚点或祖先处于 flex/grid/定高裁剪：块级译文会破坏布局，降级行内
      if (isLayoutConstrained(anchor)) {
        return { mode: MODE_INLINE, anchor };
      }

      return { mode: MODE_BLOCK, anchor };
    }

    function applyUnit(unit, translation, settings) {
      if (!unit.nodes.every((n) => n.isConnected)) return false;
      // 空译文、或译文与原文完全相同：不写回，也不计入“已应用”。
      // 之前这里返回 true，导致徽章把“什么都没做”也算成成功块数（IEEE 页面上
      // 报告“已翻译 148 块”，实际只落地 2 个节点），用户看到的是虚假的成功。
      if (!translation || translation === unit.text) return false;

      const entry = {
        nodes: unit.nodes.map((n) => ({ node: n, original: n.nodeValue })),
        span: null,
        mode: null
      };

      if (settings.displayMode === 'replace') {
        // 纯译文：整段译文写入首个节点，其余片段置空（恢复原文时全部还原）
        unit.nodes.forEach((n, i) => {
          const expected = i === 0 ? translation : '';
          state.nodeWatch.set(n, { original: entry.nodes[i].original, expected });
          n.nodeValue = expected;
        });
        entry.mode = 'replace';
        state.entries.push(entry);
        return true;
      }

      const decision = decideWriteMode(unit);
      const span = document.createElement('span');
      span.setAttribute('dir', 'auto'); // 目标语言为 RTL（如阿拉伯语）时自动调整方向
      span.textContent = translation;
      span.style.color = settings.translationColor || '#3b82f6';

      if (decision.mode === MODE_BLOCK) {
        span.className = 'itr-bi itr-bi-block';
        // 插在锚点末尾：block 形态必须独占一行，放在文本节点之后会把尾随的
        // 内联兄弟挤走，所以统一追加到锚点末尾。
        decision.anchor.appendChild(span);
      } else {
        span.className = 'itr-bi';
        // inline 形态紧跟最后一个原文节点，保证与原文同一行盒
        const lastNode = unit.nodes[unit.nodes.length - 1];
        if (lastNode && lastNode.parentNode === decision.anchor) {
          lastNode.after(span);
        } else {
          decision.anchor.appendChild(span);
        }
      }

      entry.span = span;
      entry.mode = decision.mode;
      // 登记原文节点：框架（Vue 等）通过 nodeValue 改写文本时可以发现并重新翻译
      unit.nodes.forEach((n, i) => {
        state.nodeWatch.set(n, { original: entry.nodes[i].original, expected: entry.nodes[i].original });
      });
      state.entries.push(entry);
      // 延后到当前批次的 DOM 写入全部完成后再读取布局，避免每插入一条译文
      // 就同步触发一次样式与布局计算（长页面会因此产生明显的 layout thrashing）。
      state.pendingWriteChecks.push(span);

      return true;
    }

    // 批量校验译文节点是否实际显示。先完成所有 DOM 写入，再统一读取布局，
    // 保留诊断计数的同时，将多次写/读交错改为成批写入后成批读取。
    function verifyPendingWrites() {
      const spans = state.pendingWriteChecks.splice(0);
      for (const span of spans) {
        try {
          const attached = span.isConnected && document.documentElement.contains(span);
          const rect = span.getBoundingClientRect();
          if (!attached || rect.width === 0 || rect.height === 0) {
            state.unrenderedWrites = (state.unrenderedWrites || 0) + 1;
          } else {
            state.renderedWrites = (state.renderedWrites || 0) + 1;
          }
        } catch (e) { /* 忽略自检失败 */ }
      }
    }

    function requestConcurrency(settings, fallback) {
      const isAi = settings.provider === 'ai';
      const configured = isAi && settings.ai
        ? settings.ai.concurrency
        : settings.concurrency;
      const maximum = isAi ? 4 : 6;
      const value = Number(configured) || fallback;
      return Math.max(1, Math.min(value, maximum));
    }

    // -------------------------------------------------- 批量翻译 + 应用（观察器 / 重扫共用）

    async function translateAndApplyUnits(units, settings, hooks, gen) {
      const uniqueTexts = [...new Set(units.map((u) => u.text))];
      hooks.onProgress && hooks.onProgress(0, uniqueTexts.length);
      const results = new Map();
      const failedTexts = new Set();
      const batches = buildBatches(uniqueTexts, batchCapsFor(settings.provider));
      await runPool(batches, Math.min(2, requestConcurrency(settings, 2)), async (batch) => {
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
          if (failedTexts.has(unit.text)) addFailedUnit(unit);
          continue;
        }
        const ok = unit.attrUnit
          ? applyAttrUnit(unit, t, settings)
          : applyUnit(unit, t, settings);
        if (ok) applied++;
      }
      verifyPendingWrites();
      return { applied, failed: state.failedUnits.length };
    }

    // 收集阶段诊断：不做任何写回，只回报“为什么没收到单元”。
    // 供排障与开发期自检使用；正常翻译流程不调用。
    function diagnoseCollection() {
      const report = {
        bodyPresent: !!document.body,
        textNodesTotal: 0,
        textNodesInSkip: 0,
        textNodesInvisible: 0,
        textNodesTooShort: 0,
        textNodesCollected: 0,
        shadowHosts: 0,
        units: 0,
        samples: []
      };
      if (!document.body) return report;

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const raw = node.nodeValue || '';
        if (!raw.trim()) continue;
        report.textNodesTotal++;
        const parent = node.parentElement;
        if (!parent) { report.textNodesInSkip++; continue; }
        if (parent.closest(SKIP_SELECTOR)) { report.textNodesInSkip++; continue; }
        if (!isVisible(parent)) { report.textNodesInvisible++; continue; }
        const text = normalizeText(raw);
        if (!isTranslatableText(text)) { report.textNodesTooShort++; continue; }
        report.textNodesCollected++;
        if (report.samples.length < 5) report.samples.push(text.slice(0, 40));
      }

      try {
        report.shadowHosts = findShadowHosts(document.body).length;
      } catch (e) { /* 忽略 */ }

      // 逐层判定诊断：定位 visit() 在哪一步停住
      try {
        const body = document.body;
        report.bodyVisible = isVisible(body);
        report.bodyDisplay = css(body) && css(body).display;
        report.bodyChildren = body.children.length;
        const kids = [...body.children];
        report.blockChildCount = kids.filter((c) => BLOCK_DISPLAY_RE.test(css(c).display)).length;
        report.kidSamples = kids.slice(0, 6).map((c) => ({
          tag: c.tagName,
          display: css(c) && css(c).display,
          isBlock: BLOCK_DISPLAY_RE.test(css(c).display),
          visible: isVisible(c),
          inSkip: !!(c.closest && c.closest(SKIP_SELECTOR)),
          textLen: (c.textContent || '').length
        }));
      } catch (e) {
        report.layerError = (e && e.message) || String(e);
      }

      try {
        report.units = collectUnits(MAX_UNITS).length;
      } catch (e) {
        report.unitsError = (e && e.message) || String(e);
      }

      // 写回诊断：上次翻译留下的译文节点现在还在不在 DOM 里。
      // “徽章报告 N 块、页面却看不到译文”通常发生在这里：
      // 节点被站点框架整体重渲染顶掉，或插入到了不可见/脱离文档的位置。
      try {
        const spans = state.entries.filter((e) => e.span);
        report.entries = state.entries.length;
        report.spanEntries = spans.length;
        report.spansConnected = spans.filter((e) => e.span.isConnected).length;
        report.spansInDom = spans.filter((e) => e.span.isConnected && document.documentElement.contains(e.span)).length;
        report.spansVisible = spans.filter((e) => {
          if (!e.span.isConnected) return false;
          try {
            const r = e.span.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          } catch (err) { return false; }
        }).length;
        report.spanModes = spans.reduce((acc, e) => {
          acc[e.mode] = (acc[e.mode] || 0) + 1;
          return acc;
        }, {});
        report.spanSamples = spans.slice(0, 5).map((e) => ({
          mode: e.mode,
          connected: e.span.isConnected,
          inDoc: document.documentElement.contains(e.span),
          rect: (() => { const r = e.span.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
          len: (e.span.textContent || '').length,
          cls: e.span.className
        }));
        // 全文档兜底统计（不依赖 entries）
        report.domSpanCount = document.querySelectorAll('.itr-bi').length;
        report.renderedWrites = state.renderedWrites || 0;
        report.unrenderedWrites = state.unrenderedWrites || 0;
      } catch (e) {
        report.writeError = (e && e.message) || String(e);
      }
      return report;
    }

    // -------------------------------------------------- 主流程：整页翻译

    async function translate(settings, hooks) {
      if (state.translating) return { ok: false, error: '正在翻译中，请稍候' };
      if (!document.body) return { ok: false, error: '页面没有可翻译的内容' };

      state.translating = true;
      state.gen++;
      const gen = state.gen;
      clearFailed();
      state.renderedWrites = 0;
      state.unrenderedWrites = 0;
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
        const limit = requestConcurrency(settings, 3);
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
        // 单个单元写回失败（节点被站点框架移除、样式读取异常等）只记为失败，
        // 不能中断整页——否则前面已写好的译文会停在半成品状态。
        let appliedCount = 0;
        for (const unit of units) {
          if (gen !== state.gen) break;
          const t = results.get(unit.text);
          if (t === undefined) {
            if (failedTexts.has(unit.text)) addFailedUnit(unit);
            continue;
          }
          let ok = false;
          try {
            ok = unit.attrUnit
              ? applyAttrUnit(unit, t, settings)
              : applyUnit(unit, t, settings);
          } catch (e) {
            // 真正的写回异常：记为失败，等待用户重试
            ok = false;
            state.lastError = (e && e.message) || String(e);
            addFailedUnit(unit);
          }
          // 注意：applyUnit 在“译文为空 / 译文与原文相同”时返回 false，
          // 那是“无需翻译”（例如页面已是目标语言），不能计入失败。
          if (ok) appliedCount++;
        }
        verifyPendingWrites();

        if (!aborted && state.enabled) {
          // 动态监听挂载失败不应影响本次翻译结果：观察器只是增量能力，
          // 抛出去会把已经写好的译文状态留在中间态（徽章卡在“翻译中”）。
          try {
            startObserver(settings, hooks);
          } catch (e) {
            state.lastError = (e && e.message) || String(e);
          }
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
        clearFailed();
        return { ok: true, total: 0 };
      }

      state.translating = true;
      const gen = state.gen;
      try {
        hooks.onProgress(0, failed.length);
        const results = new Map();
        const batches = buildBatches([...new Set(failed.map((u) => u.text))]);
        await runPool(batches, Math.min(2, requestConcurrency(settings, 2)), async (batch) => {
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
        verifyPendingWrites();
        clearFailed();
        for (const unit of stillFailed) addFailedUnit(unit);
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
      state.pendingWriteChecks.length = 0;
      styleCache = new WeakMap();
      blockChildCache = new WeakMap();
      clearFailed();
      state.enabled = false;
      state.translating = false;
      return { ok: true };
    }

    return { state, translate, restore, retryFailed, rescan, diagnoseCollection };
  }

  global.ITRCore = { create };
})(typeof self !== 'undefined' ? self : this);
