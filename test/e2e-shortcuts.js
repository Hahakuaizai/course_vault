/** 验证新增的快捷键 */
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
  let fileId = null;

  try {
    // 准备：造一个临时文件并导入到 code 目录
    const src = path.join(TEST_DIR, `_k_${Date.now()}.py`);
    fs.writeFileSync(src, 'def f(x):\n    return x + 1\n', 'utf8');
    created.push(src);

    const setup = await c.ev(`(async () => {
      const s = await window.vault.getState();
      const f = s.files.find(x => x.name === 'mama.py');
      const r = await window.vault.files.import([${JSON.stringify(src)}], f.courseId, 'link', 'allow', false);
      await window.__vaultDebug.refresh();
      const nf = r.state.files.find(x => x.path.toLowerCase() === ${JSON.stringify(src.toLowerCase())});
      const d = window.__vaultDebug;
      d.state.view = { type: 'course', courseId: f.courseId };
      d.render();
      return { id: nf.id, courseId: f.courseId };
    })()`);
    fileId = setup.id;
    await sleep(500);

    const press = (init) => c.ev(`(() => {
      const e = new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })});
      document.dispatchEvent(e);
      return { prevented: e.defaultPrevented };
    })()`);

    // ---- 1. Ctrl+/ 打开快捷键面板 ----
    await press({ key: '/', ctrlKey: true });
    await sleep(400);
    const sc = await c.ev(`(() => {
      const m = document.querySelector('#shortcutsModal');
      if (!m || m.hidden) return { err: '没打开' };
      const groups = [...m.querySelectorAll('.sc-group h4')].map(h => h.textContent);
      const rows = [...m.querySelectorAll('.sc-row')].map(r => ({
        desc: r.querySelector('.sc-desc').textContent,
        keys: [...r.querySelectorAll('kbd')].map(k => k.textContent).join('+'),
      }));
      return { groups, rowCount: rows.length, sample: rows.slice(0, 3),
               panelBg: getComputedStyle(m.querySelector('.modal')).backgroundColor };
    })()`);
    log('① Ctrl+/ 面板:', JSON.stringify(sc, null, 1));
    check('Ctrl+/ 打开面板', !sc.err);
    check('面板有 4 组', sc.groups?.length === 4);
    check('面板列出了快捷键', sc.rowCount > 10, `${sc.rowCount} 条`);
    check('面板是深色主题', sc.panelBg && !sc.panelBg.includes('255, 255, 255'), sc.panelBg);

    // ESC 关掉
    await press({ key: 'Escape' });
    await sleep(300);
    const closed = await c.ev(`document.querySelector('#shortcutsModal').hidden`);
    check('ESC 关闭面板', closed);

    // ---- 2. ? 也能打开 ----
    await press({ key: '?' });
    await sleep(350);
    const q = await c.ev(`!document.querySelector('#shortcutsModal').hidden`);
    check('? 打开面板', q);
    await press({ key: 'Escape' });
    await sleep(250);

    // ---- 3. Ctrl+N 新建文件弹窗 ----
    await press({ key: 'n', ctrlKey: true });
    await sleep(400);
    const nf = await c.ev(`!document.querySelector('#newFileModal').hidden`);
    check('Ctrl+N 新建文件', nf);
    await press({ key: 'Escape' });
    await sleep(250);

    // ---- 4. Ctrl+Shift+N 新建文件夹 ----
    await press({ key: 'N', ctrlKey: true, shiftKey: true });
    await sleep(400);
    const nd = await c.ev(`({ open: !document.querySelector('#courseModal').hidden,
      title: document.querySelector('#courseModalTitle')?.textContent })`);
    check('Ctrl+Shift+N 新建文件夹', nd.open, nd.title);
    await press({ key: 'Escape' });
    await sleep(250);

    // ---- 5. Ctrl+, 设置 ----
    await press({ key: ',', ctrlKey: true });
    await sleep(400);
    const st = await c.ev(`!document.querySelector('#settingsModal').hidden`);
    check('Ctrl+, 打开设置', st);
    await press({ key: 'Escape' });
    await sleep(250);

    // ---- 6. Ctrl+R 刷新（不重载页面）----
    const before = await c.ev(`performance.now()`);
    await press({ key: 'r', ctrlKey: true });
    await sleep(600);
    const after = await c.ev(`({ t: performance.now(), files: window.__vaultDebug.state.files.length })`);
    check('Ctrl+R 刷新但不重载页面', after.t > before, `页面运行时间连续`);
    check('刷新后数据仍在', after.files > 0, `${after.files} 个文件`);

    // ---- 7. 预览里的快捷键 ----
    await c.ev(`window.__vaultDebug.openPreview(${JSON.stringify(fileId)})`);
    await sleep(1000);

    // Ctrl+E 进入编辑
    await press({ key: 'e', ctrlKey: true });
    await sleep(600);
    const ed = await c.ev(`({ editing: !!document.querySelector('.editor'),
      saveBtn: !document.querySelector('#btnSaveEdit').hidden })`);
    check('Ctrl+E 进入编辑', ed.editing);
    check('保存按钮出现', ed.saveBtn);

    // Ctrl+S 保存
    const saved = await c.ev(`(async () => {
      const ta = document.querySelector('.editor');
      ta.value = 'def f(x):\\n    return x * 2\\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 1200));
      return { editing: !!document.querySelector('.editor') };
    })()`);
    const diskContent = fs.readFileSync(src, 'utf8');
    check('Ctrl+S 保存到磁盘', diskContent.includes('x * 2'), diskContent.trim().replace(/\n/g, ' | '));
    check('保存后退出编辑', !saved.editing);

    // Ctrl+Shift+R 在文件夹中显示（contextBridge 对象不可改，只验证事件被处理且无异常）
    const reveal = await c.ev(`(async () => {
      const errs = [];
      window.addEventListener('error', (ev) => errs.push(ev.message), { once: true });
      const e = new KeyboardEvent('keydown', { key: 'R', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(e);
      await new Promise(r => setTimeout(r, 600));
      return { prevented: e.defaultPrevented, errs };
    })()`);
    check('Ctrl+Shift+R 被处理且无异常', reveal.prevented && !reveal.errs.length);

    await c.ev(`document.querySelector('#btnPreviewClose')?.click()`);
    await sleep(400);
    await c.ev(`(async () => {
      if (!document.querySelector('#confirmModal').hidden) document.querySelector('#btnConfirmOk').click();
      await new Promise(r => setTimeout(r, 300));
    })()`);

    // ---- 8. Alt+↑ 回到全部文件 ----
    await press({ key: 'ArrowUp', altKey: true });
    await sleep(400);
    const view = await c.ev(`window.__vaultDebug.state.view.type`);
    check('Alt+↑ 回到全部文件', view === 'all', view);

    // ---- 9. 编辑器里 Ctrl+/ 仍是注释，不是面板 ----
    await c.ev(`window.__vaultDebug.openPreview(${JSON.stringify(fileId)})`);
    await sleep(900);
    await c.ev(`document.querySelector('#btnEdit')?.click()`);
    await sleep(600);
    const comment = await c.ev(`(async () => {
      const ta = document.querySelector('.editor');
      ta.focus();
      ta.setSelectionRange(0, 0);
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 300));
      return {
        modalOpen: !document.querySelector('#shortcutsModal').hidden,
        firstLine: ta.value.split('\\n')[0],
      };
    })()`);
    log('⑨ 编辑器内 Ctrl+/:', JSON.stringify(comment));
    check('编辑器内 Ctrl+/ 不弹面板', !comment.modalOpen);
    check('编辑器内 Ctrl+/ 是注释', comment.firstLine.startsWith('#'), comment.firstLine);

    await c.ev(`document.querySelector('#btnPreviewClose')?.click()`);
    await sleep(400);
    await c.ev(`(async () => {
      if (!document.querySelector('#confirmModal').hidden) document.querySelector('#btnConfirmOk').click();
      await new Promise(r => setTimeout(r, 300));
      const d = window.__vaultDebug;
      d.state.view = { type: 'all', courseId: null };
      d.render();
    })()`);
  } finally {
    if (fileId) {
      try { await c.ev(`window.vault.files.remove(${JSON.stringify(fileId)}, false).then(() => window.__vaultDebug.refresh())`); } catch {}
    }
    for (const p of created) { try { fs.unlinkSync(p); } catch {} }
    const final = await c.ev(`window.vault.getState().then(s => ({ files: s.files.length, courses: s.courses.length, trash: s.trash.length }))`);
    log('\n清理后:', JSON.stringify(final));
    const okCount = results.filter(Boolean).length;
    log(`${okCount}/${results.length} 项通过`);
    c.close();
    if (okCount !== results.length) process.exit(1);
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
