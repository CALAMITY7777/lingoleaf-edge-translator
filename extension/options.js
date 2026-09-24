import { LANGUAGES } from './shared.js';
import { importKey } from './deepseek.js';

const $ = id => document.getElementById(id);
const send = async message => { const response = await chrome.runtime.sendMessage(message); if (!response?.ok) throw new Error(response?.error || '连接失败'); return response; };
let settings;

function feedback(text, error = false) {
  $('feedback').textContent = text;
  $('feedback').className = 'message ' + (error ? 'error' : 'success');
}

for (const id of ['target', 'explanation-language']) for (const lang of LANGUAGES) {
  const option = document.createElement('option');
  option.value = lang.code;
  option.textContent = `${lang.name} · ${lang.native}`;
  $(id).append(option);
}

function providerView() {
  const personal = $('provider').value === 'deepseek';
  $('personal-settings').hidden = !personal;
  $('provider-help').textContent = personal
    ? '使用自己的额度；密钥只保存在扩展受信任存储中。'
    : '每位用户每天最多 2 万字符；公共服务每天设有总量保护。';
  $('usage-note').textContent = personal
    ? '密钥验证只请求模型列表；测试翻译会产生少量个人 API 用量。'
    : '免费服务使用匿名会话和每日额度；测试翻译会消耗少量免费额度。';
}

function sites() {
  $('sites').replaceChildren();
  if (!settings.autoSites.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-sites';
    empty.textContent = '还没有自动翻译的网站。随时从扩展弹窗添加。';
    $('sites').append(empty);
  }
  for (const origin of settings.autoSites) {
    const row = document.createElement('div'); row.className = 'row between site';
    const name = document.createElement('span'); name.className = 'site-name'; name.textContent = origin;
    const button = document.createElement('button'); button.className = 'text-button'; button.textContent = '移除'; button.setAttribute('aria-label', '移除 ' + origin);
    button.onclick = async () => { try { settings = { ...settings, ...await send({ type: 'SET_AUTO_SITE', origin, enabled: false }) }; sites(); } catch (error) { feedback(error.message, true); } };
    row.append(name, button); $('sites').append(row);
  }
}

async function save() {
  const personal = $('provider').value === 'deepseek';
  const patch = {
    provider: $('provider').value,
    model: $('model').value.trim(),
    target: $('target').value,
    explanationLanguage: $('explanation-language').value
  };
  if (personal) {
    patch.apiKey = $('api-key').value.trim();
    patch.rememberKey = $('remember-key').checked;
  }
  settings = { ...settings, ...await send({ type: 'SAVE_SETTINGS', settings: patch }), ...patch };
}

function busy(value) {
  for (const id of ['save', 'test', 'import', 'remove-key', 'provider']) $(id).disabled = value;
}

$('provider').onchange = providerView;
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  busy(true);
  const personal = $('provider').value === 'deepseek';
  feedback(personal ? '正在保存并验证 DeepSeek 密钥…' : '正在启用免费翻译服务…');
  try {
    await save();
    if (!personal) { feedback('免费翻译服务已启用，安装后无需填写 API Key。'); return; }
    if (!$('api-key').value.trim()) { feedback('请输入 DeepSeek API Key。', true); return; }
    const result = await send({ type: 'CHECK_KEY' });
    feedback(result.models.includes(settings.model) ? '个人 DeepSeek 密钥验证成功。' : '密钥有效，但模型列表中没有所选模型，请检查模型 ID。');
  } catch (error) { feedback(error.message, true); }
  finally { busy(false); }
};

$('test').onclick = async () => {
  busy(true); feedback('正在测试翻译服务…');
  try { await save(); const result = await send({ type: 'TEST_API' }); feedback('翻译成功：' + result.translations[0]); }
  catch (error) { feedback(error.message, true); }
  finally { busy(false); }
};

$('reveal').onclick = () => {
  const show = $('api-key').type === 'password';
  $('api-key').type = show ? 'text' : 'password';
  $('reveal').textContent = show ? '隐藏' : '显示';
  $('reveal').setAttribute('aria-label', show ? '隐藏密钥' : '显示密钥');
};
$('import').onclick = () => $('key-file').click();
$('key-file').onchange = async () => {
  const file = $('key-file').files?.[0]; if (!file) return;
  try {
    if (file.size > 16384) throw new Error('文件过大，请选择小于 16 KB 的 .txt 或 .json 密钥文件。');
    $('api-key').value = importKey(await file.text());
    feedback('密钥已导入。点击“保存设置”后生效。');
  } catch (error) { feedback(error.message, true); }
  finally { $('key-file').value = ''; }
};
$('remove-key').onclick = async () => {
  busy(true);
  try {
    await send({ type: 'SAVE_SETTINGS', settings: { apiKey: '', rememberKey: false, provider: 'cloud' } });
    $('api-key').value = ''; $('remember-key').checked = false; $('provider').value = 'cloud'; providerView();
    feedback('个人密钥已清除，现已切换为免费服务。');
  } catch (error) { feedback(error.message, true); }
  finally { busy(false); }
};
$('clear').onclick = async () => { try { await send({ type: 'CLEAR_CACHE' }); feedback('已清空扩展内存中的翻译缓存。'); } catch (error) { feedback(error.message, true); } };

Promise.all([send({ type: 'GET_SETTINGS' }), send({ type: 'GET_KEY' })]).then(([current, key]) => {
  settings = current;
  $('provider').value = current.provider;
  $('api-key').value = key.apiKey;
  $('remember-key').checked = current.rememberKey;
  $('model').value = current.model;
  $('target').value = current.target;
  $('explanation-language').value = current.explanationLanguage;
  providerView(); sites();
}).catch(error => feedback(error.message, true));
