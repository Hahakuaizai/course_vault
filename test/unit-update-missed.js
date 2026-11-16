'use strict';

/**
 * 回归测试：锁住「改了好几个文件，检查更新只检测出一两个」这个 bug。
 *
 * 两个成因，都在这里覆盖：
 *   1. hashFile 读失败返回 null，比对时用 `a !== b`，两边都是 null 会被
 *      判成「相同」→ 文件静默漏掉。
 *   2. collectCode 读子目录失败时静默 return → 那个目录下所有文件都不参与
 *      比对，用户改的东西根本不进入检查范围。
 *
 * 纯 Node 跑：node test/unit-update-missed.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUpdater, collectCode, hashFile } = require('../updater');

const TMP = path.join(os.tmpdir(), `vault-missed-${process.pid}`);
const APP = path.join(TMP, 'app');
const DEV = path.join(TMP, 'dev');

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
  }
}

function write(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function makeUpdater() {
  return createUpdater({
    appDir: APP,
    getSourceDir: () => DEV,
    getUserDataDir: () => TMP,
    isPackaged: true,
  });
}

function main() {
  fs.rmSync(TMP, { recursive: true, force: true });

  /* ---------- 场景 1：改 6 个文件，必须全部报出来 ---------- */
  const BASE = {
    'main.js': 'main v1\n',
    'db.js': 'db v1\n',
    'preload.js': 'preload v1\n',
    'src/app.js': 'app v1\n',
    'src/index.html': '<html>v1</html>\n',
    'src/styles.css': 'body{}\n',
    'src/theme-switch.js': 'switch v1\n',
  };
  for (const [rel, text] of Object.entries(BASE)) {
    write(APP, rel, text);
    write(DEV, rel, text);
  }

  let u = makeUpdater();
  check('两边完全一致时没有变化', u.diff().total === 0, u.diff().total);

  // 改 6 个（不动 theme-switch.js）
  const EDITED = ['main.js', 'db.js', 'preload.js', 'src/app.js', 'src/index.html', 'src/styles.css'];
  for (const rel of EDITED) write(DEV, rel, `${BASE[rel]}/* edited */\n`);

  let d = u.diff();
  check('改 6 个文件全部被检测到', d.total === 6, d.total);
  check('检测出的正是这 6 个',
    JSON.stringify(d.changed) === JSON.stringify([...EDITED].sort()),
    d.changed);

  /* ---------- 场景 2：新增 + 删除也都要报 ---------- */
  write(DEV, 'src/brand-new.js', 'export const a = 1;\n');
  fs.rmSync(path.join(DEV, 'src', 'theme-switch.js'));

  d = u.diff();
  check('新增文件被检测到', d.added.includes('src/brand-new.js'), d.added);
  check('删除文件被检测到', d.removed.includes('src/theme-switch.js'), d.removed);
  check('总数 = 6 改 + 1 增 + 1 删', d.total === 8, d.total);

  /* ---------- 场景 3：文件读不到时不能当成「相同」 ----------
   * 造一个「存在但读不出来」的文件：patch fs.readFileSync，让指定路径抛
   * EBUSY（真实场景是文件被编辑器/杀软占用）。updater 里 require 的是同一个
   * fs 对象，所以 patch 能生效；collectCode 用的是 readdirSync，不受影响。 */
  const origRead = fs.readFileSync;
  const busy = (p) => String(p).endsWith('main.js') || String(p).endsWith('db.js');
  fs.readFileSync = (p, ...rest) => {
    if (busy(p)) {
      const e = new Error(`EBUSY: resource busy or locked, open '${p}'`);
      e.code = 'EBUSY';
      throw e;
    }
    return origRead(p, ...rest);
  };

  check('读失败时 hashFile 返回 null', hashFile(path.join(DEV, 'main.js')) === null);

  d = u.diff();
  check('读不到内容的文件仍被报为有变化（不能静默漏掉）',
    d.changed.includes('main.js'), d.changed);
  check('读不到的文件被单独记进 unreadable',
    (d.unreadable || []).includes('main.js'), d.unreadable);

  /* ---------- 场景 4：两边都读不到（旧代码会判成「相同」而漏掉） ---------- */
  check('两边都读不到时仍报为有变化', d.changed.includes('db.js'), d.changed);
  check('两边都读不到时也记进 unreadable',
    (d.unreadable || []).includes('db.js'), d.unreadable);

  fs.readFileSync = origRead; // 恢复正常读
  d = u.diff();
  check('恢复可读后不再报 unreadable',
    (d.unreadable || []).length === 0, d.unreadable);

  /* ---------- 场景 5：子目录读不到时能被报出来 ---------- */
  const out = new Map();
  const bad = [];
  collectCode(path.join(TMP, 'does-not-exist'), path.join(TMP, 'does-not-exist'), out, bad);
  check('读不到的目录被记下来', bad.length === 1 && bad[0].code === 'ENOENT', bad);

  /* ---------- 场景 6：apply 之后必须真的没差异了 ---------- */
  u.apply();
  const after = u.diff();
  check('应用更新后 total 归零', after.total === 0, {
    total: after.total, changed: after.changed, added: after.added, removed: after.removed,
  });

  /* ---------- 场景 7：内容逐字节一致（不是只改了时间戳） ---------- */
  let allSame = true;
  for (const rel of collectCode(DEV).keys()) {
    const a = fs.readFileSync(path.join(DEV, rel), 'utf8');
    const b = fs.readFileSync(path.join(APP, rel), 'utf8');
    if (a !== b) { allSame = false; console.log(`    内容不一致: ${rel}`); }
  }
  check('更新后开发目录与程序目录内容逐字节一致', allSame);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('致命：', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(2);
}
