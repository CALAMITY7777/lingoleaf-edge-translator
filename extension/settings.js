import { DEFAULTS, LANGUAGES } from './shared.js';
import { validateKey } from './deepseek.js';
import { cloudConfigured } from './cloud.js';
export async function readSettings() {
  const [local, session] = await Promise.all([chrome.storage.local.get(['settings', 'deepseekApiKey']), chrome.storage.session.get('deepseekApiKey')]);
  const raw = local.settings || {};
  const apiKey = session.deepseekApiKey || local.deepseekApiKey || '';
  // Old OpenAI model and pairing token must not be reused as a DeepSeek credential.
  return {
    ...DEFAULTS,
    provider: raw.provider === 'deepseek' && apiKey ? 'deepseek' : 'cloud',
    scope: raw.scope === 'article' ? 'article' : 'page',
    displayMode: raw.displayMode === 'replace' ? 'replace' : 'bilingual',
    textMode: ['plain', 'annotated', 'detailed'].includes(raw.textMode) ? raw.textMode : 'plain',
    target: LANGUAGES.some(l => l.code === raw.target) ? raw.target : DEFAULTS.target,
    explanationLanguage: LANGUAGES.some(l => l.code === raw.explanationLanguage) ? raw.explanationLanguage : DEFAULTS.explanationLanguage,
    autoSites: Array.isArray(raw.autoSites) ? raw.autoSites.filter(site => typeof site === 'string' && /^https?:\/\//.test(site)) : [],
    model: typeof raw.model === 'string' && raw.model.startsWith('deepseek-') ? raw.model : DEFAULTS.model,
    rememberKey: raw.rememberKey === true,
    apiKey
  };
}
export function publicSettings(s) {
  const { apiKey, ...prefs } = s;
  const cloudAvailable = cloudConfigured();
  return { ...prefs, cloudAvailable, configured: s.provider === 'cloud' ? cloudAvailable : Boolean(apiKey) };
}
export async function saveSettings(patch) {
  const s = await readSettings();
  if (patch.provider !== undefined) {
    if (!['cloud', 'deepseek'].includes(patch.provider)) throw new Error('翻译服务选项无效。');
    s.provider = patch.provider;
  }
  if (patch.scope !== undefined) {
    if (!['page', 'article'].includes(patch.scope)) throw new Error('翻译范围无效。');
    s.scope = patch.scope;
  }
  if (patch.displayMode !== undefined) {
    if (!['bilingual', 'replace'].includes(patch.displayMode)) throw new Error('网页显示方式无效。');
    s.displayMode = patch.displayMode;
  }
  if (patch.textMode !== undefined) {
    if (!['plain', 'annotated', 'detailed'].includes(patch.textMode)) throw new Error('文本翻译模式无效。');
    s.textMode = patch.textMode;
  }
  for (const field of ['target', 'explanationLanguage']) if (patch[field] !== undefined) {
    if (!LANGUAGES.some(l => l.code === patch[field])) throw new Error('语言选项无效。'); s[field] = patch[field];
  }
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || !/^deepseek-[a-zA-Z0-9._:-]{1,80}$/.test(patch.model)) throw new Error('请填写有效的 DeepSeek 模型 ID。');
    s.model = patch.model;
  }
  if (patch.apiKey !== undefined) {
    s.apiKey = validateKey(patch.apiKey, true);
    if (patch.provider === undefined) s.provider = s.apiKey ? 'deepseek' : 'cloud';
  }
  if (patch.rememberKey !== undefined) s.rememberKey = patch.rememberKey === true;
  const { apiKey, ...prefs } = s;
  await chrome.storage.local.set({ settings: prefs });
  if (apiKey && s.rememberKey) {
    await chrome.storage.local.set({ deepseekApiKey: apiKey }); await chrome.storage.session.remove('deepseekApiKey');
  } else {
    if (apiKey) await chrome.storage.session.set({ deepseekApiKey: apiKey });
    else await chrome.storage.session.remove('deepseekApiKey');
    await chrome.storage.local.remove('deepseekApiKey');
  }
  return publicSettings(s);
}
