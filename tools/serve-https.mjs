/* 本地静态服务：给局域网里的手机调试用
 *
 * 默认走纯 HTTP 就够 —— 存档、音效、游戏本体都不需要安全上下文。
 *
 * 唯一必须 HTTPS 的场景：在 **Android 手机上** 验证震动反馈。
 * navigator.vibrate 要求安全上下文（http://<局域网IP> 不算），
 * 而且只有 Chromium 内核实现了它：iOS / Safari 从未实现，走 HTTPS 也不会震。
 *
 * 需要 HTTPS 时先生成自签证书：bash tools/make-cert.sh
 * 没有证书时自动降级为 HTTP，不会中断服务。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const certDir = path.join(root, '.cert');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

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

/* 本机局域网地址，方便直接照着敲到手机上 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/* 有证书走 HTTPS，没有就静默降级成 HTTP */
function loadCreds() {
  try {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch (e) {
    return null;
  }
}

const PORT = Number(process.env.PORT || process.env.HTTPS_PORT || 8766);
const EXTRA_HTTP_PORT = Number(process.env.HTTP_PORT || 0);
const creds = loadCreds();
const addrs = lanAddresses();

function announce(scheme, note) {
  console.log(note);
  const urls = addrs.map((a) => '  ' + scheme + '://' + a + ':' + PORT);
  console.log(urls.length ? '手机访问：\n' + urls.join('\n') : '手机访问：http://<本机IP>:' + PORT);
}

if (creds) {
  https.createServer(creds, serve).listen(PORT, '0.0.0.0', () => {
    announce('https', 'HTTPS 监听 ' + PORT + '（首次需在手机安装并信任 .cert/cert.pem，换网络或换证书后要重做）');
  });
} else {
  http.createServer(serve).listen(PORT, '0.0.0.0', () => {
    announce('http', '未找到 .cert/ 自签证书，已降级为纯 HTTP：' + PORT + '（存档 / 音效 / 游戏本体都不受影响）');
    console.log('只有需要在 Android 手机上验证震动反馈时才需要 HTTPS：bash tools/make-cert.sh');
    console.log('（iOS / Safari 从未实现 navigator.vibrate，走 HTTPS 也不会震）');
  });
}

if (EXTRA_HTTP_PORT) {
  http.createServer(serve).listen(EXTRA_HTTP_PORT, '0.0.0.0', () => {
    console.log('HTTP 监听 ' + EXTRA_HTTP_PORT);
  });
}
