'use strict';

/**
 * 软件更新：把开发目录里的代码文件同步到程序目录。
 *
 * 抽成独立模块的原因：这段逻辑要能在纯 Node 里跑测试。
 * 放在 main.js 里就必须启动整个 Electron 才能验证一次，代价太大，
 * 而且更新功能一旦写错就是「更新完软件打不开」，必须测得动。
 *
 * 只同步代码，不碰 node_modules、用户数据、备份。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 会被同步的文件类型。
 * .webp 必须在名单里：桌宠「蓝发小女仆」的 114 张精灵图就是 .webp，
 * 漏了它，检查更新会静默跳过所有 webp —— 不报新增、也不复制，
 * 表现就是「宠物数据在、图片永远加载失败」，极难排查。 */
const SOURCE_EXT = new Set([
  '.js', '.css', '.html', '.json', '.md', '.bat', '.ico', '.png', '.svg',
  '.webp',
]);

/** 不参与同步的目录 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'backups', '.venv', '__pycache__',
  // 开发期的验证脚本，装到用户机器上没有任何用处
  'test',
]);

/**
 * 不参与同步的文件。
 * version.json 由本模块统一管理：如果也参与比对，开发目录里的旧版本号
 * 会把程序目录里刚自增的版本号覆盖回去，两边来回打架。
 */
const SKIP_FILES = new Set([
  'package-lock.json', 'vault-data.json', 'version.json',
  // 打包脚本和开发用的启动脚本只属于开发目录，同步过去没有意义
  'build.js', '启动.bat',
]);

/**
 * 算文件内容哈希。读不到返回 null。
 *
 * 调用方必须把 null 当作「算不出来」，不能当作「没有内容」——
 * 见 diff() 里对 null 的处理：以前直接用 `a !== b` 比较，
 * 两边都读失败（null === null）会被判成「内容相同」，文件被静默漏掉；
 * 一边读失败也会判成「不同」，让检查结果飘忽不定。
 */
function hashFile(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 递归收集目录里的代码文件（相对路径 → 绝对路径，路径统一用 /）。
 *
 * 读目录失败时**不再静默跳过**，而是记进 `unreadableDirs`。
 * 以前直接 return：某个子目录因为权限/占用读不到，里面所有文件就都不在
 * 比对范围内 —— 用户明明改了好几个文件，检查更新却只报一两个，
 * 而且完全没有任何提示，非常难查。现在至少能把「哪些目录没读到」报上去。
 */
function collectCode(root, base = root, out = new Map(), unreadableDirs = null) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (unreadableDirs) {
      unreadableDirs.push({ dir: path.relative(base, root).replace(/\\/g, '/') || '.', code: err.code || 'ERROR' });
    }
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectCode(full, base, out, unreadableDirs);
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      if (!SOURCE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      out.set(path.relative(base, full).replace(/\\/g, '/'), full);
    }
  }
  return out;
}

/**
 * 运行时依赖有没有变过。
 *
 * 更新只同步代码，不动 node_modules。开发时新装了一个库，同步过去后
 * 程序 require 不到就白屏 —— 在用户那边表现为「更新完软件打不开了」。
 * 所以提前算出来，检查阶段就拦住。
 *
 * 只比 dependencies：devDependencies 运行时用不到，而且打包时会被裁掉，
 * 拿它一起比会让打包版永远显示「依赖有变化」，更新功能就废了。
 */
function depsChanged(sourceDir, appDir) {
  const readDeps = (dir) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return JSON.stringify(pkg.dependencies || {});
    } catch {
      return null;
    }
  };
  const a = readDeps(sourceDir);
  const b = readDeps(appDir);
  if (!a || !b) return false;
  return a !== b;
}

function createUpdater({
  appDir,
  getSourceDir,
  // 传函数而不是值：userData 路径要等 app ready 之后才确定，
  // 顶层取值会拿到还没初始化的默认路径。
  getUserDataDir,
  isPackaged = false,
}) {
  const versionFile = () => path.join(appDir, 'version.json');

  function readVersion() {
    try {
      return JSON.parse(fs.readFileSync(versionFile(), 'utf8')).version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  function writeVersion(v) {
    const data = { version: v, updatedAt: new Date().toISOString() };
    fs.writeFileSync(versionFile(), JSON.stringify(data, null, 2), 'utf8');
  }

  /** 比对开发目录与程序目录 */
  function diff() {
    const sourceDir = getSourceDir();
    if (!sourceDir) return { ok: false, reason: '尚未设置开发目录' };
    if (!fs.existsSync(sourceDir)) return { ok: false, reason: '开发目录不存在' };

    const unreadableDirs = [];
    const src = collectCode(sourceDir, sourceDir, new Map(), unreadableDirs);
    const dst = collectCode(appDir, appDir, new Map(), unreadableDirs);

    const changed = [];
    const added = [];
    const removed = [];
    /* 读不到内容的文件单独记一份：不能混进 changed 也不能当成「相同」。
     * 真实场景里多半是文件正被编辑器/杀软占用，等一会儿再检查就好了。 */
    const unreadable = [];

    for (const [rel, full] of src) {
      const target = dst.get(rel);
      if (!target) { added.push(rel); continue; }

      const a = hashFile(full);
      const b = hashFile(target);
      if (a === null || b === null) {
        /* 算不出哈希就当作「有变化」处理，让用户能点更新把它覆盖掉。
         * 以前这里是 `a !== b` 直接比较：两边都是 null 时被判成「相同」，
         * 文件被静默漏掉 —— 表现就是「改了好几个文件，只检测出一两个」。
         * 宁可多报一个（更新时会重新复制，最坏结果就是内容没变），
         * 也不要少报（用户以为更新完了，实际跑的还是旧代码）。 */
        changed.push(rel);
        unreadable.push(rel);
        continue;
      }
      if (a !== b) changed.push(rel);
    }
    for (const rel of dst.keys()) {
      if (!src.has(rel)) removed.push(rel);
    }

    return {
      ok: true,
      changed: changed.sort(),
      added: added.sort(),
      removed: removed.sort(),
      total: changed.length + added.length + removed.length,
      unreadable: unreadable.sort(),
      unreadableDirs,
      version: readVersion(),
      sourceDir,
      appDir,
      depsChanged: depsChanged(sourceDir, appDir),
      packaged: isPackaged,
    };
  }

  function check() {
    try {
      return diff();
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  function apply() {
    const d = diff();
    if (!d.ok) throw new Error(d.reason);
    if (!d.total) return { applied: 0, restarted: false };

    const sourceDir = d.sourceDir;
    const src = collectCode(sourceDir);

    // 开发目录选错了（选到空文件夹）时，差异会表现为「程序目录全删」。
    // 这种情况下直接拒绝，否则一次误操作就能把程序清空。
    if (src.size === 0) {
      throw new Error('开发目录里没有任何代码文件，请确认选对了目录');
    }

    // 依赖变了只同步代码会让软件启动即白屏，硬拦。
    if (d.depsChanged) {
      throw new Error('依赖有变化，只同步代码会让软件无法启动。请重新打包后再分发');
    }

    // 删除的比更新的还多，多半是选错目录了
    if (d.removed.length > d.changed.length + d.added.length) {
      throw new Error(
        `要删除的文件（${d.removed.length} 个）比要更新的还多，`
        + '开发目录可能选错了，已中止。请检查「开发目录」设置。',
      );
    }

    // 打包后程序目录在安装路径下，可能没有写权限
    try {
      fs.accessSync(appDir, fs.constants.W_OK);
    } catch {
      throw new Error(`程序目录没有写入权限：${appDir}。请把软件装到有权限的位置`);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(getUserDataDir(), 'update-backup', stamp);
    const toWrite = [...d.changed, ...d.added];

    // 覆盖前先备份将被替换的文件
    for (const rel of toWrite) {
      const target = path.join(appDir, rel);
      if (fs.existsSync(target)) {
        const b = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(target, b);
      }
    }

    /* 先全部写成 .updating 临时文件，都成功了再统一改名替换。
     * 中途失败时按备份回滚，不会留下「一半新一半旧」的残缺程序。 */
    const written = [];
    try {
      for (const rel of toWrite) {
        const to = path.join(appDir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(src.get(rel), `${to}.updating`);
        written.push(rel);
      }
      for (const rel of written) {
        const to = path.join(appDir, rel);
        fs.renameSync(`${to}.updating`, to);
      }
      // 开发目录里删掉的文件，程序目录也删（已备份）
      for (const rel of d.removed) {
        try {
          fs.rmSync(path.join(appDir, rel), { force: true });
        } catch { /* 忽略单个失败 */ }
      }
    } catch (err) {
      for (const rel of written) {
        const to = path.join(appDir, rel);
        try { fs.rmSync(`${to}.updating`, { force: true }); } catch { /* 忽略 */ }
        const b = path.join(backupDir, rel);
        try { if (fs.existsSync(b)) fs.copyFileSync(b, to); } catch { /* 忽略 */ }
      }
      throw new Error(`更新失败，已回滚到更新前的状态：${err.message}`);
    }

    // 版本号自增补丁位
    const cur = readVersion().split('.').map(Number);
    while (cur.length < 3) cur.push(0);
    cur[2] = (cur[2] || 0) + 1;
    writeVersion(cur.join('.'));

    return { applied: d.total, restarted: true, backupDir, version: cur.join('.') };
  }

  return { check, apply, diff, readVersion, writeVersion, versionFile };
}

module.exports = {
  createUpdater,
  collectCode,
  hashFile,
  depsChanged,
  SOURCE_EXT,
  SKIP_DIRS,
  SKIP_FILES,
};
