'use strict';

/**
 * 专门验证工具栏在各种窗口宽度下不挤压标题。
 * 用 CDP 的 Emulation.setDeviceMetricsOverride 模拟不同宽度，
 * 不需要真的去改窗口大小（那样会抢用户焦点）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function main() {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tb-'));
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmpData}`],
    { stdio: 'ignore' });

  let ws;
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };

  try {
    let wsUrl = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        const list = await getJSON('/json/list');
        const page = list.find((t) => t.type === 'page');
        if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
      } catch { /* 等 */ }
      await sleep(500);
    }
    if (!wsUrl) throw new Error('CDP 连不上');

    ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      const t = setTimeout(() => { pending.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, 15000);
      pending.set(mid, {
        resolve: (v) => { clearTimeout(t); res(v); },
        reject: (e) => { clearTimeout(t); rej(e); },
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    await sleep(2500);

    // 先建几个目录，让标题有内容、侧栏有东西
    await ev(`(async () => {
      const st = await window.vault.getState();
      if (!st.courses.length) {
        await window.vault.courses.create('项目设计', '#5b8def', null);
        await window.vault.courses.create('课程文件', '#5b8def', null);
      }
      window.__vaultDebug.apply(await window.vault.getState());
    })()`);
    await sleep(400);

    /* 在各种宽度下测量 */
    const widths = [940, 1040, 1180, 1280, 1440, 1560];
    console.log('\n窗口宽度 → 标题宽度 / 是否截断：');

    for (const w of widths) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w, height: 820, deviceScaleFactor: 1, mobile: false,
      });
      await sleep(350);
      const m = await ev(`(() => {
        const h1 = document.querySelector('#viewTitle');
        const r = h1.getBoundingClientRect();
        const toolbar = document.querySelector('.toolbar');
        const right = document.querySelector('.toolbar-right');
        return {
          innerW: window.innerWidth,
          titleW: Math.round(r.width),
          truncated: h1.scrollWidth > h1.clientWidth + 1,
          toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth + 1,
          rightW: Math.round(right.getBoundingClientRect().width),
          // 标题有没有和右侧控件重叠
          overlap: (() => {
            const l = document.querySelector('.toolbar-left').getBoundingClientRect();
            const rr = right.getBoundingClientRect();
            return l.right > rr.left + 1;
          })(),
        };
      })()`);
      const ok = !m.truncated && !m.overlap && !m.toolbarOverflow;
      check(`${w}px 宽：标题 ${m.titleW}px${m.truncated ? ' 已截断' : ''}${m.overlap ? ' 重叠' : ''}`, ok,
        `右侧 ${m.rightW}px`);
    }

    await send('Emulation.clearDeviceMetricsOverride');
  } finally {
    if (ws) ws.close();
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(800);
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
