import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudConfigured, cloudComplete, getCloudSession, clearCloudSession } from '../extension/cloud.js';

const makeStorage = initial => {
  const data = structuredClone(initial || {});
  return {
    data,
    get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async patch => Object.assign(data, structuredClone(patch)),
    remove: async key => { delete data[key]; }
  };
};

const session = (token = 'user-token') => ({ access_token: token, refresh_token: 'refresh-token', expires_in: 3600 });

test('cloud config uses a public Supabase endpoint and anonymous session before translation', async () => {
  assert.equal(cloudConfigured(), true);
  const storage = makeStorage();
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/signup')) return Response.json(session());
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"translations":[{"id":0,"text":"你好"}]}' } }] });
  };
  const response = await cloudComplete({ texts: ['Hello'], target: 'zh' }, 'translate', undefined, fetchMock, storage);
  assert.equal((await response.json()).choices[0].finish_reason, 'stop');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/auth\/v1\/signup$/);
  assert.match(calls[1].url, /\/functions\/v1\/lingoleaf-translate$/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer user-token');
  assert.equal(calls[1].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[1].options.body), { kind: 'translate', texts: ['Hello'], target: 'zh' });
  assert.equal(storage.data.lingoleafCloudSession.refreshToken, 'refresh-token');
  await clearCloudSession(storage);
});

test('expired cloud sessions refresh without creating another anonymous user', async () => {
  const storage = makeStorage({ lingoleafCloudSession: { accessToken: 'old', refreshToken: 'refresh-token', expiresAt: 1 } });
  const calls = [];
  const fetchMock = async (url, options) => { calls.push({ url, options }); return Response.json(session('renewed')); };
  const value = await getCloudSession(undefined, fetchMock, storage);
  assert.equal(value.accessToken, 'renewed');
  assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=refresh_token$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { refresh_token: 'refresh-token' });
  await clearCloudSession(storage);
});

test('cloud quota errors are localized without exposing response bodies', async () => {
  const storage = makeStorage({ lingoleafCloudSession: { accessToken: 'valid', refreshToken: 'refresh', expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
  await assert.rejects(
    cloudComplete({ text: 'Hello', target: 'zh', mode: 'plain' }, 'manual', undefined, async () => Response.json({ error: 'USER_DAILY_LIMIT', detail: 'private' }, { status: 429 }), storage),
    error => /今日免费额度/.test(error.message) && !error.message.includes('private')
  );
  await clearCloudSession(storage);
});
