'use strict';

/**
 * 验证「重复文件」里的名字提示。
 *
 * 需求：
 *   - 名字完全不同、内容一样的（pr.png / roc.png）→ 列表里标出来，
 *     删除前还要把名字列一遍再确认
 *   - 「文件.txt」和「文件 (1).txt」这种自动编号副本 → 不额外啰嗦
 *
 * 测试在一个临时新建的目录里做，不碰用户已有的任何重复文件。
 * 两次删除都只点到「确认框」为止，按取消，不真的删东西。
 */

const { connect } = require('./cdp.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };
  const ev = (e) => c.ev(e);

  const stamp = Date.now();
  const dir = path.join(os.tmpdir(), `vault-dupe-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  // 两对内容相同、命名方式不同的文件
  const sameContent = 'duplicate-content-pair-one\n';
  const numberedContent = 'duplicate-content-pair-two\n';
  const files = {
    alpha: path.join(dir, `zz-alpha-${stamp}.txt`),
    beta: path.join(dir, `zz-beta-${stamp}.txt`),
    plain: path.join(dir, `文件-${stamp}.txt`),
    copy1: path.join(dir, `文件-${stamp} (1).txt`),
  };
  fs.writeFileSync(files.alpha, sameContent, 'utf8');
  fs.writeFileSync(files.beta, sameContent, 'utf8');
  fs.writeFileSync(files.plain, numberedContent, 'utf8');
  fs.writeFileSync(files.copy1, numberedContent, 'utf8');

  let courseId = null;
  let importedIds = [];

  /** 把文件按顺序导入测试目录，返回新记录的 id */
  const importInto = async (paths) => ev(`(async () => {
    const d = window.__vaultDebug;
    const res = await window.vault.files.import(
      ${JSON.stringify(paths)}, ${JSON.stringify(courseId)}, 'link',
    );
    d.apply(res.state);
    return res.state.files
      .filter((f) => ${JSON.stringify(paths)}.includes(f.path))
      .map((f) => f.id);
  })()`);

  /** 在当前视图（测试目录）里重新扫一遍并打开弹窗 */
  const rescan = async () => {
    await ev(`(async () => {
      const d = window.__vaultDebug;
      d.state.view = { type: 'course', courseId: ${JSON.stringify(courseId)} };
      d.render();
    })()`);
    await sleep(500);
    await ev(`document.querySelector('#btnFindDupes').click()`);
    await sleep(1500);
    return ev(`(() => {
      const m = document.querySelector('#dupeModal');
      if (!m || m.hidden) return { none: true };
      return {
        groupCount: m.querySelectorAll('.dupe-group').length,
        warnCount: m.querySelectorAll('.dupe-warn').length,
        names: [...m.querySelectorAll('.dupe-name')].map((e) => e.textContent.trim()),
        warnedNames: [...m.querySelectorAll('.dupe-file')]
          .filter((row) => row.querySelector('.dupe-warn'))
          .map((row) => row.querySelector('.dupe-name').textContent.trim()),
      };
    })()`);
  };

  /** 点删除，读确认框内容，然后取消 */
  const readConfirm = async () => {
    await ev(`document.querySelector('#btnDupeRemove').click()`);
    await sleep(800);
    const info = await ev(`(() => {
      const modal = document.querySelector('#confirmModal');
      const note = document.querySelector('#confirmNote');
      return {
        visible: !modal.hidden,
        title: document.querySelector('#confirmTitle').textContent.trim(),
        lead: document.querySelector('#confirmLead').textContent.trim(),
        noteHidden: note.hidden,
        noteText: note.textContent.trim(),
        danger: document.querySelector('#btnConfirmOk').classList.contains('danger-btn'),
        okText: document.querySelector('#btnConfirmOk').textContent.trim(),
      };
    })()`);
    await ev(`document.querySelector('#btnConfirmCancel').click()`);
    await sleep(400);
    return info;
  };

  try {
    /* ---------- 建测试目录 ---------- */
    const made = await ev(`(async () => {
      const d = window.__vaultDebug;
      const res = await window.vault.courses.create('zz-重复文件测试', '#5b8def', null);
      if (res?.state) d.apply(res.state);
      else d.apply(await window.vault.getState());
      const c = d.state.courses.filter((x) => x.name === 'zz-重复文件测试').pop();
      d.state.view = { type: 'course', courseId: c.id };
      d.render();
      return { id: c.id };
    })()`);
    courseId = made.id;
    check('建好隔离的测试目录', !!courseId);

    /* ---------- 阶段 A：自动编号副本，不该提示 ---------- */
    importedIds.push(...await importInto([files.plain, files.copy1]));
    const a = await rescan();
    if (a.none) throw new Error('重复文件弹窗没出来');

    check('检测到 1 组重复', a.groupCount === 1, `${a.groupCount} 组`);
    check('「文件.txt / 文件 (1).txt」不标「名字不同」',
      a.warnCount === 0, a.warnedNames.join(',') || `0 个标记（${a.names.join(' / ')}）`);

    const ca = await readConfirm();
    check('编号副本删除时用普通确认框', ca.visible === true, ca.title);
    check('编号副本没有「名字不同」名单', ca.noteHidden === true,
      ca.noteText ? `却出现了：${ca.noteText}` : '无附加说明');
    check('编号副本的删除按钮不是危险样式', ca.danger === false);

    /* ---------- 阶段 B：名字完全不同，要提示 ---------- */
    importedIds.push(...await importInto([files.alpha, files.beta]));
    const b = await rescan();

    check('检测到 2 组重复', b.groupCount === 2, `${b.groupCount} 组`);
    check('名字完全不同的两个文件都被标出来',
      b.warnCount === 2, b.warnedNames.join(' / ') || '0 个');
    check('被标的是那对名字不同的（不是编号副本那组）',
      b.warnedNames.length === 2
      && b.warnedNames.every((n) => n.startsWith('zz-')),
      b.warnedNames.join(' / '));

    const cb = await readConfirm();
    check('有名字不同的文件时弹出专门确认', cb.visible === true, cb.title);
    check('确认框标题点明了这件事', cb.title.includes('确认移除'), cb.title);
    check('确认框列出了名字不同的文件',
      !cb.noteHidden && cb.noteText.includes(`zz-beta-${stamp}.txt`),
      cb.noteText.replace(/\s+/g, ' ') || '空');
    check('这种删除的确认按钮标成危险色', cb.danger === true);
    check('确认按钮文案变成「确认移除」', cb.okText.includes('确认'), cb.okText);

    // 取消后什么都没删
    const still = await ev(`(async () => {
      const st = await window.vault.getState();
      return st.files.filter((f) => ${JSON.stringify([files.alpha, files.beta, files.plain, files.copy1])}
        .includes(f.path)).length;
    })()`);
    check('按取消后一个都没删', still === 4, `${still} 个还在`);
  } finally {
    // 清理：先删库记录，再删测试目录，最后删磁盘临时文件
    if (courseId) {
      await ev(`(async () => {
        const d = window.__vaultDebug;
        const ids = ${JSON.stringify(importedIds)};
        if (ids.length) {
          try { d.apply(await window.vault.files.removeMany(ids, false)); } catch { /* 忽略 */ }
        }
        try {
          const res = await window.vault.courses.remove(${JSON.stringify(courseId)}, false);
          if (res?.state) d.apply(res.state);
        } catch { /* 忽略 */ }
        d.state.view = { type: 'all', courseId: null };
        d.render();
      })()`).catch(() => {});
    }
    for (const p of Object.values(files)) {
      try { fs.unlinkSync(p); } catch { /* 已删则忽略 */ }
    }
    try { fs.rmdirSync(dir); } catch { /* 忽略 */ }
    await ev(`(() => {
      ['dupeModal', 'confirmModal', 'settingsModal'].forEach((id) => {
        const el = document.getElementById(id); if (el) el.hidden = true;
      });
    })()`).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
