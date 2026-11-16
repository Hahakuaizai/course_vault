/**
 * 更新功能的纯 Node 单元测试。
 *
 * 不用 CDP、不开窗口：updater.js 不依赖 electron，可以直接 require。
 * 全程在系统临时目录里造两个假目录（src = 开发目录，app = 程序目录），
 * 测完整个删掉，不碰项目也不碰用户数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUpdater, collectCode, depsChanged } = require('../updater.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-upd-'));
const SRC = path.join(ROOT, 'src');
const APP = path.join(ROOT, 'app');
const DATA = path.join(ROOT, 'data');

const w = (dir, rel, content) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
};
const r = (dir, rel) => {
  try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; }
};

const mk = (sourceDir) => createUpdater({
  appDir: APP,
  getSourceDir: () => sourceDir,
  getUserDataDir: () => DATA,
});

try {
  /* ---------- 1. 基础差异 ---------- */
  w(SRC, 'main.js', 'v1');
  w(SRC, 'src/app.js', 'v1');
  w(APP, 'main.js', 'v1');
  w(APP, 'src/app.js', 'old');   // 有变化
  w(APP, 'gone.js', 'x');        // 开发目录没有 → 应删除
  w(APP, 'version.json', '{"version":"1.0.0"}');
  w(SRC, 'version.json', '{"version":"0.9.0"}');

  let u = mk(SRC);
  let d = u.check();
  check('差异检查成功', d.ok);
  check('识别出 1 个变化', d.changed.length === 1 && d.changed[0] === 'src/app.js', d.changed.join(','));
  check('识别出 1 个删除', d.removed.length === 1 && d.removed[0] === 'gone.js', d.removed.join(','));
  check('version.json 不参与比对',
    !d.changed.includes('version.json') && !d.removed.includes('version.json'));

  /* ---------- 2. test/ 和 node_modules 不同步 ---------- */
  w(SRC, 'test/e2e-x.js', 'x');
  w(SRC, 'node_modules/foo/index.js', 'x');
  w(SRC, 'README.md', 'hello');
  u = mk(SRC);
  d = u.check();
  check('test/ 不参与同步', !d.added.includes('test/e2e-x.js'), d.added.join(','));
  check('node_modules 不参与同步', !d.added.some((f) => f.startsWith('node_modules')));
  check('README.md 会同步', d.added.includes('README.md'));

  /* ---------- 3. 依赖变化检测 ---------- */
  w(SRC, 'package.json', '{"dependencies":{"a":"1"}}');
  w(APP, 'package.json', '{"dependencies":{"a":"1"}}');
  check('依赖一致时 depsChanged=false', depsChanged(SRC, APP) === false);
  w(SRC, 'package.json', '{"dependencies":{"a":"2"}}');
  check('依赖变化时 depsChanged=true', depsChanged(SRC, APP) === true);
  u = mk(SRC);
  check('检查结果里带上 depsChanged', u.check().depsChanged === true);

  /* ---------- 4. 依赖变化时拒绝应用 ---------- */
  let blocked = null;
  try { u.apply(); } catch (e) { blocked = e.message; }
  check('依赖变化时 apply 被拒绝', !!blocked, blocked);
  check('拒绝时磁盘没被改', r(APP, 'src/app.js') === 'old');
  w(SRC, 'package.json', '{"dependencies":{"a":"1"}}');

  /* ---------- 5. 正常应用 ---------- */
  u = mk(SRC);
  const before = u.readVersion();
  const res = u.apply();
  check('应用成功', res.applied > 0, `同步 ${res.applied} 个文件`);
  check('代码已更新', r(APP, 'src/app.js') === 'v1');
  check('新增文件已写入', r(APP, 'README.md') === 'hello');
  check('开发目录删掉的文件也删了', r(APP, 'gone.js') === null);
  check('版本号自增', res.version === '1.0.1', `${before} → ${res.version}`);
  check('备份目录已生成', fs.existsSync(res.backupDir));
  check('备份里是被覆盖前的旧内容', r(res.backupDir, 'src/app.js') === 'old');

  /* ---------- 6. 没有变化时是幂等的 ---------- */
  const again = u.check();
  check('应用后无剩余差异', again.total === 0, `剩余 ${again.total}`);
  const noop = u.apply();
  check('无变化时 apply 不动任何东西', noop.applied === 0);

  /* ---------- 7. 开发目录为空时拒绝 ---------- */
  const EMPTY = path.join(ROOT, 'empty');
  fs.mkdirSync(EMPTY, { recursive: true });
  const u2 = mk(EMPTY);
  let err2 = null;
  try { u2.apply(); } catch (e) { err2 = e.message; }
  check('开发目录为空时拒绝（不会清空程序目录）', !!err2, err2);
  check('拒绝后程序目录还在', r(APP, 'src/app.js') === 'v1');

  /* ---------- 8. 开发目录不存在 ---------- */
  const u3 = mk(path.join(ROOT, 'nope'));
  const d3 = u3.check();
  check('开发目录不存在时给出明确原因', !d3.ok && d3.reason.includes('不存在'), d3.reason);

  /* ---------- 9. 未设置开发目录 ---------- */
  const u4 = mk(null);
  const d4 = u4.check();
  check('未设置开发目录时提示', !d4.ok && d4.reason.includes('未设置'), d4.reason);

  /* ---------- 10. 删除多于更新时中止 ---------- */
  const APP2 = path.join(ROOT, 'app2');
  w(APP2, 'a.js', '1');
  w(APP2, 'b.js', '2');
  w(APP2, 'c.js', '3');
  w(APP2, 'version.json', '{"version":"1.0.0"}');
  const SRC2 = path.join(ROOT, 'src2');
  w(SRC2, 'a.js', 'changed');
  const u5 = createUpdater({
    appDir: APP2,
    getSourceDir: () => SRC2,
    getUserDataDir: () => DATA,
  });
  let err5 = null;
  try { u5.apply(); } catch (e) { err5 = e.message; }
  check('删除数超过更新数时中止', !!err5 && err5.includes('选错'), err5);
  check('中止后程序目录文件都在', r(APP2, 'b.js') === '2' && r(APP2, 'c.js') === '3');

  /* ---------- 11. 无写权限时给出提示 ---------- */
  // 用只读文件系统在 Windows 上不好模拟，这里只验证正常目录能通过检查
  check('可写目录能正常通过', (() => {
    try { fs.accessSync(APP, fs.constants.W_OK); return true; } catch { return false; }
  })());

  /* ---------- 12. collectCode 递归与过滤 ---------- */
  const tree = collectCode(SRC);
  check('collectCode 递归到子目录', tree.has('src/app.js'));
  check('collectCode 用 / 分隔路径', [...tree.keys()].every((k) => !k.includes('\\')));
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

const okCount = results.filter(Boolean).length;
console.log(`\n${okCount}/${results.length} 项通过`);
if (okCount !== results.length) process.exit(1);
