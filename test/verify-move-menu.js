'use strict';

/**
 * 验证「移动到…」的菜单：
 *   1. 是树形多级展开，不是一列几十项的平铺长菜单
 *   2. 子菜单贴在父菜单右侧展开，父条目保持高亮
 *   3. 选完目标后菜单整串消失（原来会残留）
 *   4. 点菜单外面也整串消失
 *   5. 当前所在目录不出现在列表里，但它下面的子目录还能选
 *   6. 移动目录时它自己和子孙不出现在列表里
 *
 * 造一棵三层目录树：课程文件 / 计组 / 第三章 / 小节，再放几个文件。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9353;
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
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mm-'));
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

    /* ---------- 造数据 ---------- */
    const setup = await ev(`(async () => {
      const mk = async (name, parentId) => {
        await window.vault.courses.create(name, '#5b8def', parentId);
        const st = await window.vault.getState();
        // 同名目录可能有多个，取数组里最后那个（刚建的）
        return st.courses.filter(c => c.name === name && (c.parentId || null) === (parentId || null)).pop();
      };
      const root = await mk('课程文件', null);
      const a = await mk('计组', root.id);
      const b = await mk('第三章', a.id);
      await mk('小节', b.id);
      await mk('操作系统', root.id);
      await mk('网络', null);

      // 在「计组」里放两个文件（用真实文件，库里只建记录）
      const st0 = await window.vault.getState();
      return { rootId: root.id, aId: a.id, bId: b.id, courses: st0.courses.length };
    })()`);
    check('准备目录树（三层 + 两个顶层）', setup.courses >= 6, `${setup.courses} 个目录`);

    /* 用 files.create 在「计组」里建两个文件记录。
     * 注意它返回的是 { file, state }，不是 state 本身；
     * saveDir 指到临时目录，别往桌面丢东西。 */
    const fileIds = await ev(`(async () => {
      const out = [];
      for (const name of ['a.py', 'b.py']) {
        const res = await window.vault.files.create({
          name, courseId: ${JSON.stringify(setup.aId)}, content: 'x',
          saveDir: ${JSON.stringify(tmpData)},
        });
        if (res?.file) out.push(res.file.id);
      }
      window.__vaultDebug.apply(await window.vault.getState());
      await new Promise(r => setTimeout(r, 400));
      return out;
    })()`);
    check('准备两个文件记录', fileIds.length === 2, `${fileIds.length} 个`);

    /* ---------- 1. 打开文件的「移动到…」 ---------- */
    const opened = await ev(`(async () => {
      // 切到「计组」视图，让文件卡片可见
      window.__vaultDebug.state.view = { type: 'course', courseId: ${JSON.stringify(setup.aId)} };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));

      const card = document.querySelector('.card[data-file]');
      if (!card) return { err: '没找到文件卡片' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 30),
      }));
      await new Promise(r2 => setTimeout(r2, 300));

      const menu = document.querySelector('.ctx-menu');
      if (!menu) return { err: '右键菜单没弹出来' };
      const moveBtn = [...menu.querySelectorAll('.ctx-item')]
        .find(b => b.textContent.includes('移动到'));
      if (!moveBtn) return { err: '菜单里没有「移动到…」' };

      // 模拟真实点击（会冒泡到 document）
      moveBtn.click();
      await new Promise(r2 => setTimeout(r2, 300));

      const menus = [...document.querySelectorAll('.ctx-menu')];
      const top = menus[0];
      return {
        menuCount: menus.length,
        items: [...(top?.querySelectorAll('.ctx-item') || [])].map(b => ({
          text: b.querySelector('span')?.textContent?.trim(),
          hasArrow: !!b.querySelector('.ctx-arrow'),
        })),
        height: Math.round(top?.getBoundingClientRect().height || 0),
        viewport: window.innerHeight,
      };
    })()`);
    if (opened.err) throw new Error(opened.err);
    console.log(`     根菜单项：${opened.items.map(i => i.text + (i.hasArrow ? ' ▸' : '')).join(' / ')}`);

    check('点「移动到…」后只开一层菜单', opened.menuCount === 1, `${opened.menuCount} 个`);
    check('菜单不再是一列长条（高度 < 视口 60%）',
      opened.height < opened.viewport * 0.6, `${opened.height}px / ${opened.viewport}px`);
    check('顶层目录直接列出来', opened.items.some(i => i.text === '课程文件'), '');
    check('有子目录的项带展开箭头',
      opened.items.find(i => i.text === '课程文件')?.hasArrow === true, '');
    check('叶子目录不带箭头',
      opened.items.find(i => i.text === '网络')?.hasArrow === false, '');
    check('当前所在的「计组」不出现在列表里',
      !opened.items.some(i => i.text === '计组'), '');
    check('「全部文件（顶层）」也在（当前不在顶层）',
      opened.items.some(i => i.text === '全部文件（顶层）'), '');

    /* ---------- 2. 悬停展开子菜单 ---------- */
    const sub = await ev(`(async () => {
      const top = document.querySelector('.ctx-menu');
      const btn = [...top.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('课程文件'));
      const r = btn.getBoundingClientRect();
      btn.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 10),
      }));
      await new Promise(r2 => setTimeout(r2, 300));

      const menus = [...document.querySelectorAll('.ctx-menu')];
      const child = menus[1];
      const tr = top.getBoundingClientRect();
      const cr = child?.getBoundingClientRect();
      return {
        count: menus.length,
        childItems: [...(child?.querySelectorAll('.ctx-item') || [])].map(b => ({
          text: b.querySelector('span')?.textContent?.trim(),
          hasArrow: !!b.querySelector('.ctx-arrow'),
        })),
        // 子菜单应该在父菜单右边（或左边），不重叠
        sideBySide: !!(cr && (cr.left >= tr.right - 2 || cr.right <= tr.left + 2)),
        parentHighlighted: btn.classList.contains('is-sub-open'),
        // 「计组」是文件当前所在目录：灰着列出来（保持树的层级），但点不动
        samePlaceDisabled: (() => {
          const b = [...(child?.querySelectorAll('.ctx-item') || [])]
            .find(x => (x.querySelector('span')?.textContent || '').startsWith('计组'));
          return b ? b.classList.contains('is-disabled') : null;
        })(),
      };
    })()`);
    console.log(`     子菜单项：${sub.childItems.map(i => i.text + (i.hasArrow ? ' ▸' : '')).join(' / ')}`);
    check('悬停展开出第二层菜单', sub.count === 2, `${sub.count} 个`);
    check('子菜单列的是下一级目录',
      sub.childItems.some(i => i.text === '操作系统'), '');
    check('子菜单和父菜单左右并排、不重叠', sub.sideBySide === true, '');
    check('展开的父条目保持高亮', sub.parentHighlighted === true, '');
    check('原地目录灰显、点不动',
      sub.samePlaceDisabled === true, String(sub.samePlaceDisabled));

    /* ---------- 3. 第三层 ---------- */
    const third = await ev(`(async () => {
      const menus = [...document.querySelectorAll('.ctx-menu')];
      const child = menus[1];
      const btn = [...child.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('计组'));
      const r = btn.getBoundingClientRect();
      btn.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 10),
      }));
      await new Promise(r2 => setTimeout(r2, 300));
      const all = [...document.querySelectorAll('.ctx-menu')];
      const deep = all[2];
      return {
        count: all.length,
        items: [...(deep?.querySelectorAll('.ctx-item') || [])]
          .map(b => b.querySelector('span')?.textContent?.trim()),
      };
    })()`);
    console.log(`     第三层：${third.items.join(' / ')}`);
    check('能展开到第三层', third.count === 3, `${third.count} 层`);
    check('第三层是「第三章」', third.items.includes('第三章'), '');

    /* ---------- 4. 点菜单外面全部消失 ---------- */
    const closedByOutside = await ev(`(async () => {
      document.body.click();
      await new Promise(r => setTimeout(r, 200));
      return document.querySelectorAll('.ctx-menu').length;
    })()`);
    check('点菜单外面后整串菜单都消失', closedByOutside === 0, `还剩 ${closedByOutside} 个`);

    /* ---------- 5. 选完目标后菜单消失 ---------- */
    const afterMove = await ev(`(async () => {
      window.__vaultDebug.state.view = { type: 'course', courseId: ${JSON.stringify(setup.aId)} };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));

      const card = document.querySelector('.card[data-file]');
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 30),
      }));
      await new Promise(r2 => setTimeout(r2, 250));

      const menu = document.querySelector('.ctx-menu');
      const moveBtn = [...menu.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('移动到'));
      moveBtn.click();
      await new Promise(r2 => setTimeout(r2, 250));

      // 在子菜单里点「网络」以外的目标 —— 用「全部文件（顶层）」，它没有子级
      const top = document.querySelector('.ctx-menu');
      const target = [...top.querySelectorAll('.ctx-item')]
        .find(b => b.textContent.includes('全部文件'));
      if (!target) return { err: '没找到目标项' };
      target.click();
      await new Promise(r2 => setTimeout(r2, 600));

      return {
        menus: document.querySelectorAll('.ctx-menu').length,
        toast: document.querySelector('.toast')?.textContent?.trim() || null,
      };
    })()`);
    if (afterMove.err) throw new Error(afterMove.err);
    check('选完目标后菜单全部消失', afterMove.menus === 0, `还剩 ${afterMove.menus} 个`);
    check('给出移动成功的提示', /已移动/.test(afterMove.toast || ''), afterMove.toast || '（无提示）');

    /* ---------- 6. 移动目录时排除自己和子孙 ---------- */
    const dirMove = await ev(`(async () => {
      // 「计组」在「课程文件」下面，要切到那一层才看得到它的卡片
      window.__vaultDebug.state.view = { type: 'course', courseId: ${JSON.stringify(setup.rootId)} };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));

      // 用多选模式选中「计组」目录，再点工具栏的「移动」——
      // 目录卡片的右键菜单里没有「移动到…」，只有选中项才有
      if (!document.body.classList.contains('select-mode')) {
        document.querySelector('#btnSelectMode').click();
        await new Promise(r2 => setTimeout(r2, 300));
      }
      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === '计组');
      if (!card) return { err: '没找到「计组」卡片' };
      card.click();
      await new Promise(r2 => setTimeout(r2, 300));

      const btn = document.querySelector('#btnSelMove');
      if (!btn) return { err: '没有批量移动按钮' };
      btn.click();
      await new Promise(r2 => setTimeout(r2, 400));

      const m = document.querySelector('.ctx-menu');
      if (!m) return { err: '移动菜单没弹出来' };
      const items = [...m.querySelectorAll('.ctx-item')]
        .map(b => b.querySelector('span')?.textContent?.trim());
      document.body.click();
      await new Promise(r2 => setTimeout(r2, 200));
      return { items };
    })()`);
    if (dirMove.err) throw new Error(dirMove.err);
    console.log(`     移动目录时的目标：${dirMove.items.join(' / ')}`);
    check('被移动的目录自己不在目标里',
      !dirMove.items.some((t) => t.startsWith('计组')), '');
    check('被移动目录的子目录也不在目标里',
      !dirMove.items.some((t) => t.startsWith('第三章') || t.startsWith('小节')), '');
    check('其他目录仍然可选', dirMove.items.includes('网络'), '');

    /* ---------- 7. 多选工具栏的「移动」也是树形 ---------- */
    const selMove = await ev(`(async () => {
      window.__vaultDebug.state.view = { type: 'course', courseId: ${JSON.stringify(setup.aId)} };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));

      // 进多选模式，选中所有文件（上一段测试可能已经开着了，别重复切）
      if (!document.body.classList.contains('select-mode')) {
        document.querySelector('#btnSelectMode').click();
        await new Promise(r2 => setTimeout(r2, 300));
      }
      document.querySelectorAll('.card[data-file]').forEach(c => c.click());
      await new Promise(r2 => setTimeout(r2, 300));

      const btn = document.querySelector('#btnSelMove');
      if (!btn) return { err: '没有批量移动按钮' };
      btn.click();
      await new Promise(r2 => setTimeout(r2, 300));

      const m = document.querySelector('.ctx-menu');
      if (!m) return { err: '批量移动菜单没弹出来' };
      const items = [...m.querySelectorAll('.ctx-item')].map(b => ({
        text: b.querySelector('span')?.textContent?.trim(),
        hasArrow: !!b.querySelector('.ctx-arrow'),
      }));
      document.body.click();
      await new Promise(r2 => setTimeout(r2, 200));
      const left = document.querySelectorAll('.ctx-menu').length;
      return { items, left };
    })()`);
    if (selMove.err) throw new Error(selMove.err);
    console.log(`     批量移动菜单：${selMove.items.map(i => i.text + (i.hasArrow ? ' ▸' : '')).join(' / ')}`);
    check('批量「移动」也是树形菜单', selMove.items.some(i => i.hasArrow), '');
    check('批量「移动」点外面能关掉', selMove.left === 0, `还剩 ${selMove.left} 个`);
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
