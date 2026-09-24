(() => {
  if (globalThis.__lingoleafArticleDetector) return;
  const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,dd,dt,div,article,section,main';
  const CONTAINERS = 'article,main,section,div,[role="main"],[itemprop~="articleBody"]';
  const EXCLUDE = 'nav,aside,footer,[role="navigation"],[role="complementary"],[role="contentinfo"],[role="dialog"],[data-lingoleaf],script,style,noscript,textarea,input,select,button,pre,code,svg,canvas,iframe,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[translate="no"],.notranslate';
  const NOISE = /(?:^|[\s_-])(?:nav(?:igation|bar)?|menu|sidebar|side-bar|related(?:posts|articles|content)?|recommend(?:ed|ations)?|comments?|commentlist|disqus|replies|reply|pagination|pager|breadcrumb|breadcrumbs|toc|table-of-contents|footer|site-header|masthead|cookie(?:s|banner)?|ads?|advert(?:isement|ising)?|social|share|sharing|newsletter|toolbar|widget|promo|modal|paywall)(?:$|[\s_-])/i;
  const CONTENT = /(?:^|[\s_-])(?:article(?:-body|-content)?|post(?:-body|-content)?|entry-content|story(?:-body|-content)?|content-body|正文)(?:$|[\s_-])/i;
  const identity = e => `${e.id || ''} ${e.getAttribute('class') || ''}`.replace(/([a-z])([A-Z])/g, '$1-$2');
  const semantic = e => e.matches('article,[itemprop~="articleBody"]') || CONTENT.test(identity(e));
  function excluded(element) {
    for (let e = element; e && e !== document.documentElement; e = e.parentElement) {
      if (e.matches(EXCLUDE) || NOISE.test(identity(e))) return true;
      if (e.tagName === 'HEADER' && !e.closest('article,main,[role="main"]')) return true;
    }
    return false;
  }
  function visible(e) {
    if (!e?.isConnected || !e.getClientRects().length) return false;
    const style = getComputedStyle(e);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }
  const idle = () => new Promise(resolve => (window.requestIdleCallback || (fn => setTimeout(fn, 8)))(resolve, { timeout: 150 }));
  async function detect(cancelled = () => false) {
    if (!document.body) return null;
    const blocks = new Map(), candidates = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) return node.matches(EXCLUDE) || NOISE.test(identity(node)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let node, count = 0;
    while ((node = walker.nextNode())) {
      if (++count % 200 === 0) { await idle(); if (cancelled()) return null; }
      // Bound work on infinite feeds; inspect the beginning of the document first.
      if (count > 20000) break;
      const element = node.parentElement.closest(BLOCKS);
      if (!element || excluded(element) || !visible(node.parentElement)) continue;
      let b = blocks.get(element);
      if (!b) { b = { element, text: '', links: 0 }; blocks.set(element, b); }
      b.text += node.nodeValue;
      if (node.parentElement.closest('a')) b.links += node.nodeValue.trim().length;
    }
    count = 0;
    for (const b of blocks.values()) {
      if (++count % 100 === 0) { await idle(); if (cancelled()) return null; }
      const text = b.text.replace(/\s+/g, ' ').trim(), length = text.length;
      if (length < 2 || !/\p{L}/u.test(text)) continue;
      const prose = !/^H[1-6]$/.test(b.element.tagName) && length >= 45 && b.links / length < .35;
      const weight = prose ? Math.min(length, 1800) + Math.min((text.match(/[.!?。！？؛،]/g) || []).length, 12) * 12 : 0;
      let ancestor = b.element, hops = 0;
      while (ancestor && ancestor !== document.body && hops++ < 9) {
        if (ancestor.matches(CONTAINERS)) {
          let c = candidates.get(ancestor);
          if (!c) { c = { root: ancestor, chars: 0, links: 0, prose: 0, paragraphs: 0, weight: 0, heading: false }; candidates.set(ancestor, c); }
          c.chars += length; c.links += b.links;
          if (prose) { c.prose += length; c.paragraphs++; c.weight += weight; }
          if (b.element.tagName === 'H1') c.heading = true;
        }
        ancestor = ancestor.parentElement;
      }
    }
    const ranked = [];
    for (const c of candidates.values()) {
      const isArticle = semantic(c.root), density = c.links / Math.max(1, c.chars);
      if (density > .38 || !(c.paragraphs >= 2 && c.prose >= 160 || isArticle && c.prose >= 100)) continue;
      // A feed of separate articles is not one article, even inside <main>.
      const articles = [...c.root.querySelectorAll('article')].filter(e => candidates.get(e)?.prose >= 100 && !excluded(e));
      const topArticles = articles.filter(e => !articles.some(other => other !== e && other.contains(e)));
      if (topArticles.length > 1) continue;
      let depth = 0; for (let e = c.root; e; e = e.parentElement) depth++;
      c.score = Math.min(c.weight, 14000) * (1 - density) * (isArticle ? 1.4 : c.root.matches('main,[role="main"]') ? 1.15 : 1) + (c.heading ? 100 : 0) + depth;
      ranked.push(c);
    }
    ranked.sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || cancelled()) return null;
    // Two similarly strong, disjoint stories usually indicate a listing page.
    if (ranked.some(c => c !== best && !best.root.contains(c.root) && !c.root.contains(best.root) && c.score >= best.score * .72)) return null;
    const roots = [best.root];
    if (!best.root.querySelector('h1')) {
      const surrounding = best.root.parentElement?.closest('article,main,[role="main"]');
      if (surrounding && surrounding.querySelectorAll('h1').length === 1) {
        const title = surrounding.querySelector('h1');
        if (!excluded(title) && visible(title)) roots.unshift(title);
      }
    }
    return { roots, title: roots.map(e => e.matches('h1') ? e : e.querySelector('h1')).find(Boolean)?.textContent.trim().slice(0, 120) || '', paragraphs: best.paragraphs };
  }
  function contains(result, element) {
    return Boolean(result?.roots.some(root => root.isConnected && (root === element || root.contains(element))) && !excluded(element));
  }
  globalThis.__lingoleafArticleDetector = Object.freeze({ detect, contains });
})();
