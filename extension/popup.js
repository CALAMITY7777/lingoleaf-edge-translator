import { LANGUAGES, sitePattern } from './shared.js';
const $ = id => document.getElementById(id);
let settings, tab, state = { active: false }, busy = false, poll;
const send = async message => { const r = await chrome.runtime.sendMessage(message); if (!r?.ok) throw new Error(r?.error || '连接失败'); return r; };
function feedback(text, error = false) { $('feedback').textContent = text; $('feedback').className = `message ${error ? 'error' : 'success'}${text ? '' : ' hidden'}`; }
async function page(message) { await send({ type: 'INJECT', tabId: tab.id }); return chrome.tabs.sendMessage(tab.id, message); }
function render() {
  document.querySelectorAll('.language').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.code === settings.target)); button.disabled = busy; });
  document.querySelectorAll('[data-scope]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.scope === settings.scope)); button.disabled = busy; });
  document.querySelectorAll('[data-display]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.display === settings.displayMode)); button.disabled = busy; });
  $('translate-label').textContent = busy ? '正在准备…' : state.active ? '暂停翻译' : state.translated ? '继续翻译' : settings.scope === 'article' ? '识别并翻译正文' : '开始翻译此页';
  $('translate').disabled = busy || !tab;
  $('status').textContent = state.notice || state.scopeNote || (state.detected ? `${state.running && state.active ? '正在翻译 · ' : ''}${state.translated} / ${state.detected} 段已处理` : settings.scope === 'article' ? '智能识别正文，随阅读翻译' : '只翻译视野附近的内容');
  $('status').title = $('status').textContent;
  $('restore').disabled = busy || !tab;
  $('auto-site').disabled = busy || !tab;
}
for (const item of LANGUAGES) {
  const button = document.createElement('button'); button.className = 'language'; button.dataset.code = item.code; button.setAttribute('aria-pressed', 'false'); button.title = item.name;
  const glyph = document.createElement('span'); glyph.className = 'glyph'; glyph.textContent = item.glyph;
  const detail = document.createElement('span'); const name = document.createElement('div'); name.className = 'language-name'; name.textContent = item.name;
  const native = document.createElement('div'); native.className = 'native-name'; native.textContent = item.native; if (item.code === 'ar') native.dir = 'rtl';
  detail.append(name, native); button.append(glyph, detail); $('languages').append(button);
  button.onclick = async () => {
    if (busy || !settings) return;
    busy = true; render();
    try {
      const wasActive = state.active;
      await send({ type: 'SAVE_SETTINGS', settings: { target: item.code } }); settings.target = item.code;
      if (tab && (wasActive || state.detected)) {
        state = await page({ type: 'RESTORE' });
        if (wasActive) state = await page({ type: 'START', target: item.code, scope: settings.scope, displayMode: settings.displayMode });
      }
      render();
    } catch (e) { feedback(e.message, true); }
    finally { busy = false; render(); }
  };
}
document.querySelectorAll('[data-scope]').forEach(button => {
  button.onclick = async () => {
    if (busy || !settings || button.dataset.scope === settings.scope) return;
    busy = true; feedback(''); render();
    try {
      const wasActive = state.active;
      await send({ type: 'SAVE_SETTINGS', settings: { scope: button.dataset.scope } });
      settings.scope = button.dataset.scope;
      if (tab && (wasActive || state.detected || state.scopeNote)) {
        state = await page({ type: 'RESTORE' });
        if (wasActive) state = await page({ type: 'START', target: settings.target, scope: settings.scope, displayMode: settings.displayMode });
      }
    } catch (e) { feedback(e.message, true); }
    finally { busy = false; render(); }
  };
});
document.querySelectorAll('[data-display]').forEach(button => {
  button.onclick = async () => {
    if (busy || !settings || button.dataset.display === settings.displayMode) return;
    busy = true; feedback(''); render();
    try {
      const wasActive = state.active;
      await send({ type: 'SAVE_SETTINGS', settings: { displayMode: button.dataset.display } });
      settings.displayMode = button.dataset.display;
      if (tab && (wasActive || state.detected || state.scopeNote)) {
        state = await page({ type: 'RESTORE' });
        if (wasActive) state = await page({ type: 'START', target: settings.target, scope: settings.scope, displayMode: settings.displayMode });
      }
    } catch (e) { feedback(e.message, true); }
    finally { busy = false; render(); }
  };
});
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('translate').onclick = async () => {
  if (!tab || busy) return;
  if (!settings.configured && !state.active) { await chrome.runtime.openOptionsPage(); return; }
  busy = true; feedback(''); render();
  try {
    state = await page({ type: state.active ? 'PAUSE' : 'START', target: settings.target, scope: settings.scope, displayMode: settings.displayMode });
  } catch (e) { feedback(e.message, true); }
  finally { busy = false; render(); }
};
$('restore').onclick = async () => { try { state = await page({ type: 'RESTORE' }); feedback('已还原网页'); render(); } catch (e) { feedback(e.message, true); } };
$('auto-site').onchange = async event => {
  const enabled = event.target.checked;
  try {
    const origin = new URL(tab.url).origin;
    if (enabled) {
      const granted = await chrome.permissions.request({ origins: [sitePattern(origin)] });
      if (!granted) throw new Error('未授予此网站访问权限。');
    }
    settings = { ...settings, ...await send({ type: 'SET_AUTO_SITE', origin, enabled }) };
    if (enabled && settings.configured) { state = await page({ type: 'START', target: settings.target, scope: settings.scope, displayMode: settings.displayMode }); render(); }
    feedback(enabled ? '此网站下次打开时会自动翻译' : '已关闭此网站的自动翻译');
  } catch (e) { $('auto-site').checked = settings.autoSites.includes(new URL(tab.url).origin); feedback(e.message, true); }
};
async function init() {
  settings = await send({ type: 'GET_SETTINGS' });
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    tab = null; $('site-name').textContent = '请在普通网页中打开扩展'; $('auto-site').disabled = true; $('restore').disabled = true;
    feedback('浏览器内部页、扩展商店和内置 PDF 阅读器通常不允许注入。', true);
  } else {
    $('site-name').textContent = new URL(tab.url).hostname;
    $('auto-site').checked = settings.autoSites.includes(new URL(tab.url).origin);
    try { state = await chrome.tabs.sendMessage(tab.id, { type: 'STATUS' }) || state; } catch {}
    if (state.active || state.detected || state.scopeNote) {
      if (state.target) settings.target = state.target;
      if (state.scope) settings.scope = state.scope;
      if (state.displayMode) settings.displayMode = state.displayMode;
    }
  }
  render();
  $('connection-label').textContent = settings.provider === 'cloud' ? '免费服务可用' : settings.configured ? '个人 Key 已配置' : '个人 Key 未配置';
  poll = setInterval(async () => { if (!tab || busy) return; try { const s = await chrome.tabs.sendMessage(tab.id, { type: 'STATUS' }); if (s) { state = s; render(); } } catch {} }, 1000);
}
window.addEventListener('pagehide', () => clearInterval(poll));
init().catch(e => feedback(e.message, true));
