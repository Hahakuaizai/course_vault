/* 极简 CDP 客户端：后台驱动 Electron，不抢焦点、不弹窗口。
   用法：node test/cdp.js <脚本文件>
   脚本文件导出一个 async (cdp) => {...}，cdp 提供 eval / shot / wait。 */
const fs = require('fs');
const path = require('path');

async function connect() {
  const res = await fetch('http://127.0.0.1:9333/json/list');
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('没有找到页面');
  /* Node 24 自带 WebSocket，不用装 ws */
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', no, { once: true });
  });

  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) no(new Error(msg.error.message));
      else ok(msg.result);
    }
  });

  const send = (method, params = {}) => new Promise((ok, no) => {
    id += 1;
    waiting.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params }));
  });

  /** 在页面里执行一段代码，返回 JSON 化的结果 */
  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.value;
  }

  /** 截图存到 test/ 下 */
  async function shot(file, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const r = await send('Page.captureScreenshot', params);
    const out = path.resolve(__dirname, file);
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    return out;
  }

  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

  await send('Page.enable');
  await send('Runtime.enable');
  /* 让窗口真的活跃：后台窗口的 rAF 会被节流到 ~1fps，
     那样测出来的动画全是冻结的中间态（踩过好几次）。 */
  try { await send('Page.bringToFront'); } catch { /* 忽略 */ }
  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch { /* 忽略 */ }
  try {
    await send('Page.setWebLifecycleState', { state: 'active' });
  } catch { /* 忽略 */ }
  return { evaluate, shot, wait, send, close: () => ws.close() };
}

module.exports = { connect };

if (require.main === module) {
  (async () => {
    const target = process.argv[2];
    if (!target) { console.error('用法: node test/cdp.js <脚本>'); process.exit(1); }
    const cdp = await connect();
    try {
      const mod = require(path.resolve(__dirname, target));
      await mod(cdp);
    } finally {
      cdp.close();
    }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
