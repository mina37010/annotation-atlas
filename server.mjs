import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
const root = fileURLToPath(new URL('./dist/', import.meta.url));
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml' };
const headers = Object.fromEntries((await readFile(resolve(root, '_headers'), 'utf8')).split('\n').filter(line => /^\s+[^:]+:/.test(line)).map(line => { const i=line.indexOf(':'); return [line.slice(0,i).trim(),line.slice(i+1).trim()]; }));
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error();
    const content = await readFile(path);
    res.writeHead(200, { ...headers, 'Content-Type': (types[path.split('.').pop()] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.env.PORT || 5180), '127.0.0.1', () => console.log('Annotation Atlas  http://localhost:' + (process.env.PORT || 5180)));
