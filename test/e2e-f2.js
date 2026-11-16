/** 验证 F2：文件走文件重命名，目录走目录重命名 */
const { connect } = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);

  const ids = await c.ev(`(() => {
    const s = window.__vaultDebug.state;
    const f = s.files.find(x => x.name === 'mama.py');
    return { fileId: f.id, courseId: f.courseId,
             parentId: s.courses.find(c => c.id === f.courseId).parentId };
  })()`);
  log('定位:', JSON.stringify(ids));

  // ---- 文件 F2 ----
  await c.ev(`(() => {
    const dbg = window.__vaultDebug;
    dbg.state.view = { type: 'course', courseId: ${JSON.stringify(ids.courseId)} };
    dbg.render();
  })()`);
  await sleep(500);

  const r1 = await c.ev(`(() => {
    const card = document.querySelector('.card[data-file="${ids.fileId}"]');
    if (!card) return { err: '文件卡片没出来', cards: [...document.querySelectorAll('.card')].length };
    card.focus();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    const inp = document.querySelector('#renameInput');
    return {
      modalOpen: !document.querySelector('#renameModal').hidden,
      value: inp?.value,
      selected: [inp?.selectionStart, inp?.selectionEnd],
    };
  })()`);
  log('① 文件 F2:', JSON.stringify(r1));
  await c.ev(`document.querySelector('#btnRenameCancel')?.click()`);
  await sleep(200);

  // ---- 目录 F2 ----
  await c.ev(`(() => {
    const dbg = window.__vaultDebug;
    dbg.state.view = { type: 'course', courseId: ${JSON.stringify(ids.parentId)} };
    dbg.render();
  })()`);
  await sleep(500);

  const r2 = await c.ev(`(() => {
    const card = document.querySelector('.card[data-dir="${ids.courseId}"]');
    if (!card) return { err: '目录卡片没出来', cards: [...document.querySelectorAll('.card')].map(e => e.dataset.dir || e.dataset.file) };
    card.focus();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    return {
      modalOpen: !document.querySelector('#courseModal').hidden,
      title: document.querySelector('#courseModalTitle')?.textContent,
      value: document.querySelector('#courseNameInput')?.value,
    };
  })()`);
  log('② 目录 F2:', JSON.stringify(r2));
  await c.ev(`document.querySelector('#btnCourseCancel')?.click()`);

  // 还原视图
  await c.ev(`(() => { const dbg = window.__vaultDebug; dbg.state.view = { type: 'all', courseId: null }; dbg.render(); })()`);

  const pass = r1.modalOpen && r2.modalOpen && r2.title === '重命名目录';
  log(pass ? '\n✅ F2 全部通过' : '\n❌ 未通过');
  c.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
