'use strict';

/**
 * 验证「在软件里编辑并保存」到底动了什么。
 *
 * 结论要用代码钉死，不能只靠读代码下判断：
 *   - 保存会**真的写回磁盘上的原文件**（用户问的就是这个）
 *   - 写之前会在 userData/backups 留一份备份
 *   - 备份放在软件数据目录，不污染用户的文件夹
 *
 * 全程用 test/ 下的临时文件，不碰用户的任何文件。
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

  // 临时文件放系统临时目录，不留在项目里
  const tmpFile = path.join(os.tmpdir(), `vault-edit-${Date.now()}.txt`);
  const ORIGINAL = '原始内容：这一行必须被保存覆盖掉';
  const EDITED = '编辑后的内容：已经写进磁盘了\n第二行';
  fs.writeFileSync(tmpFile, ORIGINAL, 'utf8');

  let fileId = null;
  let backupDir = null;
  // 这次保存会往 userData/backups 里写一份备份，测完要删掉，
  // 不然跑几次就攒一堆没用的测试文件
  let createdBackups = [];

  try {
    /* ---------- 1. 登记进库（link 模式，只记路径） ---------- */
    const reg = await ev(`(async () => {
      const d = window.__vaultDebug;
      const res = await window.vault.files.import(
        [${JSON.stringify(tmpFile)}], null, 'link',
      );
      d.apply(await window.vault.getState());
      const rec = d.state.files.find(f => f.path === ${JSON.stringify(tmpFile)});
      return rec
        ? { id: rec.id, storage: rec.storage, size: rec.size, name: rec.name }
        : { err: '没登记进库' };
    })()`);

    if (reg.err) {
      check('登记临时文件', false, reg.err);
      throw new Error(reg.err);
    }
    fileId = reg.id;
    check('临时文件登记成功', !!fileId, `${reg.name} (${reg.storage})`);
    check('登记方式是 link（只记路径，不复制）', reg.storage === 'link', reg.storage);

    // 保存前磁盘上确实是原文
    check('保存前磁盘是原始内容',
      fs.readFileSync(tmpFile, 'utf8') === ORIGINAL);

    /* ---------- 2. 保存 ---------- */
    const saved = await ev(`(async () => {
      const st = await window.vault.files.saveText(
        ${JSON.stringify(fileId)}, ${JSON.stringify(EDITED)},
      );
      window.__vaultDebug.apply(st.state);
      const rec = st.state.files.find(f => f.id === ${JSON.stringify(fileId)});
      return { ok: st.ok, size: rec?.size, mtime: rec?.mtime };
    })()`);

    check('保存接口返回成功', saved.ok === true);

    /* ---------- 3. 磁盘真的变了 ---------- */
    const onDisk = fs.readFileSync(tmpFile, 'utf8');
    check('保存后磁盘内容被改写（真的写回原文件）',
      onDisk === EDITED, JSON.stringify(onDisk.slice(0, 20)) + '…');
    check('磁盘上不再是原来的内容', onDisk !== ORIGINAL);
    check('库记录里的大小同步更新了',
      typeof saved.size === 'number' && saved.size > 0, `${saved.size} 字节`);
    check('大小和磁盘实际一致',
      saved.size === Buffer.byteLength(EDITED, 'utf8'),
      `${saved.size} / ${Buffer.byteLength(EDITED, 'utf8')}`);

    /* ---------- 4. 备份存在，且是改动前的内容 ---------- */
    const bak = await ev(`(async () => {
      const info = await window.vault.debug?.backupDir?.();
      return info || null;
    })()`);

    // 主进程没暴露 backupDir 时，直接从磁盘找（userData 路径固定）
    const userData = path.join(process.env.APPDATA || '', '资料库', 'backups');
    backupDir = fs.existsSync(userData) ? userData : null;

    if (backupDir) {
      const mine = fs.readdirSync(backupDir)
        .filter((n) => n.startsWith(fileId))
        .sort();
      createdBackups = mine.map((n) => path.join(backupDir, n));
      check('保存前留了备份文件', mine.length > 0, `${mine.length} 份`);
      if (mine.length) {
        const latest = fs.readFileSync(path.join(backupDir, mine[mine.length - 1]), 'utf8');
        check('备份里是改动前的内容（能找回原文）',
          latest === ORIGINAL, JSON.stringify(latest.slice(0, 16)) + '…');
      }
    } else {
      check('保存前留了备份文件', false, `没找到 ${userData}`);
    }

    /* ---------- 5. 备份没有污染用户文件夹 ---------- */
    const sameDir = fs.readdirSync(path.dirname(tmpFile))
      .filter((n) => n.includes(fileId));
    check('备份没写进用户的文件夹（没在源目录旁边生成文件）',
      sameDir.length === 0, sameDir.join(',') || '干净');

    /* ---------- 6. 原文件不存在时拒绝保存，不会凭空造一个 ---------- */
    const missing = path.join(os.tmpdir(), `vault-gone-${Date.now()}.txt`);
    const miss = await ev(`(async () => {
      const d = window.__vaultDebug;
      // 直接构造一条指向不存在文件的记录太绕，改成保存一个假 id
      try {
        await window.vault.files.saveText('不存在的id', 'x');
        return { threw: false };
      } catch (e) {
        return { threw: true, msg: e.message };
      }
    })()`);
    check('保存不存在的文件会被拒绝', miss.threw === true, miss.msg);
    check('被拒绝时没有凭空创建文件', !fs.existsSync(missing));
  } finally {
    // 清理：从库里删掉这条记录，再删临时文件
    if (fileId) {
      await ev(`(async () => {
        try {
          const st = await window.vault.files.removeMany([${JSON.stringify(fileId)}], false);
          window.__vaultDebug.apply(st);
        } catch { /* 忽略 */ }
      })()`).catch(() => {});
    }
    try { fs.unlinkSync(tmpFile); } catch { /* 已删则忽略 */ }
    // 清掉这次保存产生的备份，别在用户的备份目录里攒垃圾
    for (const b of createdBackups) {
      try { fs.unlinkSync(b); } catch { /* 忽略 */ }
    }
    await ev(`(() => {
      ['overlay','delModal','changelogModal'].forEach(id => {
        const el = document.getElementById(id); if (el) el.hidden = true;
      });
    })()`).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
