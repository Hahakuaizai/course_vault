'use strict';

/**
 * 验证「打开整个项目」和「单独打开这个文件」真的传了不同的参数。
 *
 * 不启动真正的编辑器（会弹窗口、抢焦点）：写一个假 .bat 当程序，
 * 它把自己收到的所有参数写进 out.txt，读完比对。
 *
 * 期望：
 *   - mode: 'project' → 收到的是**项目根目录**，不带文件本身
 *   - 不给 mode      → 收到的是**文件路径**
 *   - code 系程序带 -r，其它程序不带
 */

const { connect } = require('./cdp.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEST_DIR = __dirname;

(async () => {
  const c = await connect();
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };
  const ev = (e) => c.ev(e);

  const stamp = Date.now();
  const root = path.join(TEST_DIR, `.tmp-openproj-${stamp}`);
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  // 有 package.json 才算项目，findProjectRoot 靠它
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"t"}', 'utf8');
  const mainPy = path.join(proj, 'main.py');
  fs.writeFileSync(mainPy, 'print(1)\n', 'utf8');

  // 两个假程序：名字决定走不走 -r 分支
  const fakeCode = path.join(root, 'code-fake.bat');
  const fakeOther = path.join(root, 'notepadpp-fake.bat');
  const BAT = '@echo off\r\necho %* > "%~dp0out.txt"\r\n';
  fs.writeFileSync(fakeCode, BAT, 'utf8');
  fs.writeFileSync(fakeOther, BAT, 'utf8');

  const outFile = path.join(root, 'out.txt');
  const readOut = () => (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '');

  let fileId = null;
  try {
    const reg = await ev(`(async () => {
      const d = window.__vaultDebug;
      const res = await window.vault.files.import(
        [${JSON.stringify(mainPy)}], null, 'link', 'skip',
      );
      d.apply(res.state);
      const rec = d.state.files.find((f) => f.path === ${JSON.stringify(mainPy)});
      return rec ? { id: rec.id } : { err: '没登记进库' };
    })()`);
    if (reg.err) throw new Error(reg.err);
    fileId = reg.id;
    check('测试文件登记进库', !!fileId);

    /* ---------- 1. 打开整个项目 ---------- */
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    const r1 = await ev(`window.vault.files.run(
      ${JSON.stringify(fileId)}, ${JSON.stringify(fakeCode)}, 'project',
    )`);
    await sleep(900);
    const args1 = readOut();
    check('项目模式：程序真的收到了参数', args1.length > 0, args1 || '（空）');
    check('项目模式：收到的是项目根目录',
      args1.includes('proj') && args1.includes(String(stamp)),
      args1);
    check('项目模式：没有把文件本身也塞进去', !args1.includes('main.py'), args1);
    check('项目模式：code 系带 -r（复用窗口）', /(^|\s)-r(\s|$)/.test(args1), args1);
    check('返回里报告了项目根', r1.projectRoot === proj, r1.projectRoot || 'null');

    /* ---------- 2. 单独打开这个文件 ---------- */
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    const r2 = await ev(`window.vault.files.run(
      ${JSON.stringify(fileId)}, ${JSON.stringify(fakeCode)},
    )`);
    await sleep(900);
    const args2 = readOut();
    check('文件模式：收到的是文件路径', args2.includes('main.py'), args2);
    // 参数是空格分隔的，「proj」作为一个独立参数出现才算传了项目目录
    check('文件模式：不再传项目目录', !args2.split(/\s+/).includes(proj), args2);
    check('文件模式：code 系同样带 -r', /(^|\s)-r(\s|$)/.test(args2), args2);
    check('文件模式的返回里没有项目根', !r2.projectRoot, r2.projectRoot || 'null');

    /* ---------- 3. 非 code 系程序不加 -r ---------- */
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    await ev(`window.vault.files.run(
      ${JSON.stringify(fileId)}, ${JSON.stringify(fakeOther)}, 'project',
    )`);
    await sleep(900);
    const args3 = readOut();
    check('非 code 系程序：也收到了项目目录', args3.includes('proj'), args3);
    check('非 code 系程序：不硬塞 -r', !/(^|\s)-r(\s|$)/.test(args3), args3);

    /* ---------- 4. 不在项目里的文件退回文件模式 ---------- */
    /* 这个文件必须放在真正「没有项目标志」的地方：test/ 在 course-vault 里，
       往上就是 package.json，findProjectRoot 会把它当成项目根，
       所以放系统临时目录。 */
    const lonelyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-lonely-'));
    const lone = path.join(lonelyDir, 'lonely.txt');
    fs.writeFileSync(lone, 'x', 'utf8');
    const reg2 = await ev(`(async () => {
      const d = window.__vaultDebug;
      const res = await window.vault.files.import(
        [${JSON.stringify(lone)}], null, 'link', 'skip',
      );
      d.apply(res.state);
      return d.state.files.find((f) => f.path === ${JSON.stringify(lone)})?.id || null;
    })()`);
    if (reg2) {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      const r4 = await ev(`window.vault.files.run(
        ${JSON.stringify(reg2)}, ${JSON.stringify(fakeCode)}, 'project',
      )`);
      await sleep(900);
      const args4 = readOut();
      check('没有项目时即便选了「整个项目」也退回打开文件',
        args4.includes('lonely.txt') && !r4.projectRoot, args4 || '（空）');
      try { fs.rmSync(lonelyDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      await ev(`(async () => {
        try {
          window.__vaultDebug.apply(await window.vault.files.removeMany(
            [${JSON.stringify(reg2)}], false,
          ));
        } catch { /* 忽略 */ }
      })()`).catch(() => {});
    }
  } finally {
    if (fileId) {
      await ev(`(async () => {
        try { window.__vaultDebug.apply(await window.vault.files.removeMany(
          [${JSON.stringify(fileId)}], false,
        )); } catch { /* 忽略 */ }
      })()`).catch(() => {});
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
