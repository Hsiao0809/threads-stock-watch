import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve('.');
const publicRoot = join(root, 'public');
const port = Number(process.env.PORT || 8787);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`).pathname;
  const filePath = resolveRoute(pathname);
  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Threads stock dashboard: http://127.0.0.1:${port}/`);
});

function resolveRoute(pathname) {
  if (pathname === '/' || pathname === '/index.html') return join(publicRoot, 'index.html');
  if (pathname === '/latest.json' || pathname === '/data/latest.json') return join(root, 'data', 'latest.json');

  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const publicFile = resolve(publicRoot, `.${normalized}`);
  if (!publicFile.startsWith(publicRoot)) return null;
  return publicFile;
}
