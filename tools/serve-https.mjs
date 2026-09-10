/* 本地 HTTPS 静态服务：局域网手机调试用（震动 API 需要安全上下文） */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const certDir = path.join(root, '.cert');
const key = fs.readFileSync(path.join(certDir, 'key.pem'));
const cert = fs.readFileSync(path.join(certDir, 'cert.pem'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serve(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8766);
const HTTP_PORT = Number(process.env.HTTP_PORT || 0);

https.createServer({ key, cert }, serve).listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log('HTTPS https://0.0.0.0:' + HTTPS_PORT);
});
if (HTTP_PORT) {
  http.createServer(serve).listen(HTTP_PORT, '0.0.0.0', () => {
    console.log('HTTP  http://0.0.0.0:' + HTTP_PORT);
  });
}
