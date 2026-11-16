/* 抓参考版开关的真实 computed style，确认那圈橙色描边是什么 */
const fs = require('fs');
const path = require('path');

async function connect(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('.aurora'));
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
  await send('Runtime.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

(async () => {
  const cdp = await connect(Number(process.argv[2] || 9400));
  try {
    const r = await cdp.evaluate(`
      const sw = document.getElementById('sw');
      const cs = getComputedStyle(sw);
      const track = sw.querySelector('.track');
      const tcs = getComputedStyle(track);
      const knob = document.getElementById('knob');
      return {
        focused: document.activeElement === sw,
        swBoxShadow: cs.boxShadow,
        swOutline: cs.outline,
        swBorder: cs.border,
        swOverflow: cs.overflow,
        trackBorder: tcs.border,
        trackBoxShadow: tcs.boxShadow,
        knobBoxShadow: getComputedStyle(knob).boxShadow,
        dockVars: {
          kouter: getComputedStyle(document.getElementById('dock')).getPropertyValue('--kouter'),
          arc: getComputedStyle(document.getElementById('dock')).getPropertyValue('--arc'),
        },
      };
    `);
    console.log(JSON.stringify(r, null, 2));
  } finally { cdp.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
