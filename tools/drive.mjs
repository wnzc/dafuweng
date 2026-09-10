/* 极简 CDP 驱动：连上已在跑的 Chrome，执行 eval / 截图 / 点击。
   用法：node tools/drive.mjs <eval|shot|click|key|size> [args]            */
import fs from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;

async function findPage() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  return page;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method, params }));
        return new Promise((res, rej) => pending.set(mid, { res, rej }));
      },
      events,
      close() { ws.close(); }
    }));
    ws.addEventListener('error', e => reject(new Error('ws error')));
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const [, , cmd, ...args] = process.argv;
const page = await findPage();
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');

try {
  if (cmd === 'reload') {
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(+(args[0] || 2200));
    console.log('reloaded');
  } else if (cmd === 'eval') {
    const r = await cdp.send('Runtime.evaluate', {
      expression: args.join(' '),
      returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) {
      console.error('EXCEPTION:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(r.result.value, null, 2));
    }
  } else if (cmd === 'shot') {
    const [path, w, h] = args;
    if (w) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: +w, height: +h, deviceScaleFactor: 2, mobile: +w < 800
      });
      await sleep(350);
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path, Buffer.from(data, 'base64'));
    console.log('saved', path, fs.statSync(path).size, 'bytes');
  } else if (cmd === 'click') {
    const sel = args[0];
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const n = document.querySelector(${JSON.stringify(sel)});
        if (!n) return 'NOT_FOUND'; if (n.disabled) return 'DISABLED';
        n.click(); return 'OK'; })()`,
      returnByValue: true, userGesture: true
    });
    console.log(r.result.value);
  } else if (cmd === 'key') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: args[0], code: args[0] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: args[0], code: args[0] });
    console.log('key', args[0]);
  } else if (cmd === 'watch') {
    const ms = +(args[0] || 3000);
    await sleep(ms);
    const out = cdp.events
      .filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Runtime.consoleAPICalled' ||
        e.method === 'Log.entryAdded')
      .map(e => {
        if (e.method === 'Runtime.exceptionThrown') return 'EXCEPTION ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
        if (e.method === 'Runtime.consoleAPICalled') return e.params.type.toUpperCase() + ' ' + e.params.args.map(a => a.value ?? a.description ?? '').join(' ');
        return 'LOG ' + e.params.entry.level + ' ' + e.params.entry.text;
      });
    console.log(out.length ? out.join('\n') : '(no console output)');
  } else if (cmd === 'size') {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: +args[0], height: +args[1], deviceScaleFactor: 2, mobile: +args[0] < 800
    });
    console.log('size', args[0], args[1]);
  } else {
    console.error('unknown cmd', cmd);
    process.exitCode = 1;
  }
} finally {
  cdp.close();
}
