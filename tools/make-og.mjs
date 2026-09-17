/* ============================================================
   生成分享卡 assets/og-cover.png（1200×630）
   ------------------------------------------------------------
   做两件事：
     1) 用 headless Chrome 打开真实游戏，铺一个好看的盘面，截取
        「HUD + 玩家条 + 棋盘」那块（2 倍像素）；
     2) 把截图嵌进 tools/og-card.html，整页截成 1200×630。

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
const OUT = path.join(ROOT, 'assets', 'og-cover.png');
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

  const card = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(card.data, 'base64'));

  const buf = fs.readFileSync(OUT);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  log(`已写出 ${path.relative(ROOT, OUT)}  ${w}×${h}  ${(buf.length / 1024).toFixed(1)} KB`);
} finally {
  cdp?.close();
  chrome.kill('SIGKILL');
  await sleep(300);                      // 等 Chrome 真的退出，否则 user-data-dir 还在被写
  for (const dir of [tmp, profile]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { /* 临时目录删不掉不影响结果，系统会回收 */ }
  }
}
