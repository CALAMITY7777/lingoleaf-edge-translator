// Local browser fixtures use simulated chrome APIs and never call DeepSeek.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, '../extension'), fixtures = resolve(here, 'browser');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const base = path.startsWith('/extension/') ? extension : fixtures;
    const file = resolve(base, '.' + (path.startsWith('/extension/') ? path.slice(10) : path === '/' ? '/article.html' : path));
    if (!file.startsWith(base + sep)) { res.writeHead(403); return res.end(); }
    let content = await readFile(file);
    if (base === extension && extname(file) === '.html') content = content.toString().replace('<head>', '<head><script src="/mock-ui.js"></script>');
    res.writeHead(200, { 'Content-Type': (types[extname(file)] || 'text/plain') + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(19403, '127.0.0.1', () => console.log('正文测试 http://127.0.0.1:19403/article.html\n整页测试 http://127.0.0.1:19403/fixture.html\n界面模拟 http://127.0.0.1:19403/extension/popup.html\nCtrl+C 停止。'));
