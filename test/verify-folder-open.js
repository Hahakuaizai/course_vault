'use strict';

/**
 * 验证「文件夹右键 → 在电脑上显示 / 用其他软件打开」和「项目文件按整个项目打开」。
 *
 * 不真的启动编辑器 —— 那会抢焦点、还会弹出一堆窗口。
 * 只验证三件纯读取的事：
 *   1. course:dir 能把虚拟目录定位到磁盘（导入的有 sourcePath，手工建的靠推）
 *   2. file:project 能从文件往上找到项目根
 *   3. editor:forDir 返回的候选里没有 7-Zip 这种「能开文件夹但打不开项目」的程序
 * 再检查右键菜单里对应的条目确实出现了。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9349;
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
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fo-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fosrc-'));

  /* 造两个场景：
   *   proj/  —— 一个 Node 项目（有 package.json），src/app.js 在子目录里
   *   plain/ —— 普通文件夹，没有项目标志物
   */
  const proj = path.join(base, '我的项目');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo' }));
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(proj, 'src', 'util.js'), 'module.exports=1');

  const plain = path.join(base, '普通文件夹');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, '随手记.txt'), 'x');

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
      const t = setTimeout(() => { pending.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, 25000);
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

    /* 导入两个文件夹（保留层级），再手工建一个空目录 */
    const setup = await ev(`(async () => {
      await window.vault.files.import(
        ${JSON.stringify([proj, plain])}, null, 'link', 'skip', true);
      await window.vault.courses.create('手工目录', '#5b8def', null);
      const st = await window.vault.getState();
      window.__vaultDebug.apply(st);
      await new Promise(r => setTimeout(r, 500));
      return {
        courses: st.courses.map(c => ({ id: c.id, name: c.name, sourcePath: c.sourcePath || null })),
        files: st.files.map(f => ({ id: f.id, name: f.name, path: f.path, courseId: f.courseId })),
      };
    })()`);
    check('准备数据', setup.files.length === 4, `${setup.files.length} 个文件 / ${setup.courses.length} 个目录`);

    /* --- 1. 目录定位 --- */
    const projCourse = setup.courses.find((c) => c.name === '我的项目');
    const srcCourse = setup.courses.find((c) => c.name === 'src');
    const plainCourse = setup.courses.find((c) => c.name === '普通文件夹');
    const manualCourse = setup.courses.find((c) => c.name === '手工目录');

    const dirs = await ev(`(async () => {
      const out = {};
      for (const id of ${JSON.stringify([projCourse.id, srcCourse.id, plainCourse.id, manualCourse.id])}) {
        out[id] = (await window.vault.courses.dir(id))?.dir || null;
      }
      return out;
    })()`);
    const norm = (p) => (p ? path.resolve(p).toLowerCase() : null);
    check('导入的目录能定位到源文件夹',
      norm(dirs[projCourse.id]) === norm(proj), dirs[projCourse.id] || '（null）');
    check('子目录也能定位（sourcePath 逐层记着）',
      norm(dirs[srcCourse.id]) === norm(path.join(proj, 'src')), dirs[srcCourse.id] || '（null）');
    check('普通文件夹能定位',
      norm(dirs[plainCourse.id]) === norm(plain), dirs[plainCourse.id] || '（null）');
    check('空的手工目录定位为 null（不瞎猜）',
      dirs[manualCourse.id] === null, String(dirs[manualCourse.id]));

    /* --- 2. 手工目录从文件路径反推 ---
     * 只认两种情况：文件全在同一目录，或公共前缀的名字和目录名对得上。
     * 造一个独立的目录来测，别污染「手工目录」（后面还要验证它是空的）。 */
    const inferTest = await ev(`(async () => {
      const st0 = await window.vault.getState();
      // courses.create 返回的是整份 state，不是新目录，得自己回查。
      // 注意要挑顶层那个：导入来的「我的项目/src」也叫 src，且在数组更前面。
      const st1 = await window.vault.courses.create('src', '#5b8def', null);
      const probe = st1.courses.find(c => c.name === 'src' && !c.parentId);
      if (!probe) return { error: '新建目录失败' };

      const srcFiles = st0.files.filter(f => f.path.includes('\\\\src\\\\'));
      for (const f of srcFiles) {
        await window.vault.files.moveMany([f.id], probe.id);
      }
      const dir = (await window.vault.courses.dir(probe.id))?.dir || null;
      // 反例：改个和路径对不上的名字，就不该再猜
      await window.vault.courses.rename(probe.id, '杂项');
      const afterRename = (await window.vault.courses.dir(probe.id))?.dir || null;
      return { dir, afterRename, moved: srcFiles.length, probeId: probe.id };
    })()`);
    if (inferTest.error) throw new Error(inferTest.error);
    check('手工目录能靠文件路径反推位置（名字对得上才认）',
      norm(inferTest.dir) === norm(path.join(proj, 'src')),
      `${inferTest.dir}（挂了 ${inferTest.moved} 个文件）`);
    check('名字对不上时不瞎猜位置', inferTest.afterRename === null, String(inferTest.afterRename));

    /* --- 3. 项目根探测 --- */
    const projTest = await ev(`(async () => {
      const st = await window.vault.getState();
      const js = st.files.find(f => f.name === 'app.js');
      const txt = st.files.find(f => f.name === '随手记.txt');
      const pkg = st.files.find(f => f.name === 'package.json');
      return {
        js: await window.vault.files.project(js.id),
        txt: await window.vault.files.project(txt.id),
        pkg: pkg ? await window.vault.files.project(pkg.id) : 'no-package-json',
      };
    })()`);
    check('子目录里的 .js 能找到项目根',
      projTest.js && norm(projTest.js.root) === norm(proj),
      projTest.js ? `${projTest.js.name} / isRoot=${projTest.js.isRoot}` : '（null）');
    check('项目根的判定是「不在根这一层」',
      projTest.js && projTest.js.isRoot === false, String(projTest.js?.isRoot));
    check('普通文件夹里的 .txt 不算项目',
      projTest.txt === null, JSON.stringify(projTest.txt));
    check('根目录的 package.json 自己标 isRoot',
      projTest.pkg && projTest.pkg.isRoot === true,
      projTest.pkg ? String(projTest.pkg.isRoot) : JSON.stringify(projTest.pkg));

    /* --- 4. 文件夹候选程序：不能混进压缩软件 --- */
    const dirApps = await ev(`window.vault.files.editorsForDir()`);
    const names = (dirApps || []).map((a) => a.label);
    console.log(`     文件夹候选程序：${names.join(' / ') || '（无）'}`);
    const junk = names.filter((n) => /7-?zip|winrar|bandizip|everything|totalcmd|peazip/i.test(n));
    check('文件夹候选里没有压缩/搜索类程序', junk.length === 0, junk.join(', ') || '干净');

    /* --- 5. 右键菜单里确实有这两项 --- */
    const menu = await ev(`(async () => {
      const st = window.__vaultDebug.state;
      // 回到顶层，让目录卡片显示出来
      window.__vaultDebug.state.view = { type: 'all', courseId: null };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 500));

      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === '我的项目');
      if (!card) return { err: '没找到「我的项目」卡片' };

      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 40),
      }));
      // 菜单要等 courses.dir 探测完才挂出来
      for (let i = 0; i < 30; i += 1) {
        await new Promise(r2 => setTimeout(r2, 100));
        const m = document.querySelector('.ctx-menu');
        if (m) return { items: [...m.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()) };
      }
      return { err: '菜单没弹出来' };
    })()`);
    console.log(`     文件夹右键菜单：${(menu.items || []).join(' / ') || menu.err}`);
    check('菜单里有「在电脑上显示文件夹」',
      (menu.items || []).includes('在电脑上显示文件夹'), menu.err || '');
    check('菜单里有「用其他软件打开」',
      (menu.items || []).includes('用其他软件打开'), menu.err || '');

    /* --- 6. 空目录的菜单里不出现这两项 --- */
    const emptyMenu = await ev(`(async () => {
      document.body.click();
      await new Promise(r => setTimeout(r, 200));
      const st = window.__vaultDebug.state;
      window.__vaultDebug.state.view = { type: 'all', courseId: null };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));

      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === '手工目录');
      if (!card) return { err: '没找到「手工目录」卡片' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 40),
      }));
      for (let i = 0; i < 30; i += 1) {
        await new Promise(r2 => setTimeout(r2, 100));
        const m = document.querySelector('.ctx-menu');
        if (m) return { items: [...m.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()) };
      }
      return { err: '菜单没弹出来' };
    })()`);
    console.log(`     空目录右键菜单：${(emptyMenu.items || []).join(' / ') || emptyMenu.err}`);
    check('空目录不显示「在电脑上显示文件夹」',
      !(emptyMenu.items || []).includes('在电脑上显示文件夹'), emptyMenu.err || '');
    check('空目录不显示「用其他软件打开」',
      !(emptyMenu.items || []).includes('用其他软件打开'), emptyMenu.err || '');

    /* --- 7. 侧栏目录树的「更多」菜单同样有 --- */
    const treeMenu = await ev(`(async () => {
      document.body.click();
      await new Promise(r => setTimeout(r, 200));
      const more = document.querySelector('[data-more]');
      if (!more) return { err: '侧栏没有更多按钮' };
      // 找到「我的项目」那一行的更多按钮
      const row = [...document.querySelectorAll('.tree-row')]
        .find(r => r.querySelector('.tree-name')?.textContent === '我的项目');
      if (!row) return { err: '侧栏没有「我的项目」' };
      const btn = row.querySelector('[data-more]');
      if (!btn) return { err: '这一行没有更多按钮' };
      btn.click();
      for (let i = 0; i < 30; i += 1) {
        await new Promise(r2 => setTimeout(r2, 100));
        const m = document.querySelector('.ctx-menu');
        if (m) return { items: [...m.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()) };
      }
      return { err: '菜单没弹出来' };
    })()`);
    console.log(`     侧栏更多菜单：${(treeMenu.items || []).join(' / ') || treeMenu.err}`);
    check('侧栏菜单里也有「在电脑上显示文件夹」',
      (treeMenu.items || []).includes('在电脑上显示文件夹'), treeMenu.err || '');
  } finally {
    if (ws) ws.close();
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(800);
    for (const d of [tmpData, base]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
