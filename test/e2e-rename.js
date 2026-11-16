/**
 * 端到端验证「右键 → 重命名」并同步磁盘。
 * 全程在 test 目录造临时文件，测完清理，绝不碰用户的真实文件。
 */
const { connect } = require('./cdp.js');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);
  let fileId = null;

  try {
    // ---- 造一个临时文件并导入 ----
    const src = path.join(TEST_DIR, `_e2e_${Date.now()}.txt`);
    fs.writeFileSync(src, 'e2e rename test\n', 'utf8');

    const imp = await c.ev(`(async () => {
      const s = await window.vault.getState();
      const f = s.files.find(x => x.name === 'mama.py');
      const r = await window.vault.files.import([${JSON.stringify(src)}], f.courseId, 'link', 'allow', false);
      const nf = r.state.files.find(x => x.path.toLowerCase() === ${JSON.stringify(src.toLowerCase())});
      await window.__vaultDebug.refresh();
      return nf ? { id: nf.id, courseId: nf.courseId, name: nf.name } : { err: 'notfound' };
    })()`);
    if (!imp.id) throw new Error('导入失败');
    fileId = imp.id;
    log('① 导入:', imp.name);

    // ---- 切到所在目录，右键点「重命名」 ----
    await c.ev(`(() => {
      window.__vaultDebug.state.view = { type: 'course', courseId: ${JSON.stringify(imp.courseId)} };
      window.__vaultDebug.render();
    })()`);
    await sleep(500);

    const opened = await c.ev(`(() => {
      const card = document.querySelector('.card[data-file="${imp.id}"]');
      if (!card) return { err: '卡片没渲染出来' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 40) }));
      const ctx = document.querySelector('.ctx-menu');
      const btn = [...(ctx?.querySelectorAll('.ctx-item') || [])].find(b => b.textContent.trim() === '重命名');
      if (!btn) return { err: '菜单里没有重命名' };
      btn.click();
      const inp = document.querySelector('#renameInput');
      return {
        modalOpen: !document.querySelector('#renameModal').hidden,
        value: inp?.value,
        selected: [inp?.selectionStart, inp?.selectionEnd],
        extKeptOut: inp?.value.slice(inp.selectionEnd),
      };
    })()`);
    log('② 弹窗:', JSON.stringify(opened));
    if (opened.err) throw new Error(opened.err);

    // ---- 只输入主名，扩展名应自动保留 ----
    const saved = await c.ev(`(async () => {
      const inp = document.querySelector('#renameInput');
      inp.value = '_e2e_renamed';
      document.querySelector('#btnRenameSave').click();
      await new Promise(r => setTimeout(r, 900));
      return {
        modalClosed: document.querySelector('#renameModal').hidden,
        names: [...document.querySelectorAll('.card[data-file]')].map(e => e.querySelector('.card-name')?.textContent),
        record: (window.__vaultDebug.state.files.find(f => f.id === ${JSON.stringify(imp.id)}) || {}).name,
      };
    })()`);
    log('③ 保存后:', JSON.stringify(saved));

    const onDisk = fs.existsSync(path.join(TEST_DIR, '_e2e_renamed.txt'));
    log('④ 磁盘上是 _e2e_renamed.txt:', onDisk);
    log('   旧文件还在吗:', fs.existsSync(src));

    // ---- 冲突检测 ----
    fs.writeFileSync(path.join(TEST_DIR, '_e2e_blocker.txt'), 'x', 'utf8');
    const conflict = await c.ev(`(async () => {
      try {
        await window.vault.files.rename(${JSON.stringify(imp.id)}, '_e2e_blocker.txt');
        return { shouldNotHappen: true };
      } catch (e) { return { err: e.message.split('Error: ').pop() }; }
    })()`);
    log('⑤ 重名冲突:', JSON.stringify(conflict));
    fs.unlinkSync(path.join(TEST_DIR, '_e2e_blocker.txt'));

    // ---- 结果 ----
    const pass = saved.modalClosed && saved.record === '_e2e_renamed.txt' && onDisk
      && !fs.existsSync(src) && !!conflict.err;
    log(pass ? '\n✅ 全部通过' : '\n❌ 有项未通过');
  } finally {
    // 清理
    if (fileId) {
      try { await c.ev(`window.vault.files.remove(${JSON.stringify(fileId)}, false).then(() => window.__vaultDebug.refresh())`); } catch { /* 忽略 */ }
    }
    for (const n of fs.readdirSync(TEST_DIR).filter((x) => x.startsWith('_e2e_'))) {
      try { fs.unlinkSync(path.join(TEST_DIR, n)); } catch { /* 忽略 */ }
    }
    const st = await c.ev(`window.vault.getState().then(s => ({ files: s.files.length, courses: s.courses.length, trash: s.trash.length }))`);
    log('清理后:', JSON.stringify(st));
    c.close();
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
