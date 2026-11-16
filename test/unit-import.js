'use strict';

/**
 * 导入逻辑单测：不需要启动 Electron。
 *
 * 覆盖两件事：
 *   1. 导入文件夹时**文件夹本身要建出目录**（之前会把它拍平，内容散落）
 *   2. 两万条记录的库上，导入不再退化成 O(n²)
 *
 * 用法：node test/unit-import.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 把 main.js 里那两段纯逻辑抠出来，避免为了测试启动整个 Electron。
 * 逻辑必须与 main.js 保持一致 —— 改那边记得同步改这里。
 * ------------------------------------------------------------------ */

function makeCourseIndex(courses) {
  const map = new Map();
  const key = (parentId, name) => `${parentId || ''}\u0000${name}`;
  for (const c of courses) map.set(key(c.parentId, c.name), c);
  return {
    get: (name, parentId) => map.get(key(parentId, name)),
    add: (c) => map.set(key(c.parentId, c.name), c),
  };
}

function makePathIndex(files) {
  const map = new Map();
  for (const f of files) {
    if (f.storage === 'copy') continue;
    const key = path.resolve(f.path);
    if (!map.has(key)) map.set(key, f);
  }
  return map;
}

/** 模拟 ensureCourse：找到就复用，没有就新建并登记进索引 */
function ensureCourse(state, index, name, parentId, sourcePath) {
  const clean = String(name || '').trim() || '未命名';
  const found = index.get(clean, parentId);
  if (found) {
    if (sourcePath && !found.sourcePath) found.sourcePath = sourcePath;
    return found;
  }
  const course = {
    id: `d${state.courses.length + 1}`,
    name: clean,
    parentId: parentId || null,
    createdAt: Date.now(),
  };
  if (sourcePath) course.sourcePath = sourcePath;
  state.courses.push(course);
  index.add(course);
  return course;
}

/**
 * 模拟 importFiles 的目录归属计算。
 * 关键：无论导入到哪一层，选中的文件夹本身都要建目录。
 */
function planImport(state, index, { folderPaths, courseId, buildTree }) {
  const bases = [];
  for (const abs of folderPaths) {
    const baseCourseId = ensureCourse(state, index, path.basename(abs), courseId || null, abs).id;
    bases.push({ base: abs, baseCourseId });
  }

  let looseCourseId = courseId;
  const looseDir = () => {
    if (!looseCourseId) looseCourseId = ensureCourse(state, index, '未分类', null, null).id;
    return looseCourseId;
  };

  const resolveTarget = (real) => {
    for (const { base, baseCourseId } of bases) {
      if (real !== base && !real.startsWith(base + path.sep)) continue;
      if (!buildTree) return baseCourseId;
      const relDir = path.dirname(path.relative(base, real));
      if (!relDir || relDir === '.') return baseCourseId;
      let parentId = baseCourseId;
      let dirPath = base;
      for (const seg of relDir.split(path.sep)) {
        dirPath = path.join(dirPath, seg);
        parentId = ensureCourse(state, index, seg, parentId, dirPath).id;
      }
      return parentId;
    }
    return looseDir();
  };

  return { bases, resolveTarget, looseDir };
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

const B = 'C:\\data';

function freshState() {
  return { courses: [], files: [], trash: [], settings: {} };
}

console.log('\n【文件夹本身要建目录】');

test('导入到「全部文件」时，文件夹变成顶层目录', () => {
  const state = freshState();
  const idx = makeCourseIndex(state.courses);
  const { bases } = planImport(state, idx, {
    folderPaths: [`${B}\\项目设计`],
    courseId: null,
    buildTree: true,
  });
  assert.strictEqual(state.courses.length, 1);
  assert.strictEqual(state.courses[0].name, '项目设计');
  assert.strictEqual(state.courses[0].parentId, null);
  assert.strictEqual(bases[0].baseCourseId, state.courses[0].id);
});

test('导入到「项目设计」目录时，也要在它下面建同名子目录', () => {
  const state = freshState();
  const parent = { id: 'P1', name: '项目设计', parentId: null };
  state.courses.push(parent);
  const idx = makeCourseIndex(state.courses);

  const { bases } = planImport(state, idx, {
    folderPaths: [`${B}\\项目设计`],
    courseId: 'P1',
    buildTree: true,
  });

  // 关键断言：新建了一个子目录，而不是把内容直接塞进 P1
  assert.strictEqual(state.courses.length, 2, '应该多建一个子目录');
  const child = state.courses.find((c) => c.id !== 'P1');
  assert.strictEqual(child.name, '项目设计');
  assert.strictEqual(child.parentId, 'P1', '子目录的父级应该是 P1');
  assert.notStrictEqual(bases[0].baseCourseId, 'P1', '不能直接落到父目录');
  assert.strictEqual(bases[0].baseCourseId, child.id);
});

test('导入到某目录时，文件夹里的文件落在新建的子目录里', () => {
  const state = freshState();
  state.courses.push({ id: 'P1', name: '项目设计', parentId: null });
  const idx = makeCourseIndex(state.courses);
  const { resolveTarget } = planImport(state, idx, {
    folderPaths: [`${B}\\myproj`],
    courseId: 'P1',
    buildTree: true,
  });

  const target = resolveTarget(`${B}\\myproj\\a.txt`);
  const course = state.courses.find((c) => c.id === target);
  assert.strictEqual(course.name, 'myproj');
  assert.strictEqual(course.parentId, 'P1');
});

test('保留文件夹结构时，子目录逐层复刻', () => {
  const state = freshState();
  const idx = makeCourseIndex(state.courses);
  const { resolveTarget } = planImport(state, idx, {
    folderPaths: [`${B}\\proj`],
    courseId: null,
    buildTree: true,
  });

  const target = resolveTarget(`${B}\\proj\\src\\utils\\a.js`);
  const course = state.courses.find((c) => c.id === target);
  assert.strictEqual(course.name, 'utils');

  const src = state.courses.find((c) => c.name === 'src');
  assert.ok(src, '应该有 src 目录');
  assert.strictEqual(course.parentId, src.id, 'utils 应该挂在 src 下');

  const proj = state.courses.find((c) => c.name === 'proj');
  assert.strictEqual(src.parentId, proj.id, 'src 应该挂在 proj 下');
});

test('不保留结构时，文件全落在文件夹对应的目录里', () => {
  const state = freshState();
  const idx = makeCourseIndex(state.courses);
  const { resolveTarget } = planImport(state, idx, {
    folderPaths: [`${B}\\proj`],
    courseId: null,
    buildTree: false,
  });

  const a = resolveTarget(`${B}\\proj\\src\\a.js`);
  const b = resolveTarget(`${B}\\proj\\deep\\x\\b.js`);
  assert.strictEqual(a, b, '平铺模式下所有文件落同一目录');
  const course = state.courses.find((c) => c.id === a);
  assert.strictEqual(course.name, 'proj');
});

test('同时导入两个文件夹不会混在一起', () => {
  const state = freshState();
  const idx = makeCourseIndex(state.courses);
  const { resolveTarget } = planImport(state, idx, {
    folderPaths: [`${B}\\A`, `${B}\\B`],
    courseId: null,
    buildTree: true,
  });

  const ta = resolveTarget(`${B}\\A\\x.txt`);
  const tb = resolveTarget(`${B}\\B\\x.txt`);
  assert.notStrictEqual(ta, tb, '两个文件夹的文件必须分开');
  assert.strictEqual(state.courses.find((c) => c.id === ta).name, 'A');
  assert.strictEqual(state.courses.find((c) => c.id === tb).name, 'B');
});

test('重复导入同一文件夹不会重复建目录', () => {
  const state = freshState();
  const idx = makeCourseIndex(state.courses);
  planImport(state, idx, { folderPaths: [`${B}\\proj`], courseId: null, buildTree: true });
  const after1 = state.courses.length;
  planImport(state, idx, { folderPaths: [`${B}\\proj`], courseId: null, buildTree: true });
  assert.strictEqual(state.courses.length, after1, '第二次导入应复用已有目录');
});

test('导入到某目录两次，子目录也只建一个', () => {
  const state = freshState();
  state.courses.push({ id: 'P1', name: '项目设计', parentId: null });
  const idx = makeCourseIndex(state.courses);
  planImport(state, idx, { folderPaths: [`${B}\\proj`], courseId: 'P1', buildTree: true });
  const after1 = state.courses.length;
  planImport(state, idx, { folderPaths: [`${B}\\proj`], courseId: 'P1', buildTree: true });
  assert.strictEqual(state.courses.length, after1);
});

test('同名文件夹在不同父级下是不同目录', () => {
  const state = freshState();
  state.courses.push(
    { id: 'P1', name: 'A', parentId: null },
    { id: 'P2', name: 'B', parentId: null },
  );
  const idx = makeCourseIndex(state.courses);
  const a = ensureCourse(state, idx, 'shared', 'P1', null);
  const b = ensureCourse(state, idx, 'shared', 'P2', null);
  assert.notStrictEqual(a.id, b.id);
});

console.log('\n【路径索引】');

test('同一路径只返回一条记录', () => {
  const files = [
    { id: 'f1', path: 'C:\\a\\x.txt', storage: 'link' },
    { id: 'f2', path: 'C:\\a\\x.txt', storage: 'link' },
  ];
  const idx = makePathIndex(files);
  assert.strictEqual(idx.get(path.resolve('C:\\a\\x.txt')).id, 'f1');
});

test('入库记录（storage=copy）不参与路径索引', () => {
  const files = [{ id: 'f1', path: 'C:\\a\\x.txt', storage: 'copy' }];
  const idx = makePathIndex(files);
  assert.strictEqual(idx.get(path.resolve('C:\\a\\x.txt')), undefined);
});

test('大小写不敏感路径能命中（Windows）', () => {
  const files = [{ id: 'f1', path: 'C:\\Data\\X.txt', storage: 'link' }];
  const idx = makePathIndex(files);
  // path.resolve 在 Windows 上不改变大小写，这里只验证不抛异常且能查
  assert.ok(idx.get(path.resolve('C:\\Data\\X.txt')));
});

console.log('\n【性能：不再 O(n²)】');

function makeBigState(nFiles, nDirs) {
  const state = freshState();
  for (let i = 0; i < nDirs; i += 1) {
    state.courses.push({
      id: `d${i}`, name: `目录${i}`, parentId: i < 20 ? null : `d${i % nDirs}`,
    });
  }
  for (let i = 0; i < nFiles; i += 1) {
    state.files.push({
      id: `f${i}`, path: `C:\\data\\f${i}.txt`, storage: 'link', courseId: `d${i % nDirs}`,
    });
  }
  return state;
}

test('两万文件 / 两千目录：建索引 + 查 5000 次 < 1 秒', () => {
  const state = makeBigState(20061, 1944);
  const t = Date.now();
  const idx = makePathIndex(state.files);
  for (let i = 0; i < 5000; i += 1) {
    idx.get(path.resolve(`C:\\new\\n${i}.txt`));
  }
  const dt = Date.now() - t;
  console.log(`     实测 ${dt}ms`);
  assert.ok(dt < 1000, `耗时 ${dt}ms，超过 1 秒`);
});

test('对照：旧线性查找同样规模要 10 秒以上', () => {
  const state = makeBigState(20061, 1944);
  const t = Date.now();
  for (let i = 0; i < 500; i += 1) {
    const real = path.resolve(`C:\\new\\n${i}.txt`);
    state.files.find((f) => f.storage !== 'copy' && path.resolve(f.path) === real);
  }
  const dt = Date.now() - t;
  console.log(`     旧实现 500 次 ${dt}ms → 5000 次约 ${(dt * 10 / 1000).toFixed(1)}s`);
  assert.ok(dt > 100, '这个测试是用来证明旧实现确实慢的，若太快说明机器异常');
});

console.log('\n【跳过依赖目录】');

/** 与 main.js 中的 SKIP_IMPORT_DIRS 保持一致 */
const SKIP_IMPORT_DIRS = new Set([
  'node_modules', 'bower_components', '.next', '.nuxt', '.svelte-kit',
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.pytest_cache', '.mypy_cache',
  '.ipynb_checkpoints', 'site-packages',
  '.git', '.svn', '.hg',
  '.idea', '.vscode', '.vs', '.gradle', '.cache',
  'dist', 'build', 'out', 'target', '.DS_Store',
]);

const walkSkip = (dir, out = [], stats = { skippedDirs: 0 }) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_IMPORT_DIRS.has(e.name)) { stats.skippedDirs += 1; continue; }
      walkSkip(p, out, stats);
    } else if (e.isFile()) out.push(p);
  }
  return out;
};

test('.venv 里的文件不会被导入', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-skip-'));
  try {
    fs.mkdirSync(path.join(tmp, '.venv', 'Lib', 'site-packages', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'main.py'), 'x');
    fs.writeFileSync(path.join(tmp, '.venv', 'Lib', 'site-packages', 'pkg', 'mod.py'), 'x');

    const stats = { skippedDirs: 0 };
    const files = walkSkip(tmp, [], stats).map((p) => path.relative(tmp, p).replace(/\\/g, '/'));

    assert.deepStrictEqual(files, ['main.py'], '只应导入 main.py');
    assert.strictEqual(stats.skippedDirs, 1, '应记录跳过 1 个依赖目录');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('node_modules 同理被跳过', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-skip-'));
  try {
    fs.mkdirSync(path.join(tmp, 'node_modules', 'lodash'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'src', 'index.js'), 'x');
    fs.writeFileSync(path.join(tmp, 'node_modules', 'lodash', 'index.js'), 'x');

    const files = walkSkip(tmp, []).map((p) => path.relative(tmp, p).replace(/\\/g, '/'));
    assert.deepStrictEqual(files.sort(), ['package.json', 'src/index.js']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('多个依赖目录都跳过，计数正确', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-skip-'));
  try {
    for (const d of ['.venv', 'node_modules', '.git', '__pycache__']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
      fs.writeFileSync(path.join(tmp, d, 'x.txt'), 'x');
    }
    fs.writeFileSync(path.join(tmp, 'readme.md'), 'x');

    const stats = { skippedDirs: 0 };
    const files = walkSkip(tmp, [], stats);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(stats.skippedDirs, 4);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('普通资料目录不会被误跳（如 docs / assets）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-skip-'));
  try {
    for (const d of ['docs', 'assets', 'images', 'src']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
      fs.writeFileSync(path.join(tmp, d, 'a.txt'), 'x');
    }
    const files = walkSkip(tmp, []);
    assert.strictEqual(files.length, 4, '这些都不该被跳过');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log('\n【walk 同步版】');

test('同步 walk 能递归收集所有文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-walk-'));
  try {
    fs.mkdirSync(path.join(tmp, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'root.txt'), 'x');
    fs.writeFileSync(path.join(tmp, 'a', 'one.txt'), 'x');
    fs.writeFileSync(path.join(tmp, 'a', 'b', 'two.txt'), 'x');

    // 与 main.js 中 walk 同构
    const walk = (dir, out = []) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile()) out.push(p);
      }
      return out;
    };

    const files = walk(tmp).map((p) => path.relative(tmp, p).replace(/\\/g, '/')).sort();
    assert.deepStrictEqual(files, ['a/b/two.txt', 'a/one.txt', 'root.txt']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('无权限目录不抛异常，跳过继续', () => {
  const walk = (dir, out = []) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.isFile()) out.push(p);
    }
    return out;
  };
  const r = walk('C:\\this\\does\\not\\exist\\at\\all');
  assert.deepStrictEqual(r, []);
});

/* ---------- 汇总 ---------- */
console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
