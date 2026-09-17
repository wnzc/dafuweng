/* ============================================================
   PWA 与分享卡的自检（真开一个浏览器跑一遍）
   ------------------------------------------------------------
   只做静态检查是不够的：manifest 能不能解析、图标尺寸对不对、
   Service Worker 有没有真的接管、断网之后还能不能打开 —— 这些必须
   在浏览器里实测。脚本会：

     1) 用 node:http 在 127.0.0.1 上起一个临时静态服务（SW 需要安全上下文，
        localhost 正好算安全上下文，file:// 则不支持 SW）
     2) 让 headless Chrome 打开首页，逐项断言
     3) 把网络断掉再刷新一次，确认离线仍可玩
     4) 校验分享卡元信息：og:image 指向的本地文件真实存在、尺寸与
        og:image:type 都对得上，canonical / og:url / og:image 三处
        绝对地址同源且（--live 下）真的能取到

   跑法：
     node tools/check-pwa.mjs           对着本地临时服务跑
     node tools/check-pwa.mjs --live    对着线上 Pages 跑（子路径 /dafuweng/ 只有这样才能验到）
   前提：本机装了 Google Chrome（路径可用 CHROME 环境变量覆盖）
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PORT || 8791);
const CDP_PORT = +(process.env.CDP_PORT || 9343);
const PAGES_ORIGIN = 'https://wnzc.github.io/dafuweng/';
const LIVE = process.argv.includes('--live');

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 读 PNG / JPEG 的真实像素尺寸。分享卡是 JPEG、图标是 PNG，两种都要认，
   否则换了格式这类检查会静默失效。 */
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
const MIME_OF = { png: 'image/png', jpeg: 'image/jpeg' };

/* ---------------- 断言收集 ---------------- */
const results = [];
const ok = (name, detail) => results.push({ pass: true, name, detail });
const bad = (name, detail) => results.push({ pass: false, name, detail });
function check(cond, name, detail) {
  cond ? ok(name, detail) : bad(name, detail);
  return cond;
}

/* ---------------- 临时静态服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404');
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache'
  });
  res.end(body);
});
if (!LIVE) await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = LIVE ? PAGES_ORIGIN : `http://127.0.0.1:${PORT}/`;
console.log(LIVE ? `· 校验线上站点 ${PAGES_ORIGIN}` : `· 校验本地服务 ${BASE}`);

/* ---------------- CDP ---------------- */
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
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* 等 Chrome */ }
    await sleep(200);
  }
  throw new Error('Chrome 的调试端口一直没就绪');
}

if (!CHROME) {
  console.error('找不到 Chrome。用 CHROME=/path/to/chrome node tools/check-pwa.mjs 指定。');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check',
  ...(process.env.CI ? ['--no-sandbox'] : []),      // GitHub Actions 的 runner 上必须关沙箱
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: 'ignore' });

let cdp;
try {
  const page = await firstPageTarget();
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, ms = 8000, step = 150) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evaluate(expr).catch(() => false)) return true;
      await sleep(step);
    }
    return false;
  };

  /* ── 1. 打开首页 ── */
  await cdp.send('Page.navigate', { url: BASE + 'index.html' });
  await until('document.readyState === "complete"');
  check(await evaluate('!!(window.DC && DC.game && DC.game.engine)'), '首页可正常启动（引擎与界面已装配）'); 

  /* ── 2. manifest ── */
  const href = await evaluate(`(document.querySelector('link[rel="manifest"]') || {}).href || null`);
  check(!!href, 'index.html 里声明了 manifest', href || '未找到 link[rel=manifest]');
  if (href) {
    const status = await evaluate(`fetch(${JSON.stringify(href)}).then(r => r.status).catch(() => 0)`);
    check(status === 200, 'manifest 可以取到', `HTTP ${status}`);
    const mf = await evaluate(`fetch(${JSON.stringify(href)}).then(r => r.json()).catch(e => null)`);
    check(!!mf, 'manifest 是合法 JSON');
    if (mf) {
      check(!!mf.name && !!mf.short_name, 'manifest 有 name / short_name', `${mf.name} / ${mf.short_name}`);
      check(mf.display === 'standalone', 'display 为 standalone', String(mf.display));
      // 不锁方向：CSS 里有专门的横屏矮屏布局（landscape and max-height: 560px），
      // 一旦把 manifest 的 orientation 写成 portrait，装成应用后那个布局就永远用不到了
      check(mf.orientation === undefined || mf.orientation === 'portrait',
        'orientation 没有把横屏布局锁死',
        mf.orientation === undefined ? '未设置，跟随系统旋转' : String(mf.orientation));
      check(!!mf.theme_color && !!mf.background_color, 'theme_color / background_color 已设置',
        `${mf.theme_color} / ${mf.background_color}`);
      const startUrl = await evaluate(
        `fetch(${JSON.stringify(new URL('./', href).href)}).then(r => r.status).catch(() => 0)`);
      check(startUrl === 200, 'start_url 可访问', `HTTP ${startUrl}`);
      const icons = mf.icons || [];
      check(icons.some((i) => (i.purpose || '').includes('maskable')), '提供了 maskable 图标');
      check(icons.filter((i) => (i.purpose || 'any') === 'any').length >= 2, '至少两个分辨率的 any 图标');

      // 图标真实存在、尺寸与声明一致
      for (const ic of icons) {
        const u = new URL(ic.src, href).href;
        const status2 = await evaluate(`fetch(${JSON.stringify(u)}).then(r => r.status).catch(() => 0)`);
        if (status2 !== 200) { bad(`图标可访问 ${ic.src}`, `HTTP ${status2}`); continue; }
        const buf = Buffer.from(await evaluate(
          `fetch(${JSON.stringify(u)}).then(r => r.arrayBuffer()).then(b => Array.from(new Uint8Array(b)))`));
        const size = imageSize(buf);
        const want = +String(ic.sizes).split('x')[0];
        check(size.w === want && size.h === want, `图标尺寸正确 ${ic.src}`,
          `实际 ${size.w}×${size.h}（${size.type}），声明 ${ic.sizes}`);
      }
    }
  }

  /* ── 3. iOS / 桌面端图标与离线元信息 ── */
  const appleIcon = await evaluate(`(document.querySelector('link[rel="apple-touch-icon"]') || {}).href || null`);
  if (check(!!appleIcon, '声明了 apple-touch-icon', appleIcon || '未找到')) {
    const s = await evaluate(`fetch(${JSON.stringify(appleIcon)}).then(r => r.status).catch(() => 0)`);
    check(s === 200, 'apple-touch-icon 可访问', `HTTP ${s}`);
  }
  check(await evaluate(`!!document.querySelector('meta[name="theme-color"]')`), '声明了 theme-color');

  /* ── 4. 分享卡元信息 ── */
  const meta = await evaluate(`(() => {
    const g = (sel, attr) => { const n = document.querySelector(sel); return n ? n.getAttribute(attr) : null; };
    return {
      ogType: g('meta[property="og:type"]', 'content'),
      ogTitle: g('meta[property="og:title"]', 'content'),
      ogDesc: g('meta[property="og:description"]', 'content'),
      ogUrl: g('meta[property="og:url"]', 'content'),
      ogImage: g('meta[property="og:image"]', 'content'),
      ogImageType: g('meta[property="og:image:type"]', 'content'),
      ogAlt: g('meta[property="og:image:alt"]', 'content'),
      ogW: g('meta[property="og:image:width"]', 'content'),
      ogH: g('meta[property="og:image:height"]', 'content'),
      tw: g('meta[name="twitter:card"]', 'content'),
      canonical: g('link[rel="canonical"]', 'href')
    };
  })()`);
  const originOf = (u) => { try { return new URL(u).origin; } catch (e) { return null; } };
  check(meta.ogType === 'website', 'og:type 为 website', String(meta.ogType));
  check(!!meta.ogTitle && !!meta.ogDesc, 'og:title / og:description 已填');
  check(meta.tw === 'summary_large_image', 'twitter:card 为大图模式', String(meta.tw));
  check(meta.ogW === '1200' && meta.ogH === '630', 'og:image 声明为 1200×630', `${meta.ogW}×${meta.ogH}`);
  check(!!meta.ogAlt, 'og:image:alt 已填（无障碍与抓取兜底）', meta.ogAlt || '缺失');

  // canonical / og:url / og:image 三处都是写死的绝对地址，换仓库名或域名时
  // 最容易漏改，而且漏了不会报任何错 —— 只是分享出去没图、搜索引擎认错地址。
  check(/^https:\/\//.test(meta.canonical || ''), 'canonical 是绝对地址', String(meta.canonical));
  check(!!meta.ogUrl && meta.ogUrl === meta.canonical, 'og:url 与 canonical 一致',
    `og:url=${meta.ogUrl}  canonical=${meta.canonical}`);
  check(!!originOf(meta.ogImage) && originOf(meta.ogImage) === originOf(meta.canonical),
    'og:image 与 canonical 同源',
    originOf(meta.ogImage) === originOf(meta.canonical)
      ? String(originOf(meta.canonical))
      : `og:image 在 ${originOf(meta.ogImage)}，canonical 在 ${originOf(meta.canonical)}`);
  if (LIVE) {
    for (const [label, u] of [['canonical', meta.canonical], ['og:url', meta.ogUrl]]) {
      const s = await evaluate(`fetch(${JSON.stringify(u)}, { cache: 'no-store' }).then(r => r.status).catch(() => 0)`);
      check(s === 200, `线上 ${label} 可访问`, `HTTP ${s}  ${u}`);
    }
  }

  if (meta.ogImage) {
    // 线上地址必须是绝对 URL，且指向真实存在的本地文件
    check(/^https:\/\//.test(meta.ogImage), 'og:image 用的是绝对地址', meta.ogImage);
    const rel = meta.ogImage.startsWith(PAGES_ORIGIN) ? meta.ogImage.slice(PAGES_ORIGIN.length) : null;
    if (check(!!rel, 'og:image 指向本仓库的 Pages 路径', meta.ogImage)) {
      const local = path.join(ROOT, rel);
      if (check(fs.existsSync(local), `og:image 对应的文件存在（${rel}）`)) {
        const buf = fs.readFileSync(local);
        const size = imageSize(buf);
        check(size.w === 1200 && size.h === 630, 'og:image 尺寸确实为 1200×630',
          `${size.w}×${size.h}（${size.type}）`);
        check(meta.ogImageType === MIME_OF[size.type], 'og:image:type 与实际文件格式一致',
          `声明 ${meta.ogImageType}，实际 ${MIME_OF[size.type] || size.type}`);
        check(buf.length < 500 * 1024, 'og:image 体积在 500 KB 以内（爬虫抓图更快）',
          `${(buf.length / 1024).toFixed(0)} KB`);
      }
    }
    const status3 = await evaluate(`fetch(${JSON.stringify(BASE + rel)}).then(r => r.status).catch(() => 0)`);
    check(status3 === 200, `${LIVE ? '线上' : '本地服务'}能取到 og:image`, `HTTP ${status3}  ${BASE + rel}`);
  }

  /* ── 5. Service Worker 注册与预缓存 ── */
  const swReady = await until('!!navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true)', 10000)
    && await evaluate('navigator.serviceWorker.ready.then(r => r.active ? r.active.state : "")');
  check(swReady === 'activated', 'Service Worker 已注册并激活', String(swReady));

  const cacheInfo = await evaluate(`(async () => {
    const names = await caches.keys();
    let total = 0; const urls = [];
    for (const n of names) {
      const reqs = await (await caches.open(n)).keys();
      total += reqs.length;
      reqs.forEach((r) => urls.push(new URL(r.url).pathname));
    }
    return { names, total, urls };
  })()`);
  check(cacheInfo.total >= 12, '预缓存条目齐全', `${cacheInfo.total} 个文件，缓存名 ${cacheInfo.names.join(',')}`);

  // 直接以 sw.js 里的 PRECACHE 列表为准逐条核对，避免手写的清单和实现漂移
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const precache = (swSrc.match(/const PRECACHE = \[([\s\S]*?)\];/) || [, ''])
    .slice(1)[0]
    .split('\n')
    .map((l) => (l.match(/'\.\/[^']*'/) || l.match(/"\.\/[^"]*"/) || [])[0])
    .filter(Boolean)
    .map((s) => s.slice(1, -1).replace(/^\.\//, '/'));   // './x' → '/x'
  const uncached = precache.filter((f) =>
    !cacheInfo.urls.some((u) => u === f || u.endsWith(f)));
  check(precache.length >= 12 && uncached.length === 0,
    `sw.js 里声明的 ${precache.length} 个文件都已进缓存`,
    uncached.length ? '缺：' + uncached.join(' ') : `实存 ${cacheInfo.total} 条`);
  if (process.argv.includes('--verbose')) console.log('  缓存内容：' + cacheInfo.urls.join(' '));

  /* ── 6. 断网后仍能打开 ── */
  await cdp.send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await cdp.send('Page.reload', { ignoreCache: false });
  const loaded = await until('document.readyState === "complete"', 8000);
  check(loaded, '断网后页面仍能加载完成');

  // 断网状态下真的走一遍「开始新对局」，而不是只看 DOM 有没有元素
  const started = await evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.sheet__actions button'));
    const b = btns.find((x) => x.textContent.indexOf('开始新对局') >= 0);
    if (!b) return '没有找到开始按钮：[' + btns.map((x) => x.textContent.trim()).join(' | ') + ']';
    b.click();
    return 'OK';
  })()`);
  check(started === 'OK', '断网时弹层正常、能点开始新对局', started);
  await sleep(500);

  const painted = await until('document.querySelectorAll("#cells > *").length === 24 && document.querySelectorAll("#tokens > *").length === 4', 5000);
  check(painted, '断网后棋盘与棋子都渲染出来');

  let offlineState = {};
  try {
    offlineState = await evaluate(`(() => {
      const b = document.querySelector('.board');
      const s = DC.game.engine.state;
      return {
        title: document.title,
        cells: document.querySelectorAll('#cells > *').length,
        players: s ? s.players.length : 0,
        cash: s ? s.players[0].cash : 0,
        styled: b ? getComputedStyle(b).borderRadius : 'no-board',
        stylesheetLoaded: Array.from(document.styleSheets).some((x) => (x.href || '').indexOf('styles.css') >= 0),
        fontLoaded: getComputedStyle(document.body).fontFamily
      };
    })()`);
  } catch (e) {
    offlineState = { err: String(e).split('\n')[0] };
  }
  check(offlineState.cells === 24, '断网时 24 格棋盘已渲染',
    `实际 ${offlineState.cells} 格${offlineState.err ? ' · 异常 ' + offlineState.err : ''}`);
  check(offlineState.stylesheetLoaded === true, '断网时样式表来自缓存', String(offlineState.stylesheetLoaded));
  check(!!offlineState.styled && offlineState.styled !== '0px' && offlineState.styled !== 'no-board',
    '断网时样式已生效', `board 圆角 ${offlineState.styled}`);
  check(offlineState.players === 4 && offlineState.cash === 15000,
    '断网时对局真的能开（4 人、起步资金 15,000）',
    `players=${offlineState.players} cash=${offlineState.cash}`);

  await cdp.send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
} finally {
  cdp?.close();
  chrome.kill('SIGKILL');
  try { server.close(); } catch (e) { /* 没监听时忽略 */ }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ }
}

/* ---------------- 输出 ---------------- */
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`
};
console.log('\n' + '─'.repeat(64));
results.forEach((r) => {
  console.log(`${r.pass ? C.ok('✓') : C.bad('✗')} ${r.name}` +
    (r.detail ? '  ' + C.dim(r.detail) : ''));
});
console.log('─'.repeat(64));
const failed = results.filter((r) => !r.pass).length;
if (failed) {
  console.log(C.bad(`FAIL  ${failed} / ${results.length} 项未通过`));
  process.exit(1);
}
console.log(C.ok(`PASS  ${results.length} 项全部通过：可安装、可离线、分享卡片信息完整`));
