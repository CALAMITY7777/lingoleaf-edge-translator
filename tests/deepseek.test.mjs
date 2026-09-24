import test from 'node:test';
import assert from 'node:assert/strict';
import { requestBody, parseTranslations, complete, checkKey, readSSE, explanationDeltas, importKey } from '../extension/deepseek.js';
const valid = { texts: ['Hello'], target: 'zh', model: 'deepseek-v4-flash' };
const key = 'sk-test-only-not-a-real-key';
const reply = entries => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: entries }) } }] });
const sse = events => new Response(events.map(e => 'data: ' + (e === '[DONE]' ? e : JSON.stringify(e)) + '\n\n').join(''));
const chunk = (content, finish_reason = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });

test('all six languages use DeepSeek Chat Completions JSON mode without thinking', () => {
  for (const target of ['zh', 'en', 'fr', 'ru', 'es', 'ar']) {
    const body = requestBody({ ...valid, target }, 'translate');
    assert.equal(body.response_format.type, 'json_object'); assert.equal(body.thinking.type, 'disabled');
    assert.match(body.messages[0].content, /JSON/); assert.match(body.messages[0].content, /"translations"/);
    assert.equal(body.messages[1].content, '[{"id":0,"text":"Hello"}]');
    assert.equal(body.max_tokens, 5500); assert.equal(body.store, undefined); assert.equal(body.input, undefined);
  }
});
test('DeepSeek input bounds, output ordering, empty JSON and truncated output are checked', () => {
  assert.throws(() => requestBody({ ...valid, target: '__proto__' }, 'translate'));
  assert.throws(() => requestBody({ ...valid, texts: ['x'.repeat(1201)] }, 'translate'));
  assert.throws(() => requestBody({ ...valid, texts: Array(7).fill('x') }, 'translate'));
  assert.deepEqual(parseTranslations(reply([{ id: 1, text: '乙' }, { id: 0, text: '甲' }]), 2), ['甲', '乙']);
  assert.throws(() => parseTranslations(reply([{ id: 0, text: '甲' }, { id: 0, text: '重复' }]), 2));
  assert.throws(() => parseTranslations({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, 1), /未完成/);
  assert.throws(() => parseTranslations({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }, 1), /空内容/);
  assert.throws(() => parseTranslations({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] }, 1), /JSON/);
});
test('manual translation has three bounded output modes and plain mode forbids commentary', () => {
  for (const mode of ['plain', 'annotated', 'detailed']) {
    const body = requestBody({ text: 'A thoughtful sentence.', target: 'zh', model: 'deepseek-v4-flash', mode }, 'manual');
    assert.equal(body.stream, true); assert.equal(body.messages[1].content, 'A thoughtful sentence.');
    assert.match(body.messages[0].content, /untrusted data/);
  }
  assert.match(requestBody({ text: 'Hello', target: 'zh', model: 'deepseek-v4-flash', mode: 'plain' }, 'manual').messages[0].content, /only the translated text itself/);
  assert.throws(() => requestBody({ text: 'x'.repeat(6001), target: 'zh', model: 'deepseek-v4-flash', mode: 'plain' }, 'manual'), /过长/);
  assert.throws(() => requestBody({ text: 'Hello', target: 'zh', model: 'deepseek-v4-flash', mode: 'unknown' }, 'manual'), /模式/);
});
test('API calls use the fixed HTTPS DeepSeek endpoint and exclude cookies and redirects', async () => {
  let captured;
  const response = await complete(key, valid, 'translate', undefined, async (url, options) => { captured = { url, options }; return Response.json(reply([{ id: 0, text: '你好' }])); });
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer ' + key); assert.equal(captured.options.credentials, 'omit'); assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(parseTranslations(await response.json(), 1), ['你好']);
});
test('invalid keys, insufficient balance and rate limits have specific redacted messages', async () => {
  for (const [status, pattern] of [[401, /Key 无效/], [402, /余额不足/], [429, /请求限流/], [503, /服务繁忙/]]) {
    await assert.rejects(complete(key, valid, 'translate', undefined, async () => new Response('secret: ' + key, { status })), e => pattern.test(e.message) && !e.message.includes(key));
  }
});
test('key validation calls models endpoint without generating a completion', async () => {
  let called;
  assert.deepEqual(await checkKey(key, undefined, async (url, opts) => { called = { url, opts }; return Response.json({ data: [{ id: 'deepseek-v4-flash' }] }); }), { models: ['deepseek-v4-flash'] });
  assert.equal(called.url, 'https://api.deepseek.com/models'); assert.equal(called.opts.method, 'GET'); assert.equal(called.opts.body, undefined);
});
test('SSE parsing handles single-byte chunks, CRLF, keep-alive comments and multibyte text', async () => {
  const bytes = new TextEncoder().encode(': keep-alive\r\n\r\ndata: ' + JSON.stringify(chunk('你好 مرحبا')) + '\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const events = []; for await (const event of readSSE(stream)) events.push(event);
  assert.equal(events[0].choices[0].delta.content, '你好 مرحبا'); assert.deepEqual(events[1], { done: true });
});
test('explanation streams answer text, hides reasoning content and requires clean completion', async () => {
  const response = sse([{ choices: [{ index: 0, delta: { reasoning_content: 'DO_NOT_DISPLAY' }, finish_reason: null }] }, chunk('语境含义：'), chunk('偶然的发现。'), chunk('', 'stop'), '[DONE]']);
  const text = []; for await (const delta of explanationDeltas(response)) text.push(delta);
  assert.equal(text.join(''), '语境含义：偶然的发现。');
  const collect = async response => { for await (const _delta of explanationDeltas(response)) {} };
  await assert.rejects(collect(sse([chunk('partial')])), /连接中断/);
  await assert.rejects(collect(sse([chunk('partial', 'length'), '[DONE]'])), /未完成/);
  await assert.rejects(collect(sse([chunk('', 'stop'), '[DONE]'])), /空解释/);
});
test('plaintext and JSON key import support BOM and reject malformed or oversized files', () => {
  for (const text of [key, '\uFEFF' + key + '\n', JSON.stringify(key), JSON.stringify({ apiKey: key }), JSON.stringify({ api_key: key }), JSON.stringify({ DEEPSEEK_API_KEY: key }), JSON.stringify({ key })]) assert.equal(importKey(text), key);
  for (const text of ['{broken', '{}', 'key with spaces', '', 'x'.repeat(16385)]) assert.throws(() => importKey(text));
});
test('request cancellation is forwarded and network errors are readable', async () => {
  const controller = new AbortController();
  const pending = complete(key, valid, 'translate', controller.signal, async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('raw detail')))));
  controller.abort(); await assert.rejects(pending, /取消或超时/);
  await assert.rejects(complete(key, valid, 'translate', undefined, async () => { throw new Error('raw network detail'); }), /无法连接 DeepSeek/);
});
