'use strict';

/**
 * 数据库往返测试：写进去再读出来，每个字段都必须原样回来。
 *
 * 这条测试是为了锁住一个真实事故：`writeAll` 的目录 INSERT 有 7 个占位符
 * 却只传了 6 个参数，从 parent_id 开始整列错位（颜色写进 parent_id、
 * 序号写进 color）。表现是**目录树整棵挂不到根上**，侧栏「目录」空白、
 * 主区也看不到东西，看起来像数据全丢了（实际数据都在，搜索还能搜到）。
 *
 * 纯 Node 跑，不用起 Electron：`node test/unit-db-roundtrip.js`
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `vault-db-test-${process.pid}`);
const db = require('../db');

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

const CASES = [
  {
    id: 'root1',
    name: '根目录',
    parentId: null,
    color: '#c96442',
    sortOrder: 0,
    createdAt: 1794658581565,
  },
  {
    id: 'child1',
    name: '子目录',
    parentId: 'root1',
    color: '#3aa675',
    sortOrder: 1,
    createdAt: 1794658581566,
    sourcePath: 'D:/资料/子目录',
  },
  {
    id: 'grand1',
    name: '孙目录',
    parentId: 'child1',
    color: '#5b8def',
    sortOrder: 2,
    createdAt: 1794658581567,
  },
];

const FILES = [
  {
    id: 'f1',
    courseId: 'grand1',
    name: 'a.py',
    ext: 'py',
    size: 1234,
    mtime: 1794658599000,
    addedAt: 1794658600000,
    path: 'D:/资料/子目录/孙目录/a.py',
    storage: 'link',
  },
];

function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  db.open(path.join(TMP, 'vault.db'));
  check('数据库能打开', db.isOpen());
  check('新库是空的', db.isEmpty());

  db.writeAll({
    courses: CASES,
    files: FILES,
    trash: [],
    settings: { themeChoice: 'dark', autoCheckUpdate: true },
  });
  check('写入后不再为空', !db.isEmpty());

  const back = db.readAll();

  /* ---------- 目录：逐字段比对（这是那次事故的核心） ---------- */
  check('目录数一致', back.courses.length === CASES.length, back.courses.length);

  for (const want of CASES) {
    const got = back.courses.find((c) => c.id === want.id);
    if (!got) {
      check(`目录「${want.name}」读得回来`, false);
      continue;
    }
    check(`「${want.name}」parentId 未错位`, got.parentId === want.parentId,
      { got: got.parentId, want: want.parentId });
    check(`「${want.name}」color 未错位`, got.color === want.color,
      { got: got.color, want: want.color });
    check(`「${want.name}」sortOrder 未错位`, got.sortOrder === want.sortOrder,
      { got: got.sortOrder, want: want.sortOrder });
    check(`「${want.name}」createdAt 未错位`, got.createdAt === want.createdAt,
      { got: got.createdAt, want: want.createdAt });
    check(`「${want.name}」sourcePath 未错位`,
      (got.sourcePath || null) === (want.sourcePath || null),
      { got: got.sourcePath, want: want.sourcePath });
  }

  /* ---------- 树能挂起来（事故的直接表现就是挂不上） ---------- */
  const ids = new Set(back.courses.map((c) => c.id));
  const dangling = back.courses.filter((c) => c.parentId && !ids.has(c.parentId));
  check('没有指向不存在父级的目录', dangling.length === 0, dangling.length);
  check('有根目录', back.courses.some((c) => !c.parentId));

  /* ---------- 文件 ---------- */
  const f = back.files[0];
  check('文件读得回来', !!f);
  if (f) {
    check('文件归属目录正确', f.courseId === FILES[0].courseId, f.courseId);
    check('文件路径正确', f.path === FILES[0].path, f.path);
    check('文件大小正确', f.size === FILES[0].size, f.size);
  }

  /* ---------- 设置 ---------- */
  check('设置读得回来', back.settings.themeChoice === 'dark', back.settings.themeChoice);
  check('布尔设置读得回来', back.settings.autoCheckUpdate === true, back.settings.autoCheckUpdate);

  /* ---------- 第二次写入不破坏已有数据（增量同步路径） ---------- */
  db.writeAll({
    courses: CASES,
    files: FILES,
    trash: [],
    settings: { themeChoice: 'light' },
  });
  const again = db.readAll();
  check('二次写入后目录数不变', again.courses.length === CASES.length, again.courses.length);
  check('二次写入后父子关系不变',
    again.courses.find((c) => c.id === 'grand1').parentId === 'child1');
  check('二次写入后设置更新', again.settings.themeChoice === 'light', again.settings.themeChoice);

  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('致命：', err);
  try { db.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(2);
}
