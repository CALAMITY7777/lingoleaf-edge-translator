import { webPrompt } from './shared.js';
const $ = id => document.getElementById(id); let data, port;
const run = () => {
  port?.disconnect(); $('result').textContent = '正在理解这个表达…'; let text = '', done = false;
  port = chrome.runtime.connect({ name: 'lingoleaf-explain' }); const current = port;
  current.onMessage.addListener(event => {
    if (port !== current) return;
    if (event.delta) { text += event.delta; $('result').textContent = text; }
    if (event.error) { done = true; $('feedback').textContent = event.error; }
    if (event.done) { done = true; $('feedback').textContent = '解释完成 · AI 生成'; }
  });
  current.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!done && port === current) $('feedback').textContent = '连接中断，请重试。'; });
  current.postMessage({ selection: data.selection, context: '' });
};
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('retry').onclick = run;
$('web').onclick = async () => {
  try { await navigator.clipboard.writeText(webPrompt(data.selection, '', data.target)); await chrome.tabs.create({ url: 'https://chatgpt.com/' }); $('feedback').textContent = '已复制，请在 ChatGPT 中粘贴并发送。'; }
  catch { $('result').textContent = webPrompt(data.selection, '', data.target); $('feedback').textContent = '请手动复制上方问题。'; }
};
const id = 'explain:' + location.hash.slice(1);
chrome.storage.session.get(id).then(async result => {
  data = result[id];
  if (!data) { $('result').textContent = '此选词会话已过期，请重新选词。'; $('web').disabled = true; $('retry').disabled = true; return; }
  await chrome.storage.session.remove(id);
  $('selection').textContent = data.selection; $('result').lang = data.target; if (data.target === 'ar') $('result').dir = 'rtl';
  if (data.mode === 'web') $('result').textContent = '点击下方按钮复制问题，并在你已登录的 ChatGPT 中粘贴发送。'; else run();
});
window.addEventListener('pagehide', () => port?.disconnect());
