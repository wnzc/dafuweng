/* ============================================================
   生成 PWA 图标（assets/icon-*.png、assets/apple-touch-icon.png）
   ------------------------------------------------------------
   用 headless Chrome 逐尺寸渲染 tools/icon.html：
   视口设成目标尺寸，vmin 就正好等于图标的 1%，所以同一份 markup
   在 180 / 192 / 512 下都是等比精确的。

   跑法：node tools/make-icons.mjs
   前提：本机装了 Google Chrome（路径可用 CHROME 环境变量覆盖）
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const PORT = +(process.env.CDP_PORT || 9341);

const TARGETS = [
  { file: 'icon-192.png', size: 192, variant: 'any' },
  { file: 'icon-512.png', size: 512, variant: 'any' },
  { file: 'icon-maskable-512.png', size: 512, variant: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, variant: 'apple' }
];

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('找不到 Chrome。用 CHROME=/path/to/chrome node tools/make-icons.mjs 指定。');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method, params }));
        return new Promise((res, rej) => pending.set(mid, { res, rej }));
      },
      close() { ws.close(); }
    }));
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
  });
}

async function firstPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* 等 Chrome 起来 */ }
    await sleep(200);
  }
  throw new Error('Chrome 的调试端口一直没就绪');
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  ...(process.env.CI ? ['--no-sandbox'] : []),      // GitHub Actions 的 runner 上必须关沙箱
  'about:blank'
], { stdio: 'ignore' });

let cdp;
try {
  const page = await firstPageTarget();
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const src = pathToFileURL(path.join(ROOT, 'tools', 'icon.html')).href;
  fs.mkdirSync(ASSETS, { recursive: true });

  for (const t of TARGETS) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: t.size, height: t.size, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${src}#${t.variant}` });
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const ready = await evaluate('document.readyState').catch(() => '');
      if (ready === 'complete') break;
    }
    // hash 只在同文档内生效，导航到同 URL 换 hash 不会重新触发 script；
    // 这里显式同步一次变体，并让环上的格子按新半径重排，保证一定是目标形态
    await evaluate(`document.body.dataset.variant = ${JSON.stringify(t.variant)}; layoutCells();`);
    await sleep(220);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    if (buf.readUInt32BE(16) !== t.size || buf.readUInt32BE(20) !== t.size) {
      throw new Error(`${t.file} 尺寸不对：${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}，期望 ${t.size}`);
    }
    const out = path.join(ASSETS, t.file);
    fs.writeFileSync(out, buf);
    console.log(`· ${t.file.padEnd(24)} ${t.size}×${t.size}  ${t.variant.padEnd(9)} ${(buf.length / 1024).toFixed(1)} KB`);
  }
} finally {
  cdp?.close();
  chrome.kill('SIGKILL');
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 临时目录，忽略 */ }
}
