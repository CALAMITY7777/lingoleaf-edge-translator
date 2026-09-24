(() => {
  const prose = 'A quiet morning offers space to think about the world around us. Reading a complete article helps us understand its ideas, follow the evidence, and discover connections between familiar experiences.';
  const chinese = '城市里的树木为行人提供阴凉，也为鸟类创造栖息的空间。研究人员记录了不同季节的变化，并邀请居民参加观察活动。通过持续的记录，人们逐渐理解了自然环境与日常生活之间的联系。';
  const article = (prefix = 'body') => `<article><header><h1 id="${prefix}-title">The art of close reading</h1></header><section class="article-body"><p id="${prefix}-one">${prefix.toUpperCase()}_ONE ${prose}</p><p id="${prefix}-two">${prefix.toUpperCase()}_TWO ${prose}</p><h2 id="${prefix}-heading">A useful observation</h2><ul><li id="${prefix}-item">ARTICLE_LIST_ITEM</li></ul><table><tr><td id="${prefix}-cell">ARTICLE_TABLE_CELL</td></tr></table></section><div class="related-posts"><p id="related">NOISE_RELATED ${prose.repeat(2)}</p></div><section id="comments"><p id="comment">NOISE_COMMENT ${prose.repeat(2)}</p></section></article>`;
  function setup(boot) {
    if (boot.autoSites === true) boot.autoSites = [location.origin];
    let listener;
    const requests = [], shadows = new WeakMap(), attach = Element.prototype.attachShadow;
    let delay = 25;
    Element.prototype.attachShadow = function(options) { const shadow = attach.call(this, options); shadows.set(this, shadow); return shadow; };
    window.chrome = { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async m => {
        if (m.type === 'BOOT') return { ok: true, target: 'zh', scope: 'page', configured: true, autoSites: [], ...boot };
        if (m.type === 'TRANSLATE') { requests.push(m); await new Promise(r => setTimeout(r, delay)); return { ok: true, translations: m.texts.map(t => '译文：' + t), cached: 0 }; }
        return { ok: true };
      }
    } };
    window.fixture = {
      rpc: m => new Promise(r => listener(m, {}, r)), requests,
      setDelay: d => { delay = d; },
      text: id => { const e = document.getElementById(id); const host = e?.querySelector(':scope > [data-lingoleaf="translation"]'); return shadows.get(host)?.querySelector('.text')?.textContent; },
      host: id => document.getElementById(id)?.querySelector(':scope > [data-lingoleaf="translation"]')
    };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async check => { const end = Date.now() + 6500; while (Date.now() < end) { if (await check()) return; await sleep(35); } throw new Error('等待条件超时'); };
  const frame = async (markup, boot = {}) => {
    const element = document.createElement('iframe'); element.title = '测试网页';
    const loaded = new Promise(r => element.onload = r);
    element.srcdoc = `<!doctype html><html><head><base href="${location.origin}/"><style>body{font:14px/1.5 system-ui;margin:16px}p{margin:8px 0}h1{font-size:23px}h2{font-size:17px}nav,aside,footer,.related-posts,#comments{font-size:12px}h1,h2{margin:9px 0}</style><script>(${setup.toString()})(${JSON.stringify(boot)})</script><script src="/extension/article-detector.js" defer></script><script src="/extension/content.js" defer></script></head><body>${markup}</body></html>`;
    document.getElementById('stage').replaceChildren(element); await loaded;
    return { w: element.contentWindow, d: element.contentDocument, q: element.contentWindow.fixture, detector: element.contentWindow.__lingoleafArticleDetector };
  };
  const log = document.getElementById('log'); let passed = 0;
  const assert = (ok, description) => { if (!ok) throw new Error(description); passed++; log.textContent += '\n✓ ' + description; log.scrollTop = log.scrollHeight; };
  document.getElementById('run').onclick = async event => {
    event.target.disabled = true; passed = 0; log.textContent = '正在运行…';
    try {
      let f = await frame(`<nav><p id="nav">NOISE_NAV Home and all sections</p></nav><main>${article()}<aside><p id="side">NOISE_SIDE ${prose.repeat(2)}</p></aside></main><footer><p id="foot">NOISE_FOOT Contact the newsroom</p></footer>`);
      let result = await f.detector.detect();
      assert(result && ['body-title','body-one','body-two','body-heading','body-item','body-cell'].every(id => f.detector.contains(result, f.d.getElementById(id))), '文章标题、正文、小标题、列表和表格均属于正文');
      assert(['nav','side','foot','related','comment'].every(id => !f.detector.contains(result, f.d.getElementById(id))), '导航、侧栏、页脚、推荐和评论被排除');
      await f.q.rpc({ type: 'START', target: 'zh', scope: 'article' });
      await wait(() => f.q.text('body-one') && f.q.text('body-title'));
      assert(!f.q.requests.flatMap(r => r.texts).some(t => t.includes('NOISE_')), '正文模式发送的翻译请求不含外围内容');
      const count = f.q.requests.length; await sleep(950);
      assert(f.q.requests.length === count, '插入译文不会重复触发正文识别或翻译');
      f.d.getElementById('body-one').textContent = 'UPDATED_ARTICLE ' + prose;
      await wait(() => f.q.text('body-one')?.includes('UPDATED_ARTICLE'));
      assert(true, '正文更新后替换过期译文');
      await f.q.rpc({ type: 'START', scope: 'page' });
      await wait(() => f.q.text('nav'));
      assert((await f.q.rpc({ type: 'STATUS' })).scope === 'page', '切换整页后可翻译导航');
      await f.q.rpc({ type: 'START', scope: 'article' });
      await wait(() => f.q.text('body-one'));
      assert(!f.q.text('nav'), '切回正文时清理整页模式的外围译文');
      const originalLead = f.d.getElementById('body-one').firstChild;
      await f.q.rpc({ type: 'START', scope: 'article', displayMode: 'replace' });
      await wait(() => f.q.text('body-one'));
      assert(f.q.host('body-one').title.includes('原文：') && originalLead.parentElement.hidden, '替换模式隐藏原文并支持悬停查看原文');
      await f.q.rpc({ type: 'RESTORE' });
      assert(f.d.getElementById('body-one').contains(originalLead) && originalLead.parentElement === f.d.getElementById('body-one'), '还原使用原始文本节点，不破坏网页内容');
      await f.q.rpc({ type: 'START', scope: 'article', displayMode: 'bilingual' });
      await wait(() => f.q.text('body-one'));
      await f.q.rpc({ type: 'PAUSE' }); const pausedCount = f.q.requests.length;
      f.d.getElementById('body-two').textContent = 'PAUSED_UPDATE ' + prose; await sleep(950);
      assert(f.q.requests.length === pausedCount, '暂停后不再识别或发送新增请求');
      await f.q.rpc({ type: 'START', scope: 'article' });
      f.d.getElementById('body-two').scrollIntoView({ block: 'center' });
      await wait(() => f.q.text('body-two')?.includes('PAUSED_UPDATE'));
      assert(true, '继续正文翻译会识别暂停期间的更新');
      await f.q.rpc({ type: 'RESTORE' });
      assert(!f.d.querySelector('[data-lingoleaf="translation"]'), '正文还原完整移除译文');

      f = await frame(`<main><header><h1 id="title">中文观察</h1></header><div class="entry-content"><p id="one">${chinese}</p><p id="two">${chinese}</p></div><div class="sidebar"><p id="side">${chinese.repeat(3)}</p></div></main>`);
      result = await f.detector.detect();
      assert(result && ['title','one','two'].every(id => f.detector.contains(result, f.d.getElementById(id))) && !f.detector.contains(result, f.d.getElementById('side')), '没有 article 标签时，依据正文容器与中文段落识别并包含标题');
      f = await frame(`<div><div id="prose"><h1>Plain markup</h1><div id="one">${prose}</div><div id="two">${prose}</div></div><aside>${prose.repeat(3)}</aside></div>`);
      result = await f.detector.detect();
      assert(result && f.detector.contains(result, f.d.getElementById('one')) && f.detector.contains(result, f.d.getElementById('two')), '缺少语义标签和正文类名时，依据文本密度识别');
      f = await frame(`<article><h1>Short news</h1><p id="short">${chinese.repeat(2)}</p></article>`);
      assert(Boolean(await f.detector.detect()), '有明确文章结构的短新闻也可识别');
      f = await frame(`<main>${[1,2,3].map(i => `<article><h2>Story ${i}</h2><p>${prose}</p><a href="#">Read more</a></article>`).join('')}</main>`);
      assert(await f.detector.detect() === null, '多篇文章卡片的列表页不误识别成单篇正文');
      await f.q.rpc({ type: 'START', scope: 'article' });
      await wait(async () => (await f.q.rpc({ type: 'STATUS' })).scopeNote.includes('未识别'));
      assert(f.q.requests.length === 0, '未找到正文时提示切换整页，且不调用 API');
      f = await frame(`<main>${Array.from({ length: 30 }, (_, i) => `<p><a href="#">Navigation destination ${i} ${prose}</a></p>`).join('')}</main>`);
      assert(await f.detector.detect() === null, '链接密集的首页不被视为正文');

      f = await frame('<nav><p>NOISE_NAV</p></nav><main id="mount"></main>');
      await f.q.rpc({ type: 'START', scope: 'article' });
      await wait(async () => (await f.q.rpc({ type: 'STATUS' })).scopeNote.includes('未识别'));
      f.d.getElementById('mount').innerHTML = article('loaded');
      await wait(() => f.q.text('loaded-one'));
      assert(true, '异步加载的正文出现后自动识别');
      f.d.getElementById('mount').innerHTML = article('route');
      await wait(() => f.q.text('route-one'));
      assert(!f.d.getElementById('loaded-one') && (await f.q.rpc({ type: 'STATUS' })).bodyFound, 'SPA 替换文章后重新识别并翻译新正文');

      f = await frame('<nav><p id="nav">NAV_PENDING_REQUEST</p></nav>' + article());
      f.q.setDelay(900);
      await f.q.rpc({ type: 'START', scope: 'page' });
      await wait(() => f.q.requests.length > 0);
      await f.q.rpc({ type: 'START', scope: 'article' });
      await wait(() => f.q.text('body-one'));
      assert(!f.q.text('nav'), '范围切换后丢弃整页模式迟到的响应');
      await f.q.rpc({ type: 'RESTORE' });
      f = await frame(article(), { scope: 'article', autoSites: true });
      await wait(() => f.q.text('body-one'));
      assert((await f.q.rpc({ type: 'STATUS' })).scope === 'article', '按网站自动翻译沿用正文范围');
      await f.q.rpc({ type: 'TOGGLE', settings: { target: 'zh', scope: 'article' } });
      assert(!(await f.q.rpc({ type: 'STATUS' })).active, '快捷键可暂停正文翻译');
      await f.q.rpc({ type: 'TOGGLE', settings: { target: 'zh', scope: 'article' } });
      assert((await f.q.rpc({ type: 'STATUS' })).active && (await f.q.rpc({ type: 'STATUS' })).scope === 'article', '快捷键继续时保留正文范围');
      log.textContent += `\n\n全部 ${passed} 项正文检查通过。`;
    } catch (e) { log.textContent += '\n✗ ' + e.message; }
    finally { log.scrollTop = log.scrollHeight; event.target.disabled = false; }
  };
})();
