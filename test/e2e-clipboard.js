/** 验证剪切 / 复制 / 移动到，全部用 test 目录的临时文件 */
const { connect } = require('./cdp.js');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);
  const created = [];
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(ok);
    log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    // 造两个临时文件
    const src1 = path.join(TEST_DIR, `_cb1_${Date.now()}.txt`);
    const src2 = path.join(TEST_DIR, `_cb2_${Date.now()}.txt`);
    fs.writeFileSync(src1, 'clipboard test 1\n', 'utf8');
    fs.writeFileSync(src2, 'clipboard test 2\n', 'utf8');
    created.push(src1, src2);

    const setup = await c.ev(`(async () => {
      const s = await window.vault.getState();
      const f = s.files.find(x => x.name === 'mama.py');
      const srcCourse = f.courseId;
      // 找一个不同的目录当目标
      const dest = s.courses.find(x => x.id !== srcCourse && !x.parentId);
      const r = await window.vault.files.import([${JSON.stringify(src1)}, ${JSON.stringify(src2)}], srcCourse, 'link', 'allow', false);
      await window.__vaultDebug.refresh();
      const ids = r.state.files.filter(x => x.path.includes('_cb1_') || x.path.includes('_cb2_')).map(x => x.id);
      return { srcCourse, destId: dest?.id, destName: dest?.name, ids, total: r.state.files.length };
    })()`);
    log('① 准备:', JSON.stringify(setup));
    if (setup.ids.length !== 2) throw new Error('导入数量不对');

    // ---- 测试「复制」：记录数应 +2，原记录还在 ----
    const copyRes = await c.ev(`(async () => {
      const before = (await window.vault.getState()).files.length;
      const r = await window.vault.files.copyMany(${JSON.stringify(setup.ids)}, [], ${JSON.stringify(setup.destId)});
      const after = r.state.files.length;
      const originals = r.state.files.filter(f => ${JSON.stringify(setup.ids)}.includes(f.id));
      const copies = r.state.files.filter(f => f.courseId === ${JSON.stringify(setup.destId)} && /_cb[12]_/.test(f.name));
      return {
        before, after, delta: after - before,
        originalsKept: originals.length,
        copiesInDest: copies.length,
        copiesHaveNewIds: copies.every(c => !${JSON.stringify(setup.ids)}.includes(c.id)),
      };
    })()`);
    log('② 复制:', JSON.stringify(copyRes));
    check('复制后记录 +2', copyRes.delta === 2);
    check('复制保留原记录', copyRes.originalsKept === 2);
    check('副本在新目录', copyRes.copiesInDest === 2);
    check('副本是新 id', copyRes.copiesHaveNewIds);

    // 清掉副本，避免影响后续计数
    await c.ev(`(async () => {
      const s = await window.vault.getState();
      const dup = s.files.filter(f => f.courseId === ${JSON.stringify(setup.destId)} && /_cb[12]_/.test(f.name));
      for (const f of dup) await window.vault.files.remove(f.id, false);
      await window.__vaultDebug.refresh();
    })()`);

    // ---- 测试「剪切/移动」：记录数不变，归属改变 ----
    const moveRes = await c.ev(`(async () => {
      const before = (await window.vault.getState()).files.length;
      const r = await window.vault.files.moveMany(${JSON.stringify(setup.ids)}, ${JSON.stringify(setup.destId)});
      const moved = r.state.files.filter(f => ${JSON.stringify(setup.ids)}.includes(f.id));
      return {
        delta: r.state.files.length - before,
        allInDest: moved.every(f => f.courseId === ${JSON.stringify(setup.destId)}),
      };
    })()`);
    log('③ 移动:', JSON.stringify(moveRes));
    check('移动不改变记录总数', moveRes.delta === 0);
    check('移动后归属正确', moveRes.allInDest);

    // ---- 测试「复制目录」：整棵子树都复制 ----
    const dirRes = await c.ev(`(async () => {
      const s = await window.vault.getState();
      const src = s.courses.find(x => x.name === 'code');
      if (!src) return { err: '没找到 code 目录' };
      const before = s.courses.length;
      const beforeFiles = s.files.length;
      const r = await window.vault.files.copyMany([], [src.id], ${JSON.stringify(setup.destId)});
      const newDirs = r.state.courses.filter(c => c.parentId === ${JSON.stringify(setup.destId)} && c.name === 'code');
      return {
        dirDelta: r.state.courses.length - before,
        fileDelta: r.state.files.length - beforeFiles,
        newCopies: newDirs.length,
        newId: newDirs[0]?.id,
      };
    })()`);
    log('④ 复制目录:', JSON.stringify(dirRes));
    if (dirRes.err) {
      check('复制目录', false, dirRes.err);
    } else {
      check('目录复制出了新副本', dirRes.newCopies >= 1);
      check('目录子树一起复制', dirRes.dirDelta >= 1);
    }

    // 清理复制出来的目录
    await c.ev(`(async () => {
      const s = await window.vault.getState();
      const d = s.courses.find(c => c.parentId === ${JSON.stringify(setup.destId)} && c.name === 'code');
      if (d) await window.vault.courses.remove(d.id, false);
      await window.__vaultDebug.refresh();
    })()`);
  } finally {
    // 清理测试文件记录
    await c.ev(`(async () => {
      const s = await window.vault.getState();
      const t = s.files.filter(f => /_cb[12]_/.test(f.name));
      for (const f of t) { try { await window.vault.files.remove(f.id, false); } catch {} }
      await window.__vaultDebug.refresh();
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
