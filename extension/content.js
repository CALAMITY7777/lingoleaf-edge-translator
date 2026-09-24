(() => {
  if (globalThis.__lingoleafLoaded) return;
  globalThis.__lingoleafLoaded = true;
  const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,dd,dt,div,article,section,main';
  const SKIP = 'script,style,noscript,textarea,input,select,button,pre,code,kbd,samp,svg,canvas,iframe,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="button"],[hidden],[aria-hidden="true"],[translate="no"],.notranslate';
  const names = { zh: '中文', en: 'English', fr: 'Français', ru: 'Русский', es: 'Español', ar: 'العربية' };
  const records = new Map(), owned = new WeakSet(), roots = new Set();
  let active = false, target = 'zh', generation = 0, queue = [], running = false, requested = 0, cacheHits = 0;
  let scope = 'page', displayMode = 'bilingual', article = null, articleDirty = true, detectionAt = 0, scopeNote = '';
  const detector = globalThis.__lingoleafArticleDetector;
  const inScope = element => scope === 'page' || Boolean(detector?.contains(article, element));
  let notice = '', scanTimer, pumpTimer, scanning = false, observer, viewport, dock, panel, port, restoreFocus;
  let lastSelection = { text: '', context: '' };
  const send = async message => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '扩展连接已失效，请刷新网页。');
    return result;
  };
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  const ours = node => {
    let e = node.nodeType === 1 ? node : node.parentElement;
    while (e) { if (owned.has(e)) return true; e = e.parentElement; }
    return false;
  };
  const owner = node => node.parentElement?.closest(BLOCKS);
  function readable(element) {
    if (!element?.isConnected || ours(element) || element.closest(SKIP)) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
  }
  function textOf(element, respectScope = true) {
    const replaced = records.get(element);
    if (replaced?.replacement) return normalize(replaced.replacement.nodes.map(node => node.nodeValue || '').join(''));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts = []; let node;
    while ((node = walker.nextNode())) {
      if (!ours(node) && !node.parentElement.closest(SKIP) && owner(node) === element && readable(node.parentElement) && (!respectScope || inScope(node.parentElement))) parts.push(node.nodeValue);
    }
    return normalize(parts.join(''));
  }
  function split(text) {
    const chunks = [];
    while (text.length > 1100) {
      let at = Math.max(text.lastIndexOf('。', 1099), text.lastIndexOf('. ', 1099), text.lastIndexOf(' ', 1099));
      at = at < 550 ? 1100 : at + 1;
      if (/[\uD800-\uDBFF]/.test(text[at - 1])) at--;
      chunks.push(text.slice(0, at).trim()); text = text.slice(at).trim();
    }
    if (text) chunks.push(text);
    return chunks;
  }
  const idle = () => new Promise(resolve => (window.requestIdleCallback || (fn => setTimeout(fn, 8)))(resolve, { timeout: 150 }));
  function schedule(root = document.body) {
    if (!active || !root) return;
    if (root.nodeType !== 1) root = root.parentElement;
    if (!root || ours(root)) return;
    roots.add(root);
    if (!scanTimer) scanTimer = setTimeout(scan, 160);
  }
  async function scan() {
    scanTimer = null;
    if (scanning || !active) return;
    scanning = true;
    const epoch = generation;
    try {
      if (scope === 'article' && articleDirty) {
        const delay = detectionAt + 750 - performance.now();
        if (detectionAt && delay > 0) { scanTimer = setTimeout(scan, delay); return; }
        articleDirty = false;
        scopeNote = '正在识别正文…'; updateDock();
        const result = await detector?.detect(() => epoch !== generation || !active);
        if (epoch !== generation || !active) return;
        article = result || null; detectionAt = performance.now();
        scopeNote = article ? '' : '未识别到明确正文，可切换整页翻译';
        for (const [element, record] of records) if (!inScope(element)) drop(element, record);
        article?.roots.forEach(root => roots.add(root));
      }
      const pending = [...roots]; roots.clear();
      if (scope === 'article' && !article) { updateDock(); return; }
      const candidates = new Set();
      for (const root of pending) {
        if (!root.isConnected) continue;
        if (scope === 'article' && !article.roots.some(r => r === root || r.contains(root) || root.contains(r))) continue;
        const ancestor = root.closest(BLOCKS); if (ancestor) candidates.add(ancestor);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (node.nodeType === 1) return ours(node) || node.matches(SKIP) || scope === 'article' && !article.roots.some(r => r.contains(node) || node.contains(r)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
            return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          }
        });
        let node, n = 0;
        while ((node = walker.nextNode())) {
          const element = owner(node); if (element) candidates.add(element);
          if (++n % 200 === 0) { await idle(); if (epoch !== generation || !active) return; }
        }
      }
      let n = 0;
      for (const element of candidates) {
        if (epoch !== generation || !active) return;
        const old = records.get(element);
        if (!readable(element) || !inScope(element)) { if (old) drop(element, old); continue; }
        const text = textOf(element);
        if (text.length < 2 || !/\p{L}/u.test(text)) { if (old) drop(element, old); continue; }
        if (old?.text === text) { if (old.output.some(Boolean) && !old.host?.isConnected) render(old); continue; }
        if (old) drop(element, old);
        if (records.size >= 2000) { notice = '页面较长，已识别 2000 个段落；可还原后重新开始。'; continue; }
        const record = { element, text, chunks: split(text), output: [], states: [], version: crypto.randomUUID(), host: null, visible: false };
        records.set(element, record); viewport.observe(element);
        if (++n % 60 === 0) { await idle(); if (epoch !== generation) return; }
      }
      for (const [element, record] of records) if (!element.isConnected) drop(element, record);
      if (scope === 'article') records.forEach(enqueue);
      updateDock();
    } finally {
      scanning = false;
      if ((roots.size || scope === 'article' && articleDirty) && active && !scanTimer) scanTimer = setTimeout(scan, 160);
    }
  }
  function clearPresentation(record) {
    record.host?.remove(); record.host = null; record.textNode = null; record.box = null;
    if (record.replacement) {
      for (const wrapper of record.replacement.wrappers) if (wrapper.isConnected) wrapper.replaceWith(...wrapper.childNodes);
      record.replacement = null;
    }
  }
  function drop(element, record) { viewport?.unobserve(element); clearPresentation(record); records.delete(element); }
  function enqueue(record) {
    if (!active || !record.visible || !readable(record.element) || !inScope(record.element)) return;
    record.chunks.forEach((text, index) => {
      if (record.states[index]) return;
      record.states[index] = 'queued'; queue.push({ record, index, text, version: record.version });
    });
    clearTimeout(pumpTimer); pumpTimer = setTimeout(pump, 70);
  }
  async function pump() {
    if (!active || running || scope === 'article' && (articleDirty || scanning)) return;
    queue = queue.filter(job => records.get(job.record.element) === job.record && job.record.version === job.version && job.record.element.isConnected && inScope(job.record.element));
    // Closest paragraphs first; scrolling away leaves them for a later pass.
    queue.sort((a, b) => Math.abs(a.record.element.getBoundingClientRect().top) - Math.abs(b.record.element.getBoundingClientRect().top));
    const batch = []; let chars = 0;
    for (let i = 0; i < queue.length && batch.length < 6;) {
      const job = queue[i];
      if (!job.record.visible || !readable(job.record.element)) { i++; continue; }
      if (chars + job.text.length > 6000) break;
      chars += job.text.length; batch.push(job); queue.splice(i, 1);
    }
    if (!batch.length) { updateDock(); return; }
    if (requested + chars > 60000) {
      batch.forEach(job => { job.record.states[job.index] = undefined; });
      pause('本轮已达到 6 万字符上限，点击继续可开启下一轮。'); requested = 0; return;
    }
    requested += chars; running = true;
    batch.forEach(job => { job.record.states[job.index] = 'pending'; });
    const epoch = generation; updateDock();
    try {
      const result = await send({ type: 'TRANSLATE', texts: batch.map(job => job.text), target });
      if (epoch !== generation || !active) return;
      cacheHits += result.cached || 0;
      batch.forEach((job, index) => {
        if (records.get(job.record.element) !== job.record || job.record.version !== job.version || textOf(job.record.element) !== job.record.text) { schedule(job.record.element); return; }
        job.record.output[job.index] = result.translations[index]; job.record.states[job.index] = 'done'; render(job.record);
      });
    } catch (e) {
      if (epoch === generation && active) {
        batch.forEach(job => { job.record.states[job.index] = undefined; }); pause(e.message);
      }
    } finally {
      running = false; updateDock();
      if (active) { clearTimeout(pumpTimer); pumpTimer = setTimeout(pump, 90); }
    }
  }
  function render(record) {
    if (!record.element.isConnected || !inScope(record.element)) { clearPresentation(record); return; }
    const complete = record.chunks.every((_, i) => record.states[i] === 'done');
    if (!complete) return;
    const text = record.output.join('\n');
    if (normalize(text) === record.text) { clearPresentation(record); return; }
    if (!record.host) {
      record.host = document.createElement('span'); owned.add(record.host);
      record.host.setAttribute('data-lingoleaf', 'translation'); record.host.setAttribute('translate', 'no');
      record.host.style.cssText = 'display:inline!important;direction:ltr!important;font-size:.86em!important;line-height:inherit!important;';
      const shadow = record.host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `<style>:host{display:inline;direction:ltr}.translation{display:inline;color:light-dark(#376f60,#b8dfd2);font:500 1em/1.55 system-ui,"Segoe UI",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;animation:arrive .18s ease-out;color-scheme:light dark}.bilingual::before{content:" · ";opacity:.45;margin-inline:.18em}.replace{color:inherit;font-weight:inherit;border-bottom:1px dotted color-mix(in srgb,currentColor 32%,transparent);cursor:help}@keyframes arrive{from{opacity:0}to{opacity:1}}@media(prefers-reduced-motion:reduce){.translation{animation:none}}</style><span class="translation"><span class="text"></span></span>`;
      record.textNode = shadow.querySelector('.text'); record.box = shadow.querySelector('.translation');
    }
    record.textNode.textContent = text; record.box.lang = target; record.box.dir = target === 'ar' ? 'rtl' : 'auto';
    record.box.classList.toggle('bilingual', displayMode === 'bilingual'); record.box.classList.toggle('replace', displayMode === 'replace');
    if (!record.host.isConnected) {
      if (displayMode === 'replace') {
        const nodes = [], walker = document.createTreeWalker(record.element, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) if (!ours(node) && !node.parentElement.closest(SKIP) && owner(node) === record.element && readable(node.parentElement)) nodes.push(node);
        const wrappers = nodes.map(node => {
          const wrapper = document.createElement('span'); owned.add(wrapper); wrapper.hidden = true;
          wrapper.setAttribute('data-lingoleaf-original', ''); node.before(wrapper); wrapper.append(node); return wrapper;
        });
        record.replacement = { nodes, wrappers };
        record.host.title = `原文：${record.text}`; record.host.tabIndex = 0; record.host.setAttribute('aria-label', `译文：${text}。原文：${record.text}`);
      }
      record.element.append(record.host);
    }
  }
  function createShell(kind) {
    const host = document.createElement('div'); owned.add(host);
    host.setAttribute('translate', 'no'); host.setAttribute('data-lingoleaf', kind);
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host{all:initial;color-scheme:light}*{box-sizing:border-box}button,select{font:inherit}button{cursor:pointer}button:focus-visible,select:focus-visible{outline:3px solid #88bcb0;outline-offset:3px}button{border:0;transition:background .18s,transform .18s}button:hover{filter:brightness(.97)}button:active{transform:scale(.97)}button:disabled{opacity:.5;cursor:default}.surface{font:13px/1.55 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#243e35;background:#fcfdf9;border:1px solid #dbe7df;box-shadow:0 14px 55px #183f2926;border-radius:18px;animation:in .22s ease-out}.brand{font-size:12px;font-weight:700;letter-spacing:.02em}.primary{background:#286550;color:white;border-radius:10px;padding:9px 13px}.quiet{background:#edf3ed;color:#376451;border-radius:9px;padding:7px 11px}.close{width:30px;height:30px;background:transparent;color:#687c70;border-radius:50%;font-size:20px}.muted{color:#708175;font-size:12px}.error{color:#a44837}.row{display:flex;align-items:center;gap:9px}.spacer{flex:1}.hidden{display:none!important}@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    </style>`;
    document.documentElement.append(host); return { host, shadow };
  }
  function ensureDock() {
    if (dock?.host.isConnected) return;
    dock = createShell('dock'); dock.host.style.setProperty('bottom', '22px', 'important'); dock.host.style.setProperty('right', '22px', 'important');
    dock.shadow.innerHTML += `<style>.surface{padding:12px 15px;max-width:min(460px,calc(100vw - 36px))}.dot{width:7px;height:7px;border-radius:50%;background:#66a47c}.status{font-size:11px;max-width:340px;margin-top:6px;overflow-wrap:anywhere}.toggle{white-space:nowrap}</style><div class="surface" role="region" aria-label="轻译翻译控制"><div class="row"><span class="dot"></span><span class="brand">轻译</span><span class="label muted"></span><span class="spacer"></span><button class="quiet toggle">暂停</button><button class="close" title="还原网页并关闭" aria-label="还原网页并关闭">×</button></div><div class="status" role="status"></div></div>`;
    dock.shadow.querySelector('.toggle').onclick = () => active ? pause() : start(target, scope, displayMode);
    dock.shadow.querySelector('.close').onclick = () => restore();
  }
  function status() {
    let translated = 0;
    records.forEach(r => { if (r.chunks.every((_, i) => r.states[i] === 'done')) translated++; });
    return { active, target, scope, displayMode, bodyFound: Boolean(article), scopeNote, translated, detected: records.size, cached: cacheHits, running, notice };
  }
  function updateDock() {
    if (!dock) return;
    const s = status();
    dock.shadow.querySelector('.label').textContent = `${scope === 'article' ? '仅正文' : '整页'} · ${displayMode === 'replace' ? '替换' : '对照'} → ${names[target]}`;
    dock.shadow.querySelector('.toggle').textContent = active ? '暂停' : '继续';
    const el = dock.shadow.querySelector('.status');
    el.textContent = notice || scopeNote || `${running && active ? '正在翻译 · ' : active ? '随阅读翻译 · ' : '已暂停 · '}${s.translated} / ${s.detected} 段已处理`;
    el.classList.toggle('error', Boolean(notice));
  }
  function pause(reason = '') {
    active = false; generation++; notice = reason; queue = [];
    clearTimeout(scanTimer); scanTimer = null; clearTimeout(pumpTimer); roots.clear();
    observer?.disconnect(); viewport?.disconnect();
    records.forEach(r => r.states = r.states.map(s => s === 'done' ? s : undefined));
    send({ type: 'CANCEL' }).catch(() => {}); updateDock();
  }
  function restore() {
    pause(); records.forEach(clearPresentation); records.clear();
    article = null; articleDirty = true; detectionAt = 0; scopeNote = '';
    requested = 0; cacheHits = 0; dock?.host.remove(); dock = null;
  }
  function start(nextTarget, nextScope = scope, nextDisplayMode = displayMode) {
    nextScope = nextScope === 'article' ? 'article' : 'page';
    nextDisplayMode = nextDisplayMode === 'replace' ? 'replace' : 'bilingual';
    if (nextTarget !== target || nextScope !== scope || nextDisplayMode !== displayMode) { restore(); target = nextTarget; scope = nextScope; displayMode = nextDisplayMode; }
    if (active) return;
    articleDirty = true; detectionAt = 0; scopeNote = scope === 'article' ? '正在识别正文…' : '';
    active = true; generation++; notice = ''; ensureDock();
    viewport = new IntersectionObserver(entries => {
      for (const entry of entries) { const record = records.get(entry.target); if (record) { record.visible = entry.isIntersecting; if (entry.isIntersecting) enqueue(record); } }
    }, { rootMargin: '350px 0px' });
    records.forEach(r => viewport.observe(r.element));
    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (ours(mutation.target)) continue;
        if (mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].length && [...mutation.addedNodes, ...mutation.removedNodes].every(ours)) continue;
        // Rescan the containing block so text split across inline nodes stays together.
        const root = mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target;
        if (scope === 'article') articleDirty = true;
        schedule(root.closest?.(BLOCKS) || root);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'contenteditable', 'translate'] });
    schedule(document.body); updateDock();
  }
  function selectionContext(selection) {
    const live = window.getSelection();
    const node = live?.anchorNode;
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const container = element?.closest(BLOCKS);
    const context = container && !ours(container) && !container.closest(SKIP) ? textOf(container, false) : '';
    const index = context.indexOf(selection);
    return context.slice(Math.max(0, index - 600), Math.max(0, index - 600) + 1800);
  }
  document.addEventListener('contextmenu', event => {
    if (ours(event.target)) return;
    const text = window.getSelection()?.toString().trim() || '';
    lastSelection = { text, context: selectionContext(text) };
  }, { capture: true, passive: true });
  function closePanel() { port?.disconnect(); port = null; panel?.host.remove(); panel = null; restoreFocus?.focus?.(); }
  async function explain(selection, mode, explanationTarget) {
    closePanel(); restoreFocus = document.activeElement;
    const context = lastSelection.text.slice(0, 3000) === selection ? lastSelection.context : selectionContext(selection);
    panel = createShell('explanation');
    panel.host.style.setProperty('right', '24px', 'important'); panel.host.style.setProperty('top', 'max(24px, 9vh)', 'important');
    const current = panel;
    current.shadow.innerHTML += `<style>.surface{width:min(390px,calc(100vw - 40px));max-height:80vh;display:flex;flex-direction:column;overflow:hidden}.head{padding:18px 20px;border-bottom:1px solid #e5ebe2}.eyebrow{color:#819487;font-size:10px;letter-spacing:.15em;margin-bottom:8px}.word{font-size:24px;font-weight:600;line-height:1.45;overflow-wrap:anywhere;max-height:120px;overflow:auto;margin:12px 0 4px}.body{padding:20px;overflow:auto;min-height:130px;white-space:pre-wrap;line-height:1.85;font-size:14px;overflow-wrap:anywhere}.footer{padding:14px 20px;background:#f4f7f0;border-top:1px solid #e5ebe2}.result-actions{margin-top:10px}.feedback{font-size:11px;color:#758979;min-height:17px;margin-top:8px}.source{color:#738373;font-size:11px}.loader{animation:pulse 1.2s infinite}@keyframes pulse{50%{opacity:.4}}</style><section class="surface" role="dialog" aria-label="智能词语解释" aria-modal="false"><div class="head"><div class="row"><span class="brand">◈ LingoLeaf</span><span class="spacer"></span><button class="close" aria-label="关闭解释">×</button></div><div class="word" dir="auto"></div><div class="source">结合上下文，理解每一个词</div></div><div class="body" dir="auto"><span class="loader">正在思考这个表达…</span></div><div class="footer"><div class="row"><button class="primary web">复制问题并打开 ChatGPT ↗</button><button class="quiet retry">重试</button></div><div class="row result-actions"><button class="quiet copy">复制解释</button><button class="quiet settings">连接设置</button></div><div class="feedback" role="status"></div></div></section>`;
    current.shadow.querySelector('.word').textContent = selection;
    const body = current.shadow.querySelector('.body'), feedback = current.shadow.querySelector('.feedback');
    body.lang = explanationTarget; if (explanationTarget === 'ar') body.dir = 'rtl';
    current.shadow.querySelector('.close').onclick = closePanel;
    current.shadow.querySelector('.close').focus();
    current.shadow.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } });
    current.shadow.querySelector('.settings').onclick = () => send({ type: 'OPEN_OPTIONS' }).catch(e => feedback.textContent = e.message);
    let output = '';
    current.shadow.querySelector('.copy').onclick = async () => {
      try { if (!output) throw new Error('解释尚未生成。'); await navigator.clipboard.writeText(output); feedback.textContent = '解释已复制'; }
      catch (e) { feedback.textContent = e.message; }
    };
    current.shadow.querySelector('.web').onclick = async () => {
      try {
        const data = await send({ type: 'WEB_PROMPT', selection, context, target: explanationTarget });
        try { await navigator.clipboard.writeText(data.prompt); feedback.textContent = '已复制；在 ChatGPT 中粘贴并发送。'; }
        catch { body.textContent = data.prompt; feedback.textContent = '请选中上方问题并手动复制到 ChatGPT。'; }
        await send({ type: 'OPEN_CHATGPT' });
      } catch (e) { feedback.textContent = e.message; }
    };
    const run = () => {
      port?.disconnect(); output = ''; feedback.textContent = ''; body.textContent = '正在思考这个表达…';
      const channel = chrome.runtime.connect({ name: 'lingoleaf-explain' }); port = channel; let finished = false;
      channel.onMessage.addListener(event => {
        if (panel !== current || port !== channel) return;
        if (event.delta) { output += event.delta; body.textContent = output; }
        if (event.error) { finished = true; if (!output) body.textContent = event.error; feedback.textContent = event.error; }
        if (event.done) { finished = true; feedback.textContent = '解释完成 · AI 生成'; }
      });
      channel.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (panel === current && port === channel && !finished) feedback.textContent = '连接已断开，请重试。';
      });
      channel.postMessage({ selection, context });
    };
    current.shadow.querySelector('.retry').onclick = run;
    if (mode === 'web') {
      body.textContent = '在你已登录的 ChatGPT 中继续理解这个表达。\n\n点击下方按钮复制包含上下文的问题，再粘贴到 ChatGPT 并发送。';
      current.shadow.querySelector('.retry').classList.add('hidden'); current.shadow.querySelector('.result-actions').classList.add('hidden');
    } else run();
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    switch (message.type) {
      case 'PING': reply({ ok: true }); break;
      case 'STATUS': reply({ ok: true, ...status() }); break;
      case 'START': start(message.target || target, message.scope || scope, message.displayMode || displayMode); reply({ ok: true, ...status() }); break;
      case 'PAUSE': pause(); reply({ ok: true, ...status() }); break;
      case 'RESTORE': restore(); reply({ ok: true, ...status() }); break;
      case 'TOGGLE': active ? pause() : start(message.settings?.target || target, message.settings?.scope || scope, message.settings?.displayMode || displayMode); reply({ ok: true }); break;
      case 'EXPLAIN': explain(message.selection, message.mode, message.target); reply({ ok: true }); break;
      default: return false;
    }
  });
  send({ type: 'BOOT' }).then(s => {
    if (generation) return; // A manual start may have arrived while settings were loading.
    target = s.target; scope = s.scope === 'article' ? 'article' : 'page'; displayMode = s.displayMode === 'replace' ? 'replace' : 'bilingual';
    if (s.configured && s.autoSites.includes(location.origin)) start(target, scope, displayMode);
  }).catch(() => {});
})();
