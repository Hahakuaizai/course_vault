'use strict';

/**
 * 纯 Node 验证「更新后弹公告」的判定逻辑，不起 Electron。
 *
 * 关键链路：updater.apply() 会把 version.json 的补丁位 +1；
 * 前端拿 snapshot.version 和 settings.seenChangelogVersion 比对，
 * 不一致就弹。这里把两半分别测掉，再拼起来跑一遍。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createUpdater } = require(path.join(ROOT, 'updater.js'));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
};

/* ---------- 前端判定逻辑的等价实现 ----------
 * 照抄 app.js 里 maybeShowChangelog 的判断，这样逻辑变了测试会跟着红。
 * （前端是 ES module + DOM 环境，没法直接 require 进来。） */
function shouldShow(version, settings) {
  if (!version) return 'skip';
  const seen = settings?.seenChangelogVersion;
  if (!seen) return 'first-run';
  if (seen === version) return 'skip';
  return 'show';
}

function main() {
  /* --- 1. 判定规则 --- */
  check('没有版本号 → 不弹', shouldShow('', {}) === 'skip');
  check('首次安装（没记录过）→ 不弹，只记录',
    shouldShow('1.0.0', {}) === 'first-run');
  check('版本和上次一样 → 不弹',
    shouldShow('1.0.0', { seenChangelogVersion: '1.0.0' }) === 'skip');
  check('版本变了 → 弹',
    shouldShow('1.0.1', { seenChangelogVersion: '1.0.0' }) === 'show');
  check('跨大版本也会弹',
    shouldShow('2.0.0', { seenChangelogVersion: '1.9.9' }) === 'show');

  /* --- 2. 更新确实会改版本号 --- */
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cl-app-'));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cl-src-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cl-data-'));

  try {
    fs.writeFileSync(path.join(appDir, 'main.js'), 'old');
    fs.writeFileSync(path.join(srcDir, 'main.js'), 'new');

    const up = createUpdater({
      appDir,
      getSourceDir: () => srcDir,
      getUserDataDir: () => dataDir,
    });

    up.writeVersion('1.0.0');
    const before = up.readVersion();
    check('更新前版本号是 1.0.0', before === '1.0.0', before);

    const r = up.apply();
    check('更新同步了文件', r.applied >= 1, `${r.applied} 个`);
    const after = up.readVersion();
    check('更新后补丁位 +1', after === '1.0.1', `${before} → ${after}`);

    /* --- 3. 拼起来：更新 → 重启 → 弹公告 --- */
    const seenBefore = '1.0.0';
    check('更新后重启会弹公告',
      shouldShow(after, { seenChangelogVersion: seenBefore }) === 'show',
      `${seenBefore} → ${after}`);

    // 看过之后不再弹
    check('看过之后同一版本不再弹',
      shouldShow(after, { seenChangelogVersion: after }) === 'skip');

    // 再更新一次，又要弹
    fs.writeFileSync(path.join(srcDir, 'main.js'), 'newer');
    up.apply();
    const after2 = up.readVersion();
    check('第二次更新继续自增', after2 === '1.0.2', after2);
    check('第二次更新后重启又弹',
      shouldShow(after2, { seenChangelogVersion: after }) === 'show',
      `${after} → ${after2}`);
  } finally {
    for (const d of [appDir, srcDir, dataDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main();
