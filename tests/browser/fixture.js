(() => {
  let listener, fail = false, delay = 35, cancellation = 0;
  const requests = [], shadows = new WeakMap(), originalAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(options) { const root = originalAttach.call(this, options); shadows.set(this, root); return root; };
  const translations = new Map([
    ['FIELD NOTES / THE ART OF NOTICING', '阅读札记 / 发现日常之美'],
    ['Finding wonder in the everyday.', '在平凡日常中，发现惊喜。'],
    ['There is a quiet kind of beauty in the ordinary. A morning walk, an open window, the way sunlight falls across a familiar room.', '平凡之中，自有一种安静的美。清晨的一次散步，一扇敞开的窗，还有阳光落在熟悉房间里的模样。'],
    ['Sometimes serendipity begins with a simple change of perspective.', '有时，不期而遇的美好，始于一次简单的视角转换。']
  ]);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  window.chrome = { runtime: {
    onMessage: { addListener(fn) { listener = fn; } },
    sendMessage: async message => {
      if (message.type === 'BOOT') return { ok: true, target: 'zh', autoSites: [], configured: true };
      if (message.type === 'CANCEL') { cancellation++; return { ok: true }; }
      if (message.type === 'TRANSLATE') {
        requests.push({ texts: message.texts, target: message.target }); await sleep(delay);
        if (fail) return { ok: false, error: '模拟 429：额度不足或请求限流' };
        return { ok: true, translations: message.texts.map(text => message.target === 'ar' ? 'اكتشف الجمال في تفاصيل الحياة اليومية.' : /已经是中文/.test(text) ? text : translations.get(text) || '译文：' + text), cached: 0 };
      }
      return { ok: true };
    },
    connect: () => {
      let handler, close, stopped = false;
      return { onMessage: { addListener(fn) { handler = fn; } }, onDisconnect: { addListener(fn) { close = fn; } }, disconnect() { stopped = true; close?.(); }, async postMessage() {
        for (const delta of ['语境含义\n', 'serendipity 指偶然发现美好事物的机缘。这里强调：改变看待日常的方式，可能带来意料之外的惊喜。\n\n', '词语用法\n/ˌserənˈdɪpəti/ · 名词，通常不可数。\n\n', '双语例句\nIt was pure serendipity that we met.\n我们的相遇，纯粹是一场美好的巧合。\n\n', 'A wrong turn led to a moment of serendipity.\n一次走错路，带来了一场意外的惊喜。']) { await sleep(80); if (stopped) return; handler({ delta }); }
        handler({ done: true });
      } };
    }
  } };
  const rpc = message => new Promise(resolve => listener(message, {}, resolve));
  const hostAfter = id => document.getElementById(id)?.querySelector(':scope > [data-lingoleaf="translation"]');
  const translated = id => shadows.get(hostAfter(id))?.querySelector('.text')?.textContent;
  const wait = async predicate => { const end = Date.now() + 6000; while (Date.now() < end) { if (predicate()) return; await sleep(40); } throw new Error('等待条件超时'); };
  const assert = (value, msg) => { if (!value) throw new Error(msg); document.getElementById('log').textContent += '\n✓ ' + msg; };
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('long').textContent = 'A long paragraph should never lose its final sentence. '.repeat(45) + 'UNIQUE_FINAL_SENTENCE.';
    const log = document.getElementById('log');
    document.getElementById('zh').onclick = () => rpc({ type: 'START', target: 'zh' });
    document.getElementById('ar').onclick = () => rpc({ type: 'START', target: 'ar' });
    document.getElementById('explain').onclick = () => rpc({ type: 'EXPLAIN', selection: 'serendipity', mode: 'api', target: 'zh' });
    document.getElementById('run').onclick = async event => {
      event.target.disabled = true; log.textContent = '正在验证…';
      try {
        await rpc({ type: 'RESTORE' }); requests.length = 0;
        const original = document.getElementById('lead').innerHTML;
        await rpc({ type: 'START', target: 'zh' });
        await wait(() => translated('inline') && translated('lead'));
        const cleanLead = document.getElementById('lead').cloneNode(true); cleanLead.querySelectorAll('[data-lingoleaf]').forEach(node => node.remove());
        assert(cleanLead.innerHTML === original, '保留原文 DOM 和原始内容');
        assert(translated('inline').includes('不期而遇'), '合并粗体、链接和普通文本，不丢失单词间隔');
        assert(!requests.flatMap(r => r.texts).some(t => /SECRET_MUST_NOT_SEND/.test(t)), '跳过隐藏内容、编辑框和代码');
        assert(!requests.flatMap(r => r.texts).some(t => t.includes('FAR_AWAY')), '屏幕之外的段落保持延迟翻译');
        await sleep(450);
        assert(requests.flatMap(r => r.texts).filter(t => t.startsWith('There is a quiet kind')).length === 1, '译文插入不会触发重复请求');
        document.getElementById('dynamic').textContent = 'UPDATED_DYNAMIC_TEXT';
        document.getElementById('dynamic').scrollIntoView({ block: 'center' });
        await wait(() => translated('dynamic')?.includes('UPDATED_DYNAMIC_TEXT'));
        assert(true, '动态更新替换过期译文');
        document.getElementById('hidden').hidden = false;
        document.getElementById('hidden').scrollIntoView({ block: 'center' });
        await wait(() => translated('hidden'));
        assert(true, '从隐藏变为可见的内容会被识别');
        document.getElementById('long').scrollIntoView({ block: 'center' });
        await wait(() => translated('long')?.includes('UNIQUE_FINAL_SENTENCE'));
        assert(true, '长段落分块后保留末尾内容');
        const unsafeHost = hostAfter('unsafe');
        assert(!shadows.get(unsafeHost)?.querySelector('img'), '模型输出按纯文本显示，不能注入 HTML');
        await rpc({ type: 'START', target: 'ar' });
        await wait(() => translated('long')?.startsWith('اكتشف'));
        assert(shadows.get(hostAfter('long')).querySelector('.translation').dir === 'rtl', '切换阿拉伯语时清除旧译文并使用 RTL');
        await rpc({ type: 'PAUSE' });
        const before = requests.length; document.getElementById('dynamic').textContent = 'PAUSED_CHANGED_TEXT'; await sleep(400);
        assert(requests.length === before && cancellation > 0, '暂停后停止识别与请求，并发出取消信号');
        await rpc({ type: 'RESTORE' });
        assert(!document.querySelector('[data-lingoleaf="translation"]'), '还原移除全部译文');
        window.scrollTo(0, 0); delay = 600; await rpc({ type: 'START', target: 'zh' });
        await wait(() => requests.length > before); await rpc({ type: 'RESTORE' }); await sleep(700);
        assert(!document.querySelector('[data-lingoleaf="translation"]'), '还原后丢弃迟到的翻译响应');
        delay = 35; fail = true; await rpc({ type: 'START', target: 'zh' });
        await wait(() => { const dock = document.querySelector('[data-lingoleaf="dock"]'); return shadows.get(dock)?.textContent.includes('模拟 429'); });
        assert(!(await rpc({ type: 'STATUS' })).active, 'API 错误显示原因并暂停，避免自动重试风暴');
        fail = false; await rpc({ type: 'RESTORE' });
        log.textContent += '\n\n全部 14 项网页链路检查通过。';
      } catch (error) { log.textContent += '\n✗ ' + error.message; }
      finally { event.target.disabled = false; }
    };
  });
})();
