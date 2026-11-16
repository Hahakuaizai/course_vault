'use strict';

/**
 * 验证「把右边网格里的文件/文件夹拖到左边目录树」这个交互。
 *
 * CDP 没法真的模拟 HTML5 拖放（Input.dispatchDragEvent 不触发
 * dataTransfer），所以这里直接派发带 DataTransfer 的合成事件，
 * 走的是和真实拖拽完全相同的处理路径。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9347;
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
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sd-'));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sdsrc-'));
  fs.mkdirSync(path.join(tree, '子文件夹'), { recursive: true });
  fs.writeFileSync(path.join(tree, '移动我.txt'), 'x');
  fs.writeFileSync(path.join(tree, '子文件夹', '里面.txt'), 'y');

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
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    await sleep(2500);

    /* 准备数据：导入一个文件夹，再建两个目标目录 */
    const setup = await ev(`(async () => {
      await window.vault.files.import(
        ${JSON.stringify([tree])}, null, 'link', 'skip', true);
      await window.vault.courses.create('目标A', '#5b8def', null);
      await window.vault.courses.create('目标B', '#5b8def', null);
      const st = await window.vault.getState();
      window.__vaultDebug.apply(st);
      await new Promise(r => setTimeout(r, 400));

      const src = st.courses.find(c => c.name === ${JSON.stringify(path.basename(tree))});
      const a = st.courses.find(c => c.name === '目标A');
      const b = st.courses.find(c => c.name === '目标B');
      // 进入源目录，让文件卡片显示出来
      window.__vaultDebug.state.view = { type: 'course', courseId: src.id };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));
      return {
        srcId: src.id, aId: a.id, bId: b.id,
        fileCount: st.files.length,
        dirCount: st.courses.length,
      };
    })()`);
    check('准备数据', setup.fileCount === 2 && setup.dirCount === 4,
      `${setup.fileCount} 文件 / ${setup.dirCount} 目录`);

    /* 模拟一次「从网格拖到侧栏目录」的完整流程 */
    const dragToSidebar = async (cardSelector, targetName) => ev(`(async () => {
      const card = document.querySelector(${JSON.stringify(cardSelector)});
      if (!card) return { error: '没找到卡片 ' + ${JSON.stringify(cardSelector)} };

      // 1) dragstart —— 让 gridDrag 被设上
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true, cancelable: true, dataTransfer: dt,
      }));

      // 2) 找到侧栏里的目标目录行
      const row = [...document.querySelectorAll('#courseList [data-course]')]
        .find(r => r.querySelector('.tree-name')?.textContent === ${JSON.stringify(targetName)});
      if (!row) return { error: '没找到侧栏目录 ' + ${JSON.stringify(targetName)} };

      // 3) dragover —— 应该高亮成 drop-into
      const r = row.getBoundingClientRect();
      const at = { clientX: r.left + 30, clientY: r.top + r.height / 2 };
      row.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      await new Promise(r2 => setTimeout(r2, 60));
      const highlighted = row.classList.contains('drop-into');

      // 4) drop
      row.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      await new Promise(r2 => setTimeout(r2, 900));

      // 5) dragend
      card.dispatchEvent(new DragEvent('dragend', {
        bubbles: true, cancelable: true, dataTransfer: dt,
      }));
      await new Promise(r2 => setTimeout(r2, 300));

      return { highlighted };
    })()`);

    /* --- 1. 文件拖到侧栏目录 --- */
    const r1 = await dragToSidebar('.card[data-file]', '目标A');
    check('dragover 时目标目录高亮', r1.highlighted === true, r1.error || '');

    const after1 = await ev(`(async () => {
      const st = await window.vault.getState();
      const a = st.courses.find(c => c.name === '目标A');
      const inA = st.files.filter(f => f.courseId === a.id);
      return { count: inA.length, names: inA.map(f => f.name) };
    })()`);
    check('文件已移到「目标A」', after1.count === 1, `里面 ${after1.count} 个：${after1.names.join(', ')}`);

    /* --- 2. 文件夹拖到侧栏目录 --- */
    const dirCards = await ev(`(() => {
      // 回到顶层看目录卡片
      window.__vaultDebug.state.view = { type: 'all', courseId: null };
      window.__vaultDebug.render();
      return [...document.querySelectorAll('.dir-card')]
        .map(c => c.querySelector('.card-name')?.textContent);
    })()`);
    console.log(`     顶层目录卡片：${dirCards.join(', ')}`);

    const r2 = await dragToSidebar('.card[data-dir]', '目标B');
    check('文件夹拖拽时也高亮', r2.highlighted === true, r2.error || '');

    const after2 = await ev(`(async () => {
      const st = await window.vault.getState();
      const b = st.courses.find(c => c.name === '目标B');
      const kids = st.courses.filter(c => c.parentId === b.id);
      return { kids: kids.map(c => c.name) };
    })()`);
    check('文件夹已移到「目标B」下', after2.kids.length === 1, `子目录：${after2.kids.join(', ')}`);

    /* --- 3. 不能把文件夹拖进自己里面 --- */
    const selfTest = await ev(`(async () => {
      const st = await window.vault.getState();
      const b = st.courses.find(c => c.name === '目标B');
      const child = st.courses.find(c => c.parentId === b.id);
      if (!child) return { error: '目标B 下没有子目录' };

      // 进入「目标B」，它的子目录才会显示成卡片
      window.__vaultDebug.state.view = { type: 'course', courseId: b.id };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 300));

      // 找到那个子目录的卡片
      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === child.name);
      if (!card) return { error: '没找到子目录卡片（当前 ' + document.querySelectorAll('.dir-card').length + ' 张）' };

      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

      // 试着拖到它自己的父级（那是合法的），再试拖到它自己
      const selfRow = [...document.querySelectorAll('#courseList [data-course]')]
        .find(r => r.dataset.course === child.id);
      if (!selfRow) return { error: '侧栏里没找到该目录' };
      const rr = selfRow.getBoundingClientRect();
      const at = { clientX: rr.left + 30, clientY: rr.top + rr.height / 2 };
      selfRow.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      const wronglyHighlighted = selfRow.classList.contains('drop-into');

      selfRow.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      await new Promise(r2 => setTimeout(r2, 500));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));

      const st2 = await window.vault.getState();
      const stillChild = st2.courses.find(c => c.id === child.id);
      return { wronglyHighlighted, parentUnchanged: stillChild.parentId === b.id };
    })()`);
    check('拖到自身时不高亮', selfTest.wronglyHighlighted === false, selfTest.error || '');
    check('拖到自身后归属未变', selfTest.parentUnchanged === true);

    /* --- 4. 多选拖拽：一次移动多个 --- */
    const multi = await ev(`(async () => {
      // 先造几个文件
      const st0 = await window.vault.getState();
      const targetA = st0.courses.find(c => c.name === '目标A');
      window.__vaultDebug.state.view = { type: 'course', courseId: targetA.id };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 300));
      return { ok: true };
    })()`);

    /* --- 5. 拖到侧栏空白处 = 移到顶层 --- */
    const blankTest = await ev(`(async () => {
      const st = await window.vault.getState();
      const f = st.files.find(x => x.courseId && x.name.includes('移动我'));
      if (!f) return { error: '没找到测试文件' };
      const before = f.courseId;

      window.__vaultDebug.state.view = { type: 'course', courseId: before };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 300));

      const card = document.querySelector('.card[data-file]');
      if (!card) return { error: '没找到文件卡片' };
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

      // 拖到侧栏空白处
      const list = document.querySelector('#courseList');
      const lr = list.getBoundingClientRect();
      const at = { clientX: lr.left + 20, clientY: lr.bottom - 10 };
      list.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      const blankHighlighted = list.classList.contains('drop-root');
      list.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      await new Promise(r2 => setTimeout(r2, 600));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));

      const st2 = await window.vault.getState();
      const f2 = st2.files.find(x => x.id === f.id);
      return { blankHighlighted, movedToTop: f2.courseId === null, before };
    })()`);
    check('拖到空白处有提示', blankTest.blankHighlighted === true, blankTest.error || '');
    check('拖到空白处 = 移到顶层', blankTest.movedToTop === true,
      `courseId ${blankTest.before} → null`);

    /* --- 6. 移到顶层的文件在「全部文件」里看得见 --- */
    const visible = await ev(`(async () => {
      window.__vaultDebug.state.view = { type: 'all', courseId: null };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));
      const names = [...document.querySelectorAll('.card[data-file] .card-name')]
        .map(n => n.textContent);
      return { names };
    })()`);
    check('顶层文件在「全部文件」里显示', visible.names.some((n) => n.includes('移动我')),
      visible.names.join(', ') || '（没有文件卡片）');

    /* --- 7. 拖到「全部文件」导航项 = 移到顶层 --- */
    const navDrop = await ev(`(async () => {
      const st = await window.vault.getState();
      const f = st.files.find(x => x.courseId && x.name.includes('里面'));
      if (!f) return { error: '没找到 子文件夹/里面.txt' };
      const before = f.courseId;

      window.__vaultDebug.state.view = { type: 'course', courseId: before };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 300));

      const card = document.querySelector('.card[data-file]');
      if (!card) return { error: '没找到文件卡片' };
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

      const nav = document.querySelector('#navAll');
      const nr = nav.getBoundingClientRect();
      const at = { clientX: nr.left + 40, clientY: nr.top + nr.height / 2 };
      nav.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      await new Promise(r2 => setTimeout(r2, 60));
      const highlighted = nav.classList.contains('drop-top');

      nav.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      await new Promise(r2 => setTimeout(r2, 900));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));

      const st2 = await window.vault.getState();
      const f2 = st2.files.find(x => x.id === f.id);
      return { highlighted, movedToTop: f2.courseId === null, before };
    })()`);
    check('悬在「全部文件」上时高亮', navDrop.highlighted === true, navDrop.error || '');
    check('拖到「全部文件」= 移到顶层', navDrop.movedToTop === true,
      `courseId ${navDrop.before} → null`);

    /* --- 8. 拖文件夹到「全部文件」= 变成顶层目录 --- */
    const navDropDir = await ev(`(async () => {
      const st = await window.vault.getState();
      // 找一个有父目录的目录（「目标B」下面那个子文件夹）
      const b = st.courses.find(c => c.name === '目标B');
      const child = st.courses.find(c => c.parentId === b.id);
      if (!child) return { error: '目标B 下没有子目录' };

      window.__vaultDebug.state.view = { type: 'course', courseId: b.id };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 300));

      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === child.name);
      if (!card) return { error: '没找到目录卡片' };
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

      const nav = document.querySelector('#navAll');
      const nr = nav.getBoundingClientRect();
      const at = { clientX: nr.left + 40, clientY: nr.top + nr.height / 2 };
      nav.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      nav.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt, ...at,
      }));
      await new Promise(r2 => setTimeout(r2, 900));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));

      const st2 = await window.vault.getState();
      const c2 = st2.courses.find(c => c.id === child.id);
      return { parentIsNull: c2.parentId === null, name: c2.name };
    })()`);
    check('文件夹拖到「全部文件」= 变成顶层目录', navDropDir.parentIsNull === true,
      navDropDir.error || navDropDir.name);
  } finally {
    if (ws) ws.close();
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(800);
    for (const d of [tmpData, tree]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
