(() => {
  const settings = { provider: 'cloud', cloudAvailable: true, target: 'zh', scope: 'page', displayMode: 'bilingual', textMode: 'plain', explanationLanguage: 'zh', model: 'deepseek-v4-flash', apiKey: '', rememberKey: false, configured: true, autoSites: [] };
  let active = false;
  window.chrome = {
    runtime: {
      sendMessage: async m => {
        if (m.type === 'GET_SETTINGS') return { ok: true, ...settings };
        if (m.type === 'GET_KEY') return { ok: true, apiKey: settings.apiKey };
        if (m.type === 'CHECK_KEY') return { ok: true, models: ['deepseek-v4-flash','deepseek-v4-pro'] };
        if (m.type === 'SAVE_SETTINGS') { Object.assign(settings, m.settings); settings.configured = Boolean(settings.apiKey); return { ok: true, ...settings }; }
        if (m.type === 'SET_AUTO_SITE') { settings.autoSites = m.enabled ? [m.origin] : []; return { ok: true, ...settings }; }
        if (m.type === 'TEST_API') return { ok: true, translations: ['你好，世界。（测试响应）'] };
        return { ok: true };
      },
      openOptionsPage: async () => { location.href = '/extension/options.html'; },
      connect: ({ name }) => {
        let messageHandler, disconnectHandler, stopped = false;
        return {
          onMessage: { addListener(fn) { messageHandler = fn; } },
          onDisconnect: { addListener(fn) { disconnectHandler = fn; } },
          disconnect() { stopped = true; disconnectHandler?.(); },
          async postMessage(message) {
            if (name !== 'lingoleaf-manual') return;
            const outputs = {
              plain: ['这是', '一段简洁译文。'],
              annotated: ['这是带简注的译文。\n\n', '简注\n语气自然；保留原意。'],
              detailed: ['翻译\n这是详细译文。\n\n', '含义与语气\n表达自然。\n\n重点用法\n示例用法。\n\n', '双语例句\nA clear example. 清晰的例子。']
            };
            for (const delta of outputs[message.mode]) { await new Promise(r => setTimeout(r, 45)); if (stopped) return; messageHandler?.({ delta }); }
            if (!stopped) { messageHandler?.({ done: true }); disconnectHandler?.(); }
          }
        };
      }
    },
    tabs: { query: async () => [{ id: 1, url: 'https://example.org/article' }], sendMessage: async (_id, m) => { if (m.type === 'START') active = true; if (['PAUSE', 'RESTORE'].includes(m.type)) active = false; return { ok: true, active, scope: settings.scope, displayMode: settings.displayMode, target: settings.target, translated: active ? 8 : 0, detected: active ? 12 : 0 }; } },
    permissions: { request: async () => true }
  };
})();
