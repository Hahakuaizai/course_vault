/** 验证所有「开关型」快捷键：再按一次能关闭 */
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

  const press = (init) => c.ev(`(() => {
    const e = new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })});
    document.dispatchEvent(e);
    return e.defaultPrevented;
  })()`);

  const isOpen = (id) => c.ev(`!document.querySelector('#${id}').hidden`);

  try {
    // 先确保没有弹窗挡着
    await c.ev(`(() => {
      ['shortcutsModal','settingsModal','courseModal','newFileModal','importModal','confirmModal','delModal','dupModal','detailModal','dupeModal','relocateModal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      const d = window.__vaultDebug;
      d.state.view = { type: 'all', courseId: null };
      d.render();
    })()`);
    await sleep(400);

    // ---- 1. Ctrl+/ 开 → 关 ----
    await press({ key: '/', ctrlKey: true });
    await sleep(350);
    const sc1 = await isOpen('shortcutsModal');
    await press({ key: '/', ctrlKey: true });
    await sleep(350);
    const sc2 = await isOpen('shortcutsModal');
    check('Ctrl+/ 打开', sc1);
    check('Ctrl+/ 再按关闭', !sc2);

    // 三连按确认稳定
    await press({ key: '/', ctrlKey: true });
    await sleep(250);
    await press({ key: '/', ctrlKey: true });
    await sleep(250);
    await press({ key: '/', ctrlKey: true });
    await sleep(350);
    check('Ctrl+/ 三连按后是打开状态', await isOpen('shortcutsModal'));
    await press({ key: '/', ctrlKey: true });
    await sleep(300);

    // ---- 2. ? 也是开关 ----
    await press({ key: '?' });
    await sleep(300);
    const q1 = await isOpen('shortcutsModal');
    await press({ key: '?' });
    await sleep(300);
    check('? 打开', q1);
    check('? 再按关闭', !await isOpen('shortcutsModal'));

    // ---- 3. Ctrl+, 设置开关 ----
    await press({ key: ',', ctrlKey: true });
    await sleep(500);
    const s1 = await isOpen('settingsModal');
    await press({ key: ',', ctrlKey: true });
    await sleep(350);
    const s2 = await isOpen('settingsModal');
    check('Ctrl+, 打开设置', s1);
    check('Ctrl+, 再按关闭设置', !s2);

    // ---- 4. Ctrl+N 新建文件开关 ----
    await press({ key: 'n', ctrlKey: true });
    await sleep(400);
    const n1 = await isOpen('newFileModal');
    await press({ key: 'n', ctrlKey: true });
    await sleep(350);
    const n2 = await isOpen('newFileModal');
    check('Ctrl+N 打开', n1);
    check('Ctrl+N 再按关闭', !n2);

    // ---- 5. Ctrl+Shift+N 新建文件夹开关 ----
    await press({ key: 'N', ctrlKey: true, shiftKey: true });
    await sleep(400);
    const d1 = await isOpen('courseModal');
    await press({ key: 'N', ctrlKey: true, shiftKey: true });
    await sleep(350);
    const d2 = await isOpen('courseModal');
    check('Ctrl+Shift+N 打开', d1);
    check('Ctrl+Shift+N 再按关闭', !d2);

    // ---- 6. Ctrl+I 导入文件开关 ----
    await press({ key: 'i', ctrlKey: true });
    await sleep(400);
    const i1 = await isOpen('importModal');
    await press({ key: 'i', ctrlKey: true });
    await sleep(350);
    const i2 = await isOpen('importModal');
    check('Ctrl+I 打开', i1);
    check('Ctrl+I 再按关闭', !i2);

    // ---- 7. Ctrl+M 多选模式开关（原有）----
    const m1 = await c.ev(`window.__vaultDebug.state.selectMode`);
    await press({ key: 'm', ctrlKey: true });
    await sleep(250);
    const m2 = await c.ev(`window.__vaultDebug.state.selectMode`);
    await press({ key: 'm', ctrlKey: true });
    await sleep(250);
    const m3 = await c.ev(`window.__vaultDebug.state.selectMode`);
    check('Ctrl+M 多选模式开关', m1 !== m2 && m2 !== m3, `${m1} → ${m2} → ${m3}`);

    // ---- 8. Ctrl+F 搜索聚焦 / 失焦 ----
    await press({ key: 'f', ctrlKey: true });
    await sleep(300);
    const f1 = await c.ev(`document.activeElement === document.querySelector('#searchInput')`);
    await press({ key: 'f', ctrlKey: true });
    await sleep(300);
    const f2 = await c.ev(`document.activeElement === document.querySelector('#searchInput')`);
    check('Ctrl+F 聚焦搜索框', f1);
    check('Ctrl+F 再按失焦', !f2);

    // ---- 9. Ctrl+E 编辑开关 ----
    const src = path.join(TEST_DIR, `_tg_${Date.now()}.py`);
    fs.writeFileSync(src, 'def f():\n    return 1\n', 'utf8');
    created.push(src);

    const setup = await c.ev(`(async () => {
      const s = await window.vault.getState();
      const f = s.files.find(x => x.name === 'mama.py');
      const r = await window.vault.files.import([${JSON.stringify(src)}], f.courseId, 'link', 'allow', false);
      await window.__vaultDebug.refresh();
      const nf = r.state.files.find(x => x.path.toLowerCase() === ${JSON.stringify(src.toLowerCase())});
      return { id: nf.id };
    })()`);
    fileId = setup.id;

    await c.ev(`window.__vaultDebug.openPreview(${JSON.stringify(fileId)})`);
    await sleep(1100);

    await press({ key: 'e', ctrlKey: true });
    await sleep(600);
    const e1 = await c.ev(`!!document.querySelector('.editor')`);
    await press({ key: 'e', ctrlKey: true });
    await sleep(700);
    const e2 = await c.ev(`({ editing: !!document.querySelector('.editor'),
      overlayOpen: !document.querySelector('#overlay').hidden })`);
    check('Ctrl+E 进入编辑', e1);
    check('Ctrl+E 再按退出编辑', !e2.editing);
    check('退出编辑后预览还在', e2.overlayOpen);

    // ---- 10. 编辑中有改动时，Ctrl+E 应弹确认 ----
    await press({ key: 'e', ctrlKey: true });
    await sleep(600);
    const dirty = await c.ev(`(async () => {
      const ta = document.querySelector('.editor');
      ta.value += '\\n# changed';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 500));
      return {
        confirmShown: !document.querySelector('#confirmModal').hidden,
        title: document.querySelector('#confirmTitle')?.textContent,
        stillEditing: !!document.querySelector('.editor'),
      };
    })()`);
    log('⑩ 有改动时 Ctrl+E:', JSON.stringify(dirty));
    check('有改动时退出编辑会确认', dirty.confirmShown);
    check('确认前仍在编辑', dirty.stillEditing);

    // 取消 → 应保持编辑
    await c.ev(`document.querySelector('#btnConfirmCancel').click()`);
    await sleep(400);
    check('取消后仍在编辑', await c.ev(`!!document.querySelector('.editor')`));

    // 再按 Ctrl+E 并确认放弃
    await c.ev(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 450));
      document.querySelector('#btnConfirmOk').click();
      await new Promise(r => setTimeout(r, 700));
    })()`);
    const after = await c.ev(`({ editing: !!document.querySelector('.editor'),
      overlayOpen: !document.querySelector('#overlay').hidden })`);
    check('确认后退出编辑', !after.editing);
    check('退出后预览仍在', after.overlayOpen);

    // ---- 11. 确认放弃后，磁盘文件不应被改 ----
    const disk = fs.readFileSync(src, 'utf8');
    check('放弃修改后磁盘文件未变', !disk.includes('# changed'), disk.trim().replace(/\n/g, ' | '));
  } finally {
    await c.ev(`(async () => {
      ['confirmModal','shortcutsModal','settingsModal','courseModal','newFileModal','importModal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      const ov = document.querySelector('#overlay');
      if (ov && !ov.hidden) { try { window.__vaultDebug.closePreview(); } catch {} }
      await new Promise(r => setTimeout(r, 300));
      const cm = document.getElementById('confirmModal');
      if (cm && !cm.hidden) document.getElementById('btnConfirmOk').click();
      await new Promise(r => setTimeout(r, 400));
    })()`).catch(() => {});

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
