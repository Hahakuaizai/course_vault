/** 验证右键菜单里的剪切/复制/移动，走完整 UI 流程 */
const { connect } = require('./cdp.js');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(ok);
    log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  };
  const created = [];

  try {
    const src = path.join(TEST_DIR, `_cui_${Date.now()}.txt`);
    fs.writeFileSync(src, 'clipboard ui test\n', 'utf8');
    created.push(src);

    const setup = await c.ev(`(async () => {
      const s = await window.vault.getState();
      const f = s.files.find(x => x.name === 'mama.py');
      const dest = s.courses.find(x => x.id !== f.courseId && !x.parentId);
      const r = await window.vault.files.import([${JSON.stringify(src)}], f.courseId, 'link', 'allow', false);
      await window.__vaultDebug.refresh();
      const nf = r.state.files.find(x => x.path.toLowerCase() === ${JSON.stringify(src.toLowerCase())});
      const d = window.__vaultDebug;
      d.state.view = { type: 'course', courseId: f.courseId };
      d.render();
      return { id: nf.id, srcCourse: f.courseId, destId: dest.id, destName: dest.name };
    })()`);
    log('① 准备:', JSON.stringify(setup));
    await sleep(600);

    // ---- 右键文件，看菜单项 ----
    const menu = await c.ev(`(() => {
      const card = document.querySelector('.card[data-file="${setup.id}"]');
      if (!card) return { err: '卡片没出来' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 40) }));
      const ctx = document.querySelector('.ctx-menu');
      return { items: [...ctx.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()) };
    })()`);
    log('② 文件右键菜单:', JSON.stringify(menu.items));
    check('菜单有剪切', menu.items.includes('剪切'));
    check('菜单有复制', menu.items.includes('复制'));
    check('菜单有移动到', menu.items.includes('移动到…'));

    // ---- 点「复制」，检查剪贴板状态 ----
    const copied = await c.ev(`(() => {
      const ctx = document.querySelector('.ctx-menu');
      [...ctx.querySelectorAll('.ctx-item')].find(b => b.textContent.trim() === '复制').click();
      const cb = window.__vaultDebug.state.clipboard;
      return { keys: cb.keys, cut: cb.cut };
    })()`);
    log('③ 点复制后:', JSON.stringify(copied));
    check('剪贴板记下了文件', copied.keys?.length === 1);
    check('复制模式 cut=false', copied.cut === false);

    // ---- 切到目标目录，粘贴 ----
    const pasted = await c.ev(`(async () => {
      const d = window.__vaultDebug;
      d.state.view = { type: 'course', courseId: ${JSON.stringify(setup.destId)} };
      d.render();
      await new Promise(r => setTimeout(r, 400));
      // 在空白处右键 → 粘贴
      const content = document.querySelector('#content');
      const grid = document.querySelector('#grid');
      const cr = content.getBoundingClientRect();
      const gr = grid.getBoundingClientRect();
      const x = Math.round(cr.left + 100);
      const y = Math.round(Math.min(gr.bottom + 150, cr.bottom - 40));
      content.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      const ctx = document.querySelector('.ctx-menu');
      const items = [...ctx.querySelectorAll('.ctx-item')].map(b => b.textContent.trim());
      const pasteBtn = [...ctx.querySelectorAll('.ctx-item')].find(b => b.textContent.trim() === '粘贴');
      if (!pasteBtn) return { err: '没有粘贴项', items };
      const before = window.__vaultDebug.state.files.length;
      pasteBtn.click();
      await new Promise(r => setTimeout(r, 800));
      return {
        items,
        before,
        after: window.__vaultDebug.state.files.length,
        inDest: window.__vaultDebug.state.files.filter(f => f.courseId === ${JSON.stringify(setup.destId)} && f.name.includes('_cui_')).length,
        clipboardStillThere: window.__vaultDebug.state.clipboard.keys.length,
      };
    })()`);
    log('④ 粘贴结果:', JSON.stringify(pasted));
    check('粘贴后记录 +1', pasted.after - pasted.before === 1);
    check('副本在目标目录', pasted.inDest === 1);
    check('复制后剪贴板仍保留（可重复粘贴）', pasted.clipboardStillThere === 1);

    // ---- 测「移动到…」子菜单 ----
    const moveMenu = await c.ev(`(async () => {
      const d = window.__vaultDebug;
      d.state.view = { type: 'course', courseId: ${JSON.stringify(setup.srcCourse)} };
      d.render();
      await new Promise(r => setTimeout(r, 400));
      const card = document.querySelector('.card[data-file="${setup.id}"]');
      if (!card) return { err: '卡片没出来' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 40) }));
      const ctx = document.querySelector('.ctx-menu');
      [...ctx.querySelectorAll('.ctx-item')].find(b => b.textContent.trim() === '移动到…').click();
      for (let i = 0; i < 30; i += 1) {
        await new Promise(x => setTimeout(x, 100));
        const m = document.querySelector('.ctx-menu');
        const items = [...(m?.querySelectorAll('.ctx-item') || [])].map(b => b.textContent.trim());
        if (items.length && !items.includes('移动到…')) return { items };
      }
      return { err: '子菜单超时' };
    })()`);
    log('⑤ 移动到子菜单:', JSON.stringify(moveMenu.items || moveMenu.err));
    check('子菜单列出了目录', Array.isArray(moveMenu.items) && moveMenu.items.length > 0);

    // 点目标目录，验证真的移动了
    if (moveMenu.items) {
      const moved = await c.ev(`(async () => {
        const ctx = document.querySelector('.ctx-menu');
        const btns = [...ctx.querySelectorAll('.ctx-item')];
        const target = btns.find(b => b.textContent.trim() === ${JSON.stringify(setup.destName)});
        if (!target) return { err: '没找到目标目录项', all: btns.map(b => b.textContent.trim()) };
        target.click();
        await new Promise(r => setTimeout(r, 800));
        const f = window.__vaultDebug.state.files.find(x => x.id === ${JSON.stringify(setup.id)});
        return { courseId: f?.courseId, expected: ${JSON.stringify(setup.destId)} };
      })()`);
      log('⑥ 移动结果:', JSON.stringify(moved));
      check('移动到指定目录成功', moved.courseId === moved.expected);
    }
  } finally {
    await c.ev(`(async () => {
      const s = await window.vault.getState();
      const t = s.files.filter(f => f.name.includes('_cui_'));
      for (const f of t) { try { await window.vault.files.remove(f.id, false); } catch {} }
      const d = window.__vaultDebug;
      d.state.view = { type: 'all', courseId: null };
      await d.refresh();
    })()`).catch(() => {});
    for (const p of created) { try { fs.unlinkSync(p); } catch {} }
    const final = await c.ev(`window.vault.getState().then(s => ({ files: s.files.length, courses: s.courses.length, trash: s.trash.length }))`);
    log('\n清理后:', JSON.stringify(final));
    const okCount = results.filter(Boolean).length;
    log(`${okCount}/${results.length} 项通过`);
    c.close();
    if (okCount !== results.length) process.exit(1);
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
