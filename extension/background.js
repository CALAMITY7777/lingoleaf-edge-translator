import { language, sitePattern, webPrompt } from './shared.js';
import { complete, parseTranslations, explanationDeltas, checkKey } from './deepseek.js';
import { cloudComplete } from './cloud.js';
import { readSettings, saveSettings, publicSettings } from './settings.js';

const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
const cache = new Map();
const controllers = new Map();
let activeRequests = 0;
const queue = [];
const settings = async () => { await ready; return readSettings(); };
const isTrusted = sender => sender.url?.startsWith(chrome.runtime.getURL(''));
const sanitized = publicSettings;
const modelRequest = (s, body, kind, signal) => s.provider === 'deepseek'
  ? complete(s.apiKey, body, kind, signal)
  : cloudComplete(body, kind, signal);
function abortTab(tabId) { controllers.get(tabId)?.forEach(c => c.abort()); }
function track(tabId, controller) { if (!controllers.has(tabId)) controllers.set(tabId, new Set()); controllers.get(tabId).add(controller); }
function untrack(tabId, controller) { const set = controllers.get(tabId); set?.delete(controller); if (!set?.size) controllers.delete(tabId); }
async function limited(fn, signal) {
  if (signal.aborted) throw new Error('已取消。');
  if (activeRequests >= 2) await new Promise((resolve, reject) => {
    const entry = { resolve: () => { signal.removeEventListener('abort', onAbort); resolve(); } };
    const onAbort = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(new Error('已取消。')); };
    signal.addEventListener('abort', onAbort, { once: true }); queue.push(entry);
  });
  if (signal.aborted) throw new Error('已取消。');
  activeRequests++;
  try { return await fn(); } finally { activeRequests--; queue.shift()?.resolve(); }
}
async function translate(message, sender) {
  if (!sender.tab || !Array.isArray(message.texts) || message.texts.length < 1 || message.texts.length > 6 || message.texts.some(t => typeof t !== 'string' || !t.trim() || t.length > 1200) || message.texts.join('').length > 6000) throw new Error('翻译内容格式不正确。');
  if (!['zh', 'en', 'fr', 'ru', 'es', 'ar'].includes(message.target)) throw new Error('目标语言无效。');
  const s = await settings(), controller = new AbortController(), tabId = sender.tab.id;
  track(tabId, controller);
  try {
    return await limited(async () => {
      const texts = [...new Set(message.texts)];
      const key = text => JSON.stringify([s.provider, s.model, message.target, text]);
      const values = new Map(texts.filter(text => cache.has(key(text))).map(text => [text, cache.get(key(text))]));
      const missing = texts.filter(text => !cache.has(key(text)));
      if (missing.length) {
        const timer = setTimeout(() => controller.abort(), 28000);
        try {
          const response = await modelRequest(s, { texts: missing, target: message.target, model: s.model }, 'translate', controller.signal);
          const data = { translations: parseTranslations(await response.json(), missing.length) };
          if (controller.signal.aborted) throw new Error('已取消。');
          missing.forEach((text, i) => { cache.set(key(text), data.translations[i]); values.set(text, data.translations[i]); });
          while (cache.size > 400) cache.delete(cache.keys().next().value);
        } finally { clearTimeout(timer); }
      }
      const result = message.texts.map(text => { const k = key(text), value = values.get(text); cache.delete(k); cache.set(k, value); return value; });
      while (cache.size > 400) cache.delete(cache.keys().next().value);
      return { translations: result, cached: texts.length - missing.length };
    }, controller.signal);
  } finally { untrack(tabId, controller); }
}
async function syncAutoSites() {
  const s = await settings();
  const matches = [...new Set(s.autoSites.map(sitePattern))];
  const allowed = [];
  for (const match of matches) if (await chrome.permissions.contains({ origins: [match] })) allowed.push(match);
  await chrome.scripting.unregisterContentScripts({ ids: ['lingoleaf-auto'] }).catch(() => {});
  if (allowed.length) await chrome.scripting.registerContentScripts([{ id: 'lingoleaf-auto', matches: allowed, js: ['article-detector.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
}
async function inject(tabId, frameId = 0) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId }); }
  catch { await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['article-detector.js', 'content.js'] }); }
}
async function openExplain(info, tab, mode) {
  const s = await settings();
  const selection = (info.selectionText || '').trim().slice(0, 3000);
  if (!selection) return;
  try {
    const frameId = info.frameId || 0;
    await inject(tab.id, frameId);
    await chrome.tabs.sendMessage(tab.id, { type: 'EXPLAIN', selection, mode, target: s.explanationLanguage }, { frameId });
  } catch {
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ ['explain:' + id]: { selection, target: s.explanationLanguage, mode } });
    await chrome.tabs.create({ url: chrome.runtime.getURL('explain.html#' + id) });
  }
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'lingoleaf-explain', title: '轻译 · 智能解释 “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'lingoleaf-chatgpt', title: '轻译 · 在 ChatGPT 中解释 “%s”', contexts: ['selection'] });
  });
  syncAutoSites().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => syncAutoSites().catch(() => {}));
chrome.permissions.onRemoved.addListener(() => syncAutoSites().catch(() => {}));
chrome.contextMenus.onClicked.addListener((info, tab) => openExplain(info, tab, info.menuItemId === 'lingoleaf-chatgpt' ? 'web' : 'api'));
chrome.tabs.onRemoved.addListener(abortTab);
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') abortTab(tabId); });
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-translation') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try { await inject(tab.id); await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', settings: sanitized(await settings()) }); }
  catch { /* Restricted browser pages cannot receive content scripts. */ }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    await ready;
    if (sender.id !== chrome.runtime.id) throw new Error('无权访问。');
    switch (message.type) {
      case 'BOOT': return sanitized(await settings());
      case 'GET_SETTINGS': if (isTrusted(sender)) return sanitized(await settings()); break;
      case 'GET_KEY': if (sender.url === chrome.runtime.getURL('options.html')) return { apiKey: (await settings()).apiKey }; break;
      case 'SAVE_SETTINGS': {
        if (!isTrusted(sender)) break;
        if ((message.settings?.apiKey !== undefined || message.settings?.rememberKey !== undefined) && sender.url !== chrome.runtime.getURL('options.html')) throw new Error('请在设置页管理密钥。');
        const result = await saveSettings(message.settings || {});
        if (message.settings?.apiKey !== undefined || message.settings?.model !== undefined || message.settings?.provider !== undefined) {
          controllers.forEach(set => set.forEach(c => c.abort())); cache.clear();
        }
        return result;
      }
      case 'SET_AUTO_SITE': {
        if (!isTrusted(sender)) break;
        const origin = new URL(message.origin).origin, pattern = sitePattern(origin), s = await settings();
        if (message.enabled && !await chrome.permissions.contains({ origins: [pattern] })) throw new Error('需要先授权当前网站。');
        s.autoSites = s.autoSites.filter(item => item !== origin);
        if (message.enabled) s.autoSites.push(origin);
        const { apiKey, ...prefs } = s;
        await chrome.storage.local.set({ settings: prefs }); await syncAutoSites(); return sanitized(s);
      }
      case 'CHECK_KEY': if (isTrusted(sender)) {
        const s = await settings();
        if (s.provider !== 'deepseek') throw new Error('当前使用免配置免费服务，无需验证个人密钥。');
        return checkKey(s.apiKey, AbortSignal.timeout(15000));
      } break;
      case 'TEST_API': if (isTrusted(sender)) {
        const s = await settings();
        const response = await modelRequest(s, { texts: ['Hello, world.'], target: 'zh', model: s.model }, 'translate', AbortSignal.timeout(28000));
        return { translations: parseTranslations(await response.json(), 1) };
      } break;
      case 'TRANSLATE': return translate(message, sender);
      case 'CANCEL': if (sender.tab) { abortTab(sender.tab.id); return {}; } break;
      case 'INJECT': if (isTrusted(sender) && Number.isInteger(message.tabId)) { await inject(message.tabId); return {}; } break;
      case 'OPEN_OPTIONS': await chrome.runtime.openOptionsPage(); return {};
      case 'OPEN_CHATGPT': await chrome.tabs.create({ url: 'https://chatgpt.com/' }); return {};
      case 'WEB_PROMPT': return { prompt: webPrompt(String(message.selection || ''), String(message.context || ''), language(message.target).code) };
      case 'CLEAR_CACHE': if (isTrusted(sender)) { cache.clear(); return {}; } break;
    }
    throw new Error('不支持的请求。');
  })().then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'lingoleaf-manual') {
    if (!isTrusted(port.sender)) return port.disconnect();
    let controller, started = false, disconnected = false;
    const send = data => { if (!disconnected) { try { port.postMessage(data); } catch {} } };
    port.onDisconnect.addListener(() => { disconnected = true; controller?.abort(); });
    port.onMessage.addListener(async body => {
      if (started) return; started = true; controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const s = await settings();
        const response = await modelRequest(s, { text: body.text, target: body.target, mode: body.mode, model: s.model }, 'manual', controller.signal);
        for await (const delta of explanationDeltas(response)) send({ delta });
        send({ done: true });
      } catch (e) { send({ error: e.message }); }
      finally { clearTimeout(timer); if (!disconnected) port.disconnect(); }
    });
    return;
  }
  if (port.name !== 'lingoleaf-explain' || port.sender?.id !== chrome.runtime.id) return;
  let controller, started = false, disconnected = false;
  const send = data => { if (!disconnected) { try { port.postMessage(data); } catch {} } };
  port.onDisconnect.addListener(() => { disconnected = true; controller?.abort(); });
  port.onMessage.addListener(async body => {
    if (started) return; started = true;
    controller = new AbortController();
    const tabId = port.sender.tab?.id ?? -1;
    track(tabId, controller);
    const timer = setTimeout(() => controller.abort(), 28000);
    try {
      if (typeof body.selection !== 'string' || !body.selection.trim() || body.selection.length > 3000 || typeof body.context !== 'string' || body.context.length > 1800) throw new Error('选中内容过长或为空。');
      const s = await settings();
      const response = await modelRequest(s, { selection: body.selection, context: body.context, target: s.explanationLanguage, model: s.model }, 'explain', controller.signal);
      for await (const delta of explanationDeltas(response)) send({ delta });
      send({ done: true });
    } catch (e) { send({ error: e.message }); }
    finally { clearTimeout(timer); untrack(tabId, controller); if (!disconnected) port.disconnect(); }
  });
});
