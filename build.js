'use strict';

/**
 * 免安装版打包脚本（不需要 electron-builder，不联网）。
 *
 * 做法是直接复用 node_modules/electron/dist 里已经下好的运行时：
 *   1. 把整个运行时复制到输出目录
 *   2. electron.exe 改名成「资料库.exe」，用 resedit 换图标和版本信息
 *   3. 代码放到 resources/app/（必须关 asar，否则更新功能写不进文件）
 *   4. 生产依赖也一并复制过去
 *
 * 用法：node build.js [输出目录]
 * 默认输出到 E:\Apps\资料库 —— 不往 C 盘放。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PRODUCT = '资料库';
const OUT = process.argv[2] || 'E:\\Apps\\资料库';

/** 要放进 resources/app/ 的代码文件（相对项目根） */
const APP_FILES = [
  'main.js', 'preload.js', 'db.js', 'updater.js',
  'package.json', 'version.json', 'README.md',
];
const APP_DIRS = ['src', 'assets'];

/** 打包时不需要带过去的开发文件 */
const EXCLUDE_FROM_APP = new Set(['test', 'build.js', '.build-tools', 'package-lock.json']);

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (filter && !filter(e)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

async function main() {
  const t0 = Date.now();
  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(electronDist)) {
    throw new Error('找不到 Electron 运行时，请先执行 npm install');
  }

  console.log(`打包到：${OUT}`);
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  /* ---- 1. 复制运行时 ---- */
  console.log('· 复制 Electron 运行时…');
  copyDir(electronDist, OUT);

  /* ---- 2. 改主程序名 ---- */
  const exeOld = path.join(OUT, 'electron.exe');
  const exeNew = path.join(OUT, `${PRODUCT}.exe`);
  fs.renameSync(exeOld, exeNew);

  /* ---- 3. 放代码 ---- */
  console.log('· 复制代码…');
  const appDir = path.join(OUT, 'resources', 'app');
  rmrf(appDir);
  fs.mkdirSync(appDir, { recursive: true });
  for (const f of APP_FILES) {
    const s = path.join(ROOT, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(appDir, f));
  }
  for (const d of APP_DIRS) {
    const s = path.join(ROOT, d);
    if (fs.existsSync(s)) copyDir(s, path.join(appDir, d));
  }

  /* ---- 4. 生产依赖 ---- */
  console.log('· 复制依赖…');
  const nmSrc = path.join(ROOT, 'node_modules');
  const nmDst = path.join(appDir, 'node_modules');
  const prodDeps = Object.keys(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {},
  );
  /* 递归展开传递依赖：只复制 dependencies 里直接列的那些，
   * 但它们的依赖（pako、underscore 之类）也必须带上，否则运行时报错。 */
  const needed = new Set();
  const queue = [...prodDeps];
  while (queue.length) {
    const name = queue.pop();
    if (!name || needed.has(name)) continue;
    const pkgPath = path.join(nmSrc, name, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    needed.add(name);
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { continue; }
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push(dep);
    // 可选依赖缺失不影响主流程，能装就带上
    for (const dep of Object.keys(pkg.optionalDependencies || {})) queue.push(dep);
  }
  for (const name of needed) {
    const s = path.join(nmSrc, name);
    const d = path.join(nmDst, name);
    if (!fs.existsSync(s)) continue;
    copyDir(s, d, (e) => e.name !== '.bin' && e.name !== 'test' && e.name !== 'docs');
  }
  console.log(`  带了 ${needed.size} 个包：${[...needed].sort().join(', ')}`);

  /* ---- 5. 改图标和版本信息 ---- */
  console.log('· 写入图标与版本信息…');
  await patchExe(exeNew);

  /* ---- 6. 收尾 ---- */
  const size = dirSize(OUT);
  console.log(`\n✅ 完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，共 ${bytes(size)}`);
  console.log(`   程序：${exeNew}`);
  return { exe: exeNew, out: OUT, size };
}

/** 用 resedit 替换 exe 的图标与版本资源 */
async function patchExe(exePath) {
  const toolsDir = path.join(ROOT, '.build-tools', 'node_modules', 'resedit');
  if (!fs.existsSync(toolsDir)) {
    console.log('  （跳过：没装 resedit，图标保持 Electron 默认）');
    return;
  }
  const resedit = await import(
    require('node:url').pathToFileURL(path.join(toolsDir, 'dist', 'index.js')).href
  );
  const { NtExecutable, NtExecutableResource, Resource, Data } = resedit;

  const buf = fs.readFileSync(exePath);
  const exe = NtExecutable.from(buf, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  /* 图标：assets/icon.ico 里已经有多尺寸，交给 resedit 解析后整体替换。
   * 必须用 IconFile.from 解析 —— 它会把每帧转成 IconItem/RawIconItem，
   * 而 replaceIconsForResource 只认这两种类型，直接塞 Buffer 会报
   * 「icon.isIcon is not a function」。 */
  const icoPath = path.join(ROOT, 'assets', 'icon.ico');
  if (fs.existsSync(icoPath)) {
    const icoBuf = fs.readFileSync(icoPath);
    const ab = icoBuf.buffer.slice(icoBuf.byteOffset, icoBuf.byteOffset + icoBuf.byteLength);
    const icoFile = Data.IconFile.from(ab);
    if (icoFile.icons.length) {
      Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        1,
        1033,
        icoFile.icons.map((it) => it.data),
      );
    }
  }

  /* 版本信息：把「Electron」换成「资料库」，否则任务管理器里还叫 Electron */
  const version = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version || '1.0.0';
    } catch {
      return '1.0.0';
    }
  })();
  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const vis = Resource.VersionInfo.fromEntries(res.entries);
  if (vis.length) {
    const vi = vis[0];
    const langs = vi.getAllLanguagesForStringValues();
    const lang = langs[0] || { lang: 1033, codepage: 1200 };
    vi.setFileVersion(major, minor, patch, 0, lang.lang, lang.codepage);
    vi.setProductVersion(major, minor, patch, 0, lang.lang, lang.codepage);
    vi.setStringValues(lang, {
      ProductName: PRODUCT,
      FileDescription: PRODUCT,
      CompanyName: PRODUCT,
      InternalName: PRODUCT,
      OriginalFilename: `${PRODUCT}.exe`,
      LegalCopyright: '',
    });
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

/**
 * 解析 .ico 文件，取出每一帧的原始数据。
 * ICO 只是把若干张 PNG/BMP 拼在一起加个目录，这里只取 PNG 帧
 * （resedit 的 IconGroupEntry 需要每帧的位图数据）。
 */
function parseIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return [];
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) break;
    const w = buf[off] === 0 ? 256 : buf[off];
    const h = buf[off + 1] === 0 ? 256 : buf[off + 1];
    const bytesInRes = buf.readUInt32LE(off + 8);
    const imageOffset = buf.readUInt32LE(off + 12);
    if (imageOffset + bytesInRes > buf.length) continue;
    out.push({ width: w, height: h, data: buf.subarray(imageOffset, imageOffset + bytesInRes) });
  }
  return out;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('打包失败：', err.message);
    process.exit(1);
  });
}

module.exports = { main };
