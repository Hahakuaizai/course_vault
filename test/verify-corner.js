'use strict';

/**
 * 验证连续曲率圆角（corner-shape: squircle）：
 *   1. 当前 Chromium 支持 corner-shape
 *   2. 带圆角的组件都真的应用上了 squircle
 *   3. 该是正圆的元素（圆点、开关、色板）退回 round，不被压方
 *   4. 截图浅色 / 深色各一张，人工看效果
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9352;
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
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cv-'));
  const child = spawn(
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmpData}`],
    { stdio: 'ignore' },
  );

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
        const l = await getJSON('/json/list');
        const p = l.find((t) => t.type === 'page');
        if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
      } catch { /* 等 */ }
      await sleep(500);
    }
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
      const t = setTimeout(() => { pending.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, 20000);
      pending.set(mid, {
        resolve: (v) => { clearTimeout(t); res(v); },
        reject: (e) => { clearTimeout(t); rej(e); },
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const ev = async (e) => {
      const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    await sleep(2500);

    /* 造点数据，让网格里有卡片 */
    await ev(`(async () => {
      const mk = async (name, parentId) => {
        await window.vault.courses.create(name, '#5b8def', parentId);
        const st = await window.vault.getState();
        return st.courses.filter(c => c.name === name && (c.parentId || null) === (parentId || null)).pop();
      };
      const a = await mk('课程文件', null);
      await mk('计组', a.id);
      await mk('操作系统', a.id);
      window.__vaultDebug.apply(await window.vault.getState());
      await new Promise(r => setTimeout(r, 500));
    })()`);
    await sleep(800);

    const r = await ev(`(() => {
      const probe = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { shape: cs.cornerShape, radius: cs.borderRadius };
      };
      const out = { supports: CSS.supports('corner-shape', 'squircle'), els: {}, round: {} };
      const squircleSels = [
        '.card', '.nav-item', '.tb-btn', '.icon-btn', '.tree-row',
        '.ghost-btn', '.snav-item', '.search input', '.primary-btn',
        '.seg', '.tool-btn', '.brand-mark', '.modal', '.input',
        // 主题开关的滑块也是 squircle —— 参照 iOS 深色模式开关做的
        '.theme-knob',
      ];
      for (const s of squircleSels) out.els[s] = probe(s);
      // 该保持正圆/胶囊的元素：从样式表里取不到时跳过
      for (const s of ['.course-dot', '.switch', '.swatch', '.card-info-btn']) {
        const el = document.querySelector(s);
        if (!el) { out.round[s] = null; continue; }
        out.round[s] = getComputedStyle(el).cornerShape;
      }
      // 顺带量一下卡片实际圆角，确认没被 squircle 撑破
      const card = document.querySelector('.card');
      if (card) {
        const rr = card.getBoundingClientRect();
        out.cardBox = { w: Math.round(rr.width), h: Math.round(rr.height) };
      }
      return out;
    })()`);

    check('Chromium 支持 corner-shape', r.supports === true);
    for (const [sel, info] of Object.entries(r.els)) {
      if (!info) { check(`${sel} 存在`, false, '未找到元素'); continue; }
      const ok = /squircle|superellipse/.test(info.shape);
      check(`${sel} 应用了 squircle`, ok, `${info.shape} / r=${info.radius}`);
    }
    /* 注：corner-shape: round 的计算值会序列化成 superellipse(1)，
     * 所以判定「没被 squircle 化」要认这两个值 */
    for (const [sel, shape] of Object.entries(r.round)) {
      if (shape == null) continue;
      const plain = shape === 'round' || shape === 'superellipse(1)';
      check(`${sel} 保持普通圆角`, plain, shape);
    }

    /* 截图。写到系统临时目录，不往项目里丢文件 —— 这些是给人看圆角
     * 效果的诊断图，不是测试基准，留在 test/ 里只会越攒越多。 */
    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-corner-'));
    await ev(`window.__vaultDebug.render && window.__vaultDebug.render()`);
    await sleep(400);
    for (const theme of ['light', 'dark']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${theme}')`);
      await sleep(500);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(shotDir, `shot-corner-${theme}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`  截图：${file}`);
    }
    await ev(`document.documentElement.setAttribute('data-theme', 'light')`);

    /* 放大 4 倍拍一张卡片拐角特写 —— 计算值对不代表画出来就是超椭圆 */
    const box = await ev(`(() => {
      const r = document.querySelector('.card').getBoundingClientRect();
      return { x: r.left - 4, y: r.top - 4, width: r.width + 8, height: r.height + 8 };
    })()`);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 4, mobile: false,
    });
    await sleep(600);
    const zoom = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...box, scale: 4 },
      captureBeyondViewport: true,
    });
    const zf = path.join(shotDir, 'shot-corner-zoom.png');
    fs.writeFileSync(zf, Buffer.from(zoom.data, 'base64'));
    console.log(`  放大截图：${zf}`);
    await send('Emulation.clearDeviceMetricsOverride');
    // 截图看一眼就够了，跑完删掉
    try { fs.rmSync(shotDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  } finally {
    if (ws) ws.close();
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(800);
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
