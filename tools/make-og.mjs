/* ============================================================
   生成分享卡 assets/og-cover.jpg（1200×630）
   ------------------------------------------------------------
   做两件事：
     1) 用 headless Chrome 打开真实游戏，铺一个好看的盘面，截取
        「HUD + 玩家条 + 棋盘」那块（2 倍像素）；
     2) 把截图嵌进 tools/og-card.html，整页截成 1200×630。

   为什么出 JPEG 而不是 PNG：卡片是渐变 + 文字，PNG 无损要 568 KB，
   JPEG q86 只有约 100 KB 且肉眼无差；爬虫抓卡片时更省时。
   卡片本身不透明，用不到 PNG 的 alpha 通道。

   中间产物全部落在系统临时目录，仓库里只留最终那张图。

   跑法：node tools/make-og.mjs
   前提：本机装了 Google Chrome（路径可用 CHROME 环境变量覆盖）
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'og-cover.jpg');
const QUALITY = 86;
const PORT = +(process.env.CDP_PORT || 9339);

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('找不到 Chrome。用 CHROME=/path/to/chrome node tools/make-og.mjs 指定。');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);

/* 读 PNG / JPEG 的真实像素尺寸，用来验证截出来的图确实是 1200×630 */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {            // JPEG：顺序扫段找 SOFn
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0–SOF15 里除了 DHT(0xC4) / JPG(0xC8) / DAC(0xCC) 都带尺寸
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return { type: 'unknown', w: 0, h: 0 };
}

/* ---------------- 最小 CDP 客户端 ---------------- */
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
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('Chrome 的调试端口一直没就绪');
}

/* ---------------- 主流程 ---------------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'og-chrome-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-card-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--allow-file-access-from-files',
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
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  const goto = async (url) => {
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      await sleep(120);
      const ready = await evaluate('document.readyState').catch(() => '');
      if (ready === 'complete') return;
    }
  };

  /* ── 1. 截取真实手机画面 ── */
  log('渲染游戏页面…');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await sleep(500);

  // 关掉开局弹层，铺一个「玩到中局」的盘面：有主的地、几栋房子、四个玩家散开
  await evaluate(`(() => {
    const g = window.DC.game;
    g.ui.closeSheet();
    g.engine.newGame(4);
    const s = g.engine.state;
    const plan = { 1:0, 3:1, 5:2, 7:0, 9:1, 10:3, 11:0, 13:2, 15:1, 16:3, 17:0, 19:2, 21:1, 22:0, 23:3 };
    Object.keys(plan).forEach(function (k) {
      const i = +k, owner = plan[k];
      s.owners[i] = owner;
      if (s.players[owner].props.indexOf(i) < 0) s.players[owner].props.push(i);
    });
    const lv = { 1:2, 3:1, 11:3, 13:1, 17:4, 22:2 };
    Object.keys(lv).forEach(function (k) { s.houses[+k] = lv[k]; });
    s.players.forEach(function (p, i) { p.pos = [5, 13, 19, 22][i]; });
    s.players.forEach(function (p, i) { p.cash = [18800, 13000, 17200, 9400][i]; });
    s.round = 7; s.die = 5;
    g.engine.emit('state');
    return 'ok';
  })()`);
  await sleep(900);

  const box = await evaluate(`(() => {
    const app = document.querySelector('.app');
    const board = document.querySelector('.board');
    const a = app.getBoundingClientRect(), b = board.getBoundingClientRect();
    return { x: a.x, y: a.y, w: a.width, h: b.bottom - a.top + 8 };
  })()`);
  log(`游戏画面区域 ${Math.round(box.w)}×${Math.round(box.h)}（CSS 像素）`);

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 }
  });
  const boardPath = path.join(tmp, '.og-board.png');
  fs.writeFileSync(boardPath, Buffer.from(shot.data, 'base64'));
  log(`截取完成 ${fs.statSync(boardPath).size} 字节`);

  /* ── 2. 渲染分享卡 ── */
  fs.copyFileSync(path.join(ROOT, 'tools', 'og-card.html'), path.join(tmp, 'og-card.html'));
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
  log('渲染分享卡…');
  await goto(pathToFileURL(path.join(tmp, 'og-card.html')).href);
  await sleep(700);

  /* 版式自检：真机画面（含旋转与投影后的外接矩形）必须完整落在画布里。
     之前靠肉眼看缩略图判断，溢出过一次；改成量出来。 */
  const geo = await evaluate(`(() => {
    const rect = (s) => {
      const n = document.querySelector(s);
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) };
    };
    return { left: rect('.left'), right: rect('.right'), phone: rect('.phone'), die: rect('.die'), url: rect('.url') };
  })()`);
  const shown = [geo.phone, geo.die].filter(Boolean);
  const bounds = {
    l: Math.min(...shown.map((x) => x.l)), t: Math.min(...shown.map((x) => x.t)),
    r: Math.max(...shown.map((x) => x.r)), b: Math.max(...shown.map((x) => x.b))
  };
  log(`真机画面外接矩形 x ${bounds.l}–${bounds.r}  y ${bounds.t}–${bounds.b}（画布 1200×630）`);
  const overflow = [];
  if (bounds.r > 1200 - 18) overflow.push(`右边超出 ${bounds.r - (1200 - 18)}px`);
  if (bounds.l < 18) overflow.push(`左边超出 ${18 - bounds.l}px`);
  if (bounds.b > 630 - 18) overflow.push(`下边超出 ${bounds.b - (630 - 18)}px`);
  if (bounds.t < 18) overflow.push(`上边超出 ${18 - bounds.t}px`);
  if (geo.left && geo.right && geo.left.r > geo.right.l + 1) overflow.push('左右两栏重叠');
  if (overflow.length) {
    console.error('✗ 版式溢出：' + overflow.join('，') + '（改 tools/og-card.html 的尺寸再重跑）');
    process.exitCode = 1;
  } else {
    log('版式自检通过：画面完整落在画布内，未压到金框');
  }

  const card = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(card.data, 'base64'));

  const buf = fs.readFileSync(OUT);
  const size = imageSize(buf);
  log(`已写出 ${path.relative(ROOT, OUT)}  ${size.w}×${size.h}  ${(buf.length / 1024).toFixed(1)} KB`);
  if (size.w !== 1200 || size.h !== 630) process.exitCode = 1;
} finally {
  cdp?.close();
  chrome.kill('SIGKILL');
  await sleep(300);                      // 等 Chrome 真的退出，否则 user-data-dir 还在被写
  for (const dir of [tmp, profile]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { /* 临时目录删不掉不影响结果，系统会回收 */ }
  }
}
