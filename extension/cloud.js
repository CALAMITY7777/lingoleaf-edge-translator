import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, CLOUD_FUNCTION } from './cloud-config.js';

const SESSION_KEY = 'lingoleafCloudSession';
let sessionPromise;

export function cloudConfigured() {
  return /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(SUPABASE_URL) &&
    /^(sb_publishable_|eyJ)/.test(SUPABASE_PUBLISHABLE_KEY) &&
    /^[a-z0-9-]{1,80}$/.test(CLOUD_FUNCTION);
}

function area(custom) {
  if (custom) return custom;
  if (!globalThis.chrome?.storage?.local) throw new Error('扩展存储不可用。');
  return chrome.storage.local;
}

function normalizeSession(data) {
  const value = data?.session || data;
  if (typeof value?.access_token !== 'string' || typeof value?.refresh_token !== 'string') throw new Error('免费翻译服务登录失败，请稍后重试。');
  const expiresAt = Number(value.expires_at) || Math.floor(Date.now() / 1000) + Math.max(60, Number(value.expires_in) || 3600);
  return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt };
}

async function authFetch(path, body, signal, fetchImpl) {
  if (!cloudConfigured()) throw new Error('免费翻译服务尚未配置。');
  let response;
  try {
    response = await fetchImpl(SUPABASE_URL + path, {
      method: 'POST',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store'
    });
  } catch {
    throw new Error(signal?.aborted ? '请求已取消或超时，请稍后重试。' : '无法连接免费翻译服务，请检查网络。');
  }
  if (!response.ok) throw new Error(response.status === 429 ? '登录请求过于频繁，请稍后重试。' : '免费翻译服务登录失败，请稍后重试。');
  let data; try { data = await response.json(); } catch { throw new Error('免费翻译服务返回无效登录信息。'); }
  return normalizeSession(data);
}

async function persist(storage, session) {
  await storage.set({ [SESSION_KEY]: session });
  return session;
}

async function freshSession(signal, fetchImpl, storage) {
  const session = await authFetch('/auth/v1/signup', { data: { client: 'lingoleaf-edge' } }, signal, fetchImpl);
  return persist(storage, session);
}

async function refreshSession(current, signal, fetchImpl, storage) {
  try {
    const session = await authFetch('/auth/v1/token?grant_type=refresh_token', { refresh_token: current.refreshToken }, signal, fetchImpl);
    return persist(storage, session);
  } catch {
    await storage.remove(SESSION_KEY);
    return freshSession(signal, fetchImpl, storage);
  }
}

export async function clearCloudSession(customStorage) {
  sessionPromise = undefined;
  await area(customStorage).remove(SESSION_KEY);
}

export async function getCloudSession(signal, fetchImpl = fetch, customStorage) {
  const storage = area(customStorage);
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const stored = (await storage.get(SESSION_KEY))[SESSION_KEY];
    if (stored?.accessToken && stored?.refreshToken) {
      if (Number(stored.expiresAt) > Math.floor(Date.now() / 1000) + 90) return stored;
      return refreshSession(stored, signal, fetchImpl, storage);
    }
    return freshSession(signal, fetchImpl, storage);
  })();
  try { return await sessionPromise; }
  finally { sessionPromise = undefined; }
}

function cloudError(status, code) {
  const messages = {
    USER_DAILY_LIMIT: '今日免费额度已用完，可明天继续或在设置中使用自己的 DeepSeek Key。',
    SERVICE_DAILY_LIMIT: '今日公共免费额度已用完，请明天再试或使用自己的 DeepSeek Key。',
    MODEL_BUSY: '翻译模型暂时繁忙，请稍后重试。',
    MODEL_ERROR: '翻译模型暂时不可用，请稍后重试。',
    SERVICE_NOT_CONFIGURED: '免费翻译服务正在配置中，请稍后重试。',
    SERVICE_UNAVAILABLE: '免费翻译服务暂时不可用，请稍后重试。',
    INVALID_REQUEST: '翻译内容格式不正确。'
  };
  return new Error(messages[code] || (status === 429 ? '免费翻译请求过于频繁，请稍后重试。' : `免费翻译服务请求失败（${status}）。`));
}

export async function cloudComplete(body, kind, signal, fetchImpl = fetch, customStorage) {
  const storage = area(customStorage);
  const call = async session => {
    try {
      return await fetchImpl(`${SUPABASE_URL}/functions/v1/${CLOUD_FUNCTION}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ kind, ...body }),
        signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store'
      });
    } catch {
      throw new Error(signal?.aborted ? '请求已取消或超时，请稍后重试。' : '无法连接免费翻译服务，请检查网络。');
    }
  };

  let session = await getCloudSession(signal, fetchImpl, storage);
  let response = await call(session);
  if (response.status === 401) {
    await clearCloudSession(storage);
    session = await getCloudSession(signal, fetchImpl, storage);
    response = await call(session);
  }
  if (!response.ok) {
    let code = '';
    try { code = (await response.json())?.error || ''; } catch { /* Use the status fallback. */ }
    throw cloudError(response.status, code);
  }
  return response;
}
