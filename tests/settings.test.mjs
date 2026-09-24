import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettings, saveSettings } from '../extension/settings.js';
const local = {}, session = {};
const area = data => ({ get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]])), set: async patch => Object.assign(data, patch), remove: async key => { delete data[key]; } });
globalThis.chrome = { storage: { local: area(local), session: area(session) } };
test('old provider preferences migrate without reusing its token or model', async () => {
  local.settings = { target: 'fr', model: 'gpt-4.1-mini', token: 'old-pairing-token', autoSites: ['https://example.org'] };
  const result = await readSettings();
  assert.equal(result.target, 'fr'); assert.equal(result.model, 'deepseek-v4-flash'); assert.equal(result.apiKey, ''); assert.equal(result.token, undefined);
  assert.equal(result.provider, 'cloud');
  assert.equal(result.scope, 'page'); assert.equal(result.displayMode, 'bilingual'); assert.equal(result.textMode, 'plain');
  await saveSettings({}); assert.equal(local.settings.token, undefined);
});
test('web display and manual detail modes persist with strict validation', async () => {
  let result = await saveSettings({ displayMode: 'replace', textMode: 'detailed' });
  assert.equal(result.displayMode, 'replace'); assert.equal(result.textMode, 'detailed');
  await assert.rejects(saveSettings({ displayMode: 'overlay' }), /显示方式/);
  await assert.rejects(saveSettings({ textMode: 'essay' }), /文本翻译模式/);
  result = await readSettings(); assert.equal(result.displayMode, 'replace'); assert.equal(result.textMode, 'detailed');
});
test('article scope persists independently of language and rejects unsupported ranges', async () => {
  assert.equal((await saveSettings({ scope: 'article' })).scope, 'article');
  await saveSettings({ target: 'ar' }); assert.equal((await readSettings()).scope, 'article');
  await assert.rejects(saveSettings({ scope: 'everything' }), /翻译范围/);
  assert.equal((await readSettings()).scope, 'article');
  assert.equal((await saveSettings({ scope: 'page' })).scope, 'page');
});
test('session-only key survives worker reads, moves to local only by explicit preference, and clears fully', async () => {
  const key = 'sk-test-only-not-a-real-key';
  await saveSettings({ apiKey: key }); assert.equal(local.deepseekApiKey, undefined); assert.equal((await readSettings()).apiKey, key); assert.equal((await readSettings()).provider, 'deepseek');
  await saveSettings({ rememberKey: true }); assert.equal(local.deepseekApiKey, key); assert.equal(session.deepseekApiKey, undefined);
  await saveSettings({ rememberKey: false }); assert.equal(local.deepseekApiKey, undefined); assert.equal(session.deepseekApiKey, key);
  delete session.deepseekApiKey; assert.equal((await readSettings()).apiKey, '');
  await saveSettings({ apiKey: key, rememberKey: true }); await saveSettings({ apiKey: '' });
  assert.equal(local.deepseekApiKey, undefined); assert.equal(session.deepseekApiKey, undefined); assert.equal((await readSettings()).provider, 'cloud');
});

test('cloud is the default and personal-key mode requires a stored key', async () => {
  await saveSettings({ provider: 'cloud' });
  let result = await readSettings(); assert.equal(result.provider, 'cloud');
  await saveSettings({ provider: 'deepseek' });
  result = await readSettings(); assert.equal(result.provider, 'cloud');
  await assert.rejects(saveSettings({ provider: 'unknown' }), /服务选项/);
});
