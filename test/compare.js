/* 同一 dpr、同一裁剪、同一倍率下截两边，做公平对比。
   用法：node test/compare.js */
const fs = require('fs');
const path = require('path');

async function open(port, urlHint) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.url.includes(urlHint));
  if (!page) throw new Error(`端口 ${port} 没有 ${urlHint}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', no, { once: true });
  });
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { ok, no } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) no(new Error(m.error.message)); else ok(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((ok, no) => {
    id += 1;
    waiting.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  /* 统一 dpr = 1，排除设备像素比干扰 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description)
        || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function grab(cdp, file) {
  const r = await cdp.evaluate(`
    const b = (document.querySelector('.tsw') || document.getElementById('sw')).getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  `);
  const pad = 8;
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
      width: r.w + pad * 2, height: r.h + pad * 2, scale: 6,
    },
  });
  const out = path.resolve(__dirname, file);
  fs.writeFileSync(out, Buffer.from(res.data, 'base64'));
  console.log(file, `${r.w.toFixed(1)}×${r.h.toFixed(1)}`);
  return r;
}

(async () => {
  /* 参考版 */
  const ref = await open(9400, '.aurora');
  try {
    await ref.evaluate(`
      const sl = document.querySelector('.sl');
      sl.style.width = '60px'; sl.style.height = '30px';
      sl.style.aspectRatio = 'auto'; sl.style.margin = '20px';
      dispatchEvent(new Event('resize'));
      await new Promise(r => setTimeout(r, 500));
    `);
    await grab(ref, '.cmp-ref.png');
  } finally { ref.close(); }

  /* 软件 */
  const app = await open(9333, 'index.html');
  try {
    await grab(app, '.cmp-app.png');
  } finally { app.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
