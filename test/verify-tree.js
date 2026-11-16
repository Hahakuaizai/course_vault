'use strict';

/**
 * 验证侧栏目录树的层级视觉：
 *   1. 每层缩进足够（>= 20px），父子不会看着对齐
 *   2. 子目录有竖线，顶层没有
 *   3. 竖线和横杠的位置正确（不压住折叠箭头、不超出到名字）
 *   4. 竖线颜色足够明显（不是几乎透明）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9350;
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
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tv-'));
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
      const t = setTimeout(() => { pending.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, 15000);
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

    /* 造三层目录树 */
    await ev(`(async () => {
      const mk = async (name, parentId) => {
        await window.vault.courses.create(name, '#5b8def', parentId);
        const st = await window.vault.getState();
        return st.courses.filter(c => c.name === name && (c.parentId || null) === (parentId || null)).pop();
      };
      const a = await mk('父目录', null);
      const b = await mk('子目录', a.id);
      await mk('孙目录', b.id);
      await mk('另一个子目录', a.id);
      window.__vaultDebug.apply(await window.vault.getState());
      await new Promise(r => setTimeout(r, 500));
    })()`);
    await sleep(700);

    const m = await ev(`(() => {
      const rows = [...document.querySelectorAll('#courseList .tree-row')];
      return rows.map(r => {
        const rr = r.getBoundingClientRect();
        const el = r.querySelector('.tree-elbow');
        const caret = r.querySelector('.tree-caret');
        const name = r.querySelector('.tree-name');
        const er = el ? el.getBoundingClientRect() : null;
        const cr = caret ? caret.getBoundingClientRect() : null;
        const nr = name ? name.getBoundingClientRect() : null;
        const cs = el ? getComputedStyle(el) : null;
        const after = el ? getComputedStyle(el, '::after') : null;
        return {
          name: name?.textContent,
          depth: Number(getComputedStyle(r).getPropertyValue('--depth') || 0),
          rowH: Math.round(rr.height),
          rowLeft: Math.round(rr.left),
          nameLeft: nr ? Math.round(nr.left) : null,
          caretLeft: cr ? Math.round(cr.left) : null,
          caretRight: cr ? Math.round(cr.right) : null,
          elbowLeft: er ? Math.round(er.left) : null,
          elbowRight: er ? Math.round(er.right) : null,
          elbowH: er ? Math.round(er.height) : null,
          lineColor: cs ? cs.borderLeftColor : null,
          lineWidth: cs ? cs.borderLeftWidth : null,
          afterW: after ? after.width : null,
        };
      });
    })()`);

    console.log('\n渲染结果：');
    m.forEach((r) => {
      console.log(`  ${'  '.repeat(r.depth)}${r.name}  depth=${r.depth} 名字x=${r.nameLeft} 箭头=[${r.caretLeft},${r.caretRight}] 树线=${r.elbowLeft == null ? '无' : `[${r.elbowLeft},${r.elbowRight}]`}`);
    });

    const root = m.find((r) => r.name === '父目录');
    const child = m.find((r) => r.name === '子目录');
    const grand = m.find((r) => r.name === '孙目录');

    /* 1. 缩进 */
    const indent1 = child.nameLeft - root.nameLeft;
    const indent2 = grand.nameLeft - child.nameLeft;
    check('子级缩进 >= 20px', indent1 >= 20, `${indent1}px`);
    check('孙级缩进一致', Math.abs(indent2 - indent1) <= 1, `${indent2}px`);

    /* 2. 顶层无树线，子级有 */
    check('顶层目录没有树线', root.elbowLeft === null);
    check('子目录有树线', child.elbowLeft !== null);
    check('孙目录有树线', grand.elbowLeft !== null);

    /* 3. 树线不压箭头、不越过名字 */
    check('树线在箭头左侧',
      child.elbowRight <= child.caretLeft,
      `线右 ${child.elbowRight} vs 箭头左 ${child.caretLeft}`);
    check('树线在名字左侧',
      child.elbowRight <= child.nameLeft,
      `线右 ${child.elbowRight} vs 名字左 ${child.nameLeft}`);

    /* 4. 竖线贯穿整行（高度接近行高，不断成两截） */
    check('竖线贯穿整行', child.elbowH >= child.rowH - 2, `${child.elbowH} / ${child.rowH}px`);

    /* 5. 线足够明显 */
    const alpha = (() => {
      const mm = String(child.lineColor).match(/rgba?\(([^)]+)\)/);
      if (!mm) return null;
      const parts = mm[1].split(',').map((s) => s.trim());
      return parts.length === 4 ? Number(parts[3]) : 1;
    })();
    check('竖线不透明度 >= 0.2', alpha !== null && alpha >= 0.2, `alpha=${alpha}`);
    check('竖线宽度 >= 1.5px',
      child.lineWidth && parseFloat(child.lineWidth) >= 1.5, child.lineWidth);

    /* 6. 三个层级的位置是单调递增的（缩进真的生效） */
    const ok = root.nameLeft < child.nameLeft && child.nameLeft < grand.nameLeft;
    check('层级缩进单调递增', ok,
      `${root.nameLeft} < ${child.nameLeft} < ${grand.nameLeft}`);
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
