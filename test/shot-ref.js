/* 把参考版的开关压到 60px 宽，截一张和软件里同等条件的图做对比。
   .sl 的宽度由父容器决定（--sw 只控制侧栏宽度），所以要直接给它写死宽度。 */
const fs = require('fs');
const path = require('path');

async function connect(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('.aurora'));
  if (!page) throw new Error('没有找到参考版页面: ' + list.map((t) => t.url).join(', '));
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
      if (m.error) no(new Error(m.error.message));
      else ok(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((ok, no) => {
    id += 1;
    waiting.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description)
        || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

(async () => {
  const port = Number(process.argv[2] || 9400);
  const scale = Number(process.argv[3] || 8);
  const theme = process.argv[4] || 'light';
  const cdp = await connect(port);
  try {
    /* 参考版的开关槽 .sl 是 aspect-ratio 440/230 的块，宽度由父容器给。
       直接写死 60px 宽，就是「和软件里一样大」的条件。
       顺便把主题设成和软件里当前一致，否则一个浅一个深没法比。 */
    const r = await cdp.evaluate(`
      const app = document.getElementById('appD');
      const sw = document.getElementById('sw');
      // 通过点开关把主题切到目标态（脚本里 pos 是内部状态，只能点）
      const want = '${theme}';
      const isLight = sw.getAttribute('aria-checked') === 'true';
      if ((want === 'light') !== isLight) sw.click();
      await new Promise(r => setTimeout(r, 1400));
      const sl = document.querySelector('.sl');
      sl.style.width = '60px';
      sl.style.height = '31.4px';
      sl.style.aspectRatio = 'auto';
      sl.style.margin = '20px';
      /* dock 的 scale 只在 resize 里算，改完尺寸必须触发一次 */
      dispatchEvent(new Event('resize'));
      await new Promise(r => setTimeout(r, 500));
      const b = document.getElementById('dock').getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height,
               checked: sw.getAttribute('aria-checked') };
    `);
    console.log('参考版开关', JSON.stringify(r));
    const pad = 6;
    const res = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: Math.max(0, r.x - pad),
        y: Math.max(0, r.y - pad),
        width: r.w + pad * 2,
        height: r.h + pad * 2,
        scale,
      },
    });
    const out = path.resolve(__dirname, `.shot-ref-${theme}.png`);
    fs.writeFileSync(out, Buffer.from(res.data, 'base64'));
    console.log('已存', out);
  } finally {
    cdp.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
