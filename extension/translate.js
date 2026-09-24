import { LANGUAGES } from './shared.js';
const $ = id => document.getElementById(id);
const send = async message => { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '连接失败'); return result; };
let settings, port, busy = false, output = '';
for (const item of LANGUAGES) {
  const option = document.createElement('option'); option.value = item.code; option.textContent = `${item.name} · ${item.native}`; $('target').append(option);
}
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function render() {
  $('count').textContent = String($('source').value.length);
  $('run-label').textContent = busy ? '停止翻译' : '开始翻译';
  $('run').disabled = !settings;
  $('target').disabled = busy; $('source').disabled = busy;
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = busy; button.setAttribute('aria-pressed', String(button.dataset.mode === settings?.textMode)); });
  $('copy').disabled = !output; $('clear').disabled = busy && !output;
  $('result').classList.toggle('empty', !output);
  $('result').textContent = output || '结果将在这里显示';
}
async function save(patch) {
  settings = { ...settings, ...await send({ type: 'SAVE_SETTINGS', settings: patch }), ...patch };
}
$('source').oninput = render;
$('target').onchange = async () => { try { await save({ target: $('target').value }); } catch (e) { status(e.message, true); } };
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = async () => {
  if (busy || button.dataset.mode === settings.textMode) return;
  try { await save({ textMode: button.dataset.mode }); render(); } catch (e) { status(e.message, true); }
});
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('clear').onclick = () => {
  const current = port; port = null; current?.disconnect(); busy = false; output = ''; $('source').value = ''; status('已清空；不会保存输入和翻译历史。'); render(); $('source').focus();
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(output); status('翻译结果已复制。'); }
  catch { status('无法自动复制，请选中结果后手动复制。', true); }
};
$('run').onclick = () => {
  if (busy) { const current = port; port = null; current?.disconnect(); busy = false; status('翻译已停止。'); render(); return; }
  const text = $('source').value.trim();
  if (!text) { status('请先输入要翻译的内容。', true); $('source').focus(); return; }
  if (!settings?.configured) { chrome.runtime.openOptionsPage(); return; }
  output = ''; busy = true; status('DeepSeek 正在翻译…'); render();
  const channel = chrome.runtime.connect({ name: 'lingoleaf-manual' }); port = channel; let finished = false;
  channel.onMessage.addListener(event => {
    if (port !== channel) return;
    if (event.delta) { output += event.delta; render(); }
    if (event.error) { finished = true; busy = false; status(event.error, true); render(); }
    if (event.done) { finished = true; busy = false; status('翻译完成 · AI 生成'); render(); }
  });
  channel.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port !== channel) return;
    port = null;
    if (!finished) { busy = false; status(output ? '连接中断，结果可能不完整。' : '连接已断开，请重试。', true); render(); }
  });
  channel.postMessage({ text, target: settings.target, mode: settings.textMode });
};
window.addEventListener('pagehide', () => { port?.disconnect(); port = null; });
send({ type: 'GET_SETTINGS' }).then(s => {
  settings = s; $('target').value = s.target; $('connection-label').textContent = s.provider === 'cloud' ? '免费服务可用' : s.configured ? '个人 Key 已配置' : '个人 Key 未配置'; render();
}).catch(e => status(e.message, true));
