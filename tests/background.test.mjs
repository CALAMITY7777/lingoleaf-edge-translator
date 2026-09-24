import test from 'node:test';
import assert from 'node:assert/strict';
const listeners = {}, saved = {}, sessionSaved = {}, registrations = [], access = [];
const storageArea = data => ({ setAccessLevel: async x => access.push(x.accessLevel), get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])), set: async patch => Object.assign(data, structuredClone(patch)), remove: async key => { delete data[key]; } });
const event = name => ({ addListener: fn => { listeners[name] = fn; } });
globalThis.chrome = {
  storage: {
    local: storageArea(saved),
    session: storageArea(sessionSaved)
  },
  runtime: { id: 'a'.repeat(32), getURL: path => 'chrome-extension://' + 'a'.repeat(32) + '/' + path, onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), onConnect: event('connect'), openOptionsPage: async () => {} },
  contextMenus: { onClicked: event('menu'), removeAll: fn => fn(), create: () => {} },
  tabs: { onRemoved: event('removed'), onUpdated: event('updated'), query: async () => [], sendMessage: async () => ({}), create: async () => {} },
  commands: { onCommand: event('command') },
  permissions: { contains: async () => true, onRemoved: event('permissionRemoved') },
  scripting: { unregisterContentScripts: async () => { registrations.length = 0; }, registerContentScripts: async scripts => registrations.push(...scripts) }
};
let calls = [], slow = false, stream = false;
globalThis.fetch = async (url, options) => {
  assert.ok(url.startsWith('https://api.deepseek.com/'));
  const body = options.body && JSON.parse(options.body);
  let texts = [];
  if (body?.messages[1]) { try { texts = JSON.parse(body.messages[1].content); } catch { texts = body.messages[1].content; } }
  const target = body?.messages[0].content.includes('Arabic') ? 'ar' : 'zh';
  calls.push({ body, texts: Array.isArray(texts) ? texts.map(t => t.text) : [], target });
  if (slow) await new Promise((_resolve, reject) => {
    if (options.signal.aborted) return reject(new Error('aborted'));
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  if (stream || body?.stream) return new Response(`data: {"choices":[{"index":0,"delta":{"content":"${body?.messages[0].content.includes('Translate the input') ? '流式译文' : '意思：偶然的惊喜'}"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: texts.map(({ text, id }) => ({ id, text: target + ':' + text })) }) } }] });
};
await import('../extension/background.js');
const trusted = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
const optionsPage = { id: chrome.runtime.id, url: chrome.runtime.getURL('options.html'), tab: { id: 88 } };
const page = { id: chrome.runtime.id, url: 'https://example.org/', tab: { id: 7 } };
const message = (body, sender = trusted) => new Promise(resolve => listeners.message(body, sender, resolve));

test('credentials stay in trusted extension storage and are excluded from content bootstrap', async () => {
  assert.deepEqual(access, ['TRUSTED_CONTEXTS', 'TRUSTED_CONTEXTS']);
  assert.equal((await message({ type: 'SAVE_SETTINGS', settings: { apiKey: 'sk-test-only-not-a-real-key' } }, optionsPage)).ok, true);
  assert.equal((await message({ type: 'GET_SETTINGS' }, page)).ok, false);
  assert.equal((await message({ type: 'SAVE_SETTINGS', settings: { apiKey: '' } }, page)).ok, false);
  assert.equal((await message({ type: 'GET_KEY' }, page)).ok, false);
  assert.equal((await message({ type: 'GET_KEY' }, trusted)).ok, false);
  assert.equal((await message({ type: 'GET_SETTINGS' }, optionsPage)).apiKey, undefined);
  assert.equal((await message({ type: 'GET_KEY' }, optionsPage)).apiKey, 'sk-test-only-not-a-real-key');
  const boot = await message({ type: 'BOOT' }, page);
  assert.equal(boot.apiKey, undefined); assert.equal(boot.configured, true);
  assert.equal(saved.deepseekApiKey, undefined); assert.equal(sessionSaved.deepseekApiKey, 'sk-test-only-not-a-real-key');
});
test('same-page duplicates are batched once, caches are language-specific', async () => {
  calls = [];
  assert.deepEqual((await message({ type: 'TRANSLATE', texts: ['one', 'one', 'two'], target: 'zh' }, page)).translations, ['zh:one', 'zh:one', 'zh:two']);
  assert.deepEqual(calls[0].texts, ['one', 'two']);
  await message({ type: 'TRANSLATE', texts: ['one'], target: 'zh' }, page);
  assert.equal(calls.length, 1);
  assert.deepEqual((await message({ type: 'TRANSLATE', texts: ['one'], target: 'ar' }, page)).translations, ['ar:one']);
  assert.equal(calls.length, 2);
});
test('cache eviction preserves cached entries included with new texts in the same request', async () => {
  await message({ type: 'CLEAR_CACHE' });
  for (let i = 0; i < 400; i += 5) await message({ type: 'TRANSLATE', texts: Array.from({ length: 5 }, (_, j) => String(i + j)), target: 'zh' }, page);
  const response = await message({ type: 'TRANSLATE', texts: ['0', 'new1', 'new2', 'new3', 'new4', 'new5'], target: 'zh' }, page);
  assert.deepEqual(response.translations, ['zh:0', 'zh:new1', 'zh:new2', 'zh:new3', 'zh:new4', 'zh:new5']);
});
test('switching translation scope preserves cached paragraph results and bootstrap scope', async () => {
  await message({ type: 'CLEAR_CACHE' }); calls = [];
  await message({ type: 'TRANSLATE', texts: ['article-cache-example'], target: 'zh' }, page);
  await message({ type: 'SAVE_SETTINGS', settings: { scope: 'article' } });
  const response = await message({ type: 'TRANSLATE', texts: ['article-cache-example'], target: 'zh' }, page);
  assert.equal(calls.length, 1); assert.equal(response.cached, 1);
  assert.equal((await message({ type: 'BOOT' }, page)).scope, 'article');
});
test('automatic translation registers only the authorized site pattern', async () => {
  await message({ type: 'SET_AUTO_SITE', origin: 'https://example.org', enabled: true });
  assert.equal(registrations.length, 1); assert.deepEqual(registrations[0].matches, ['https://example.org/*']);
  assert.deepEqual(registrations[0].js, ['article-detector.js', 'content.js']);
  await message({ type: 'SET_AUTO_SITE', origin: 'https://example.org', enabled: false }); assert.equal(registrations.length, 0);
});
test('tab cancellation aborts both active requests and removes queued work', async () => {
  await message({ type: 'CLEAR_CACHE' }); calls = []; slow = true;
  const pending = Array.from({ length: 3 }, (_, i) => message({ type: 'TRANSLATE', texts: ['cancel-' + i], target: 'zh' }, page));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 2);
  await message({ type: 'CANCEL' }, page);
  const results = await Promise.all(pending); slow = false;
  assert.ok(results.every(r => !r.ok)); assert.equal(calls.length, 2);
});
test('DeepSeek SSE is forwarded through the real explanation port handler', async () => {
  stream = true;
  let handler, closed; const events = [];
  const done = new Promise(resolve => { closed = resolve; });
  listeners.connect({ name: 'lingoleaf-explain', sender: page, onDisconnect: { addListener() {} }, onMessage: { addListener(fn) { handler = fn; } }, postMessage: e => events.push(e), disconnect: () => closed() });
  await handler({ selection: 'serendipity', context: 'an unexpected discovery' }); await done; stream = false;
  assert.deepEqual(events, [{ delta: '意思：偶然的惊喜' }, { done: true }]);
});
test('manual translator streams only from trusted extension pages with selected detail mode', async () => {
  let handler, closed; const events = [];
  const done = new Promise(resolve => { closed = resolve; });
  listeners.connect({ name: 'lingoleaf-manual', sender: { id: chrome.runtime.id, url: chrome.runtime.getURL('translate.html') }, onDisconnect: { addListener() {} }, onMessage: { addListener(fn) { handler = fn; } }, postMessage: e => events.push(e), disconnect: () => closed() });
  await handler({ text: 'Good morning.', target: 'zh', mode: 'annotated' }); await done;
  assert.deepEqual(events, [{ delta: '流式译文' }, { done: true }]);
  assert.match(calls.at(-1).body.messages[0].content, /at most three concise notes/);
  let rejected = false;
  listeners.connect({ name: 'lingoleaf-manual', sender: page, onDisconnect: { addListener() {} }, onMessage: { addListener() { throw new Error('untrusted handler registered'); } }, postMessage() {}, disconnect: () => { rejected = true; } });
  assert.equal(rejected, true);
});
test('remembering and clearing keys updates only dedicated credential storage', async () => {
  await message({ type: 'SAVE_SETTINGS', settings: { rememberKey: true } }, optionsPage);
  assert.equal(saved.deepseekApiKey, 'sk-test-only-not-a-real-key'); assert.equal(sessionSaved.deepseekApiKey, undefined);
  await message({ type: 'SET_AUTO_SITE', origin: 'https://example.org', enabled: true });
  assert.equal(saved.settings.apiKey, undefined);
  await message({ type: 'SAVE_SETTINGS', settings: { apiKey: '', rememberKey: false } }, optionsPage);
  assert.equal(saved.deepseekApiKey, undefined); assert.equal(sessionSaved.deepseekApiKey, undefined);
  const boot = await message({ type: 'BOOT' }, page);
  assert.equal(boot.configured, true); assert.equal(boot.provider, 'cloud');
});
