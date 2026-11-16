'use strict';

/**
 * SQLite 数据层
 *
 * 设计取舍：
 *  - 内存里的 state 对象仍是权威数据源，界面代码完全不用改
 *  - 这里只负责「读出来」和「整体写回去」
 *  - 每次保存在一个事务里做增量同步（只动有变化的行），
 *    数据量到万级也是毫秒级，没必要引入更复杂的 diff 机制
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS dirs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT,
  color      TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER,
  source_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_dirs_parent ON dirs(parent_id);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  dir_id     TEXT,
  name       TEXT NOT NULL,
  ext        TEXT,
  size       INTEGER,
  mtime      INTEGER,
  added_at   INTEGER,
  path       TEXT NOT NULL,
  origin     TEXT,
  storage    TEXT DEFAULT 'link'
);
CREATE INDEX IF NOT EXISTS idx_files_dir  ON files(dir_id);
CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);

CREATE TABLE IF NOT EXISTS trash (
  id         TEXT PRIMARY KEY,
  deleted_at INTEGER,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trash_time ON trash(deleted_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let DatabaseSync = null;
let db = null;
let dbPath = null;

function open(file) {
  if (db) return db;
  // 延迟 require，避免在非 Electron 环境（如纯 node 测试）里失败时影响启动
  ({ DatabaseSync } = require('node:sqlite'));
  dbPath = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate();
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION));
  return db;
}

/**
 * 就地补列。
 *
 * CREATE TABLE IF NOT EXISTS 对已经存在的表不会加字段，老库升上来时
 * 新列是缺的。这里逐条检查再 ALTER —— SQLite 的 ALTER TABLE ADD COLUMN
 * 是常数时间、不动已有数据，比导出重建安全得多。
 */
function migrate() {
  const cols = new Set(
    db.prepare('PRAGMA table_info(dirs)').all().map((r) => r.name),
  );
  if (!cols.has('source_path')) {
    // 由磁盘文件夹导入而来的目录，记住它的真实路径：
    // 悬停要看「在电脑上的位置」，「在文件夹中显示」也要靠它。
    db.exec('ALTER TABLE dirs ADD COLUMN source_path TEXT');
  }
}

function close() {
  if (!db) return;
  try { db.close(); } catch { /* 退出阶段忽略 */ }
  db = null;
}

function isOpen() {
  return !!db;
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

function readAll() {
  if (!db) throw new Error('数据库未打开');

  const dirs = db.prepare(
    'SELECT id, name, parent_id, color, sort_order, created_at, source_path FROM dirs ORDER BY sort_order, created_at',
  ).all();

  const files = db.prepare(
    `SELECT id, dir_id, name, ext, size, mtime, added_at, path, origin, storage
     FROM files ORDER BY added_at`,
  ).all();

  const trash = db.prepare(
    'SELECT id, deleted_at, payload FROM trash ORDER BY deleted_at DESC',
  ).all();

  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }

  return {
    courses: dirs.map((d) => {
      const rec = {
        id: d.id,
        name: d.name,
        parentId: d.parent_id || null,
        color: d.color || '#5b8def',
        sortOrder: d.sort_order || 0,
        createdAt: d.created_at || 0,
      };
      // 只有从磁盘文件夹导入的目录才有真实路径，手工建的空着
      if (d.source_path) rec.sourcePath = d.source_path;
      return rec;
    }),
    files: files.map((f) => {
      const rec = {
        id: f.id,
        courseId: f.dir_id,
        name: f.name,
        ext: f.ext || '',
        size: f.size || 0,
        mtime: f.mtime || 0,
        addedAt: f.added_at || 0,
        path: f.path,
        storage: f.storage || 'link',
      };
      if (f.origin) rec.origin = f.origin;
      return rec;
    }),
    trash: trash.map((t) => {
      let payload = { files: [], courses: [] };
      try { payload = JSON.parse(t.payload); } catch { /* 损坏条目按空处理 */ }
      return {
        id: t.id,
        deletedAt: t.deleted_at,
        files: payload.files || [],
        courses: payload.courses || [],
      };
    }),
    settings,
  };
}

function isEmpty() {
  if (!db) return true;
  const d = db.prepare('SELECT count(*) c FROM dirs').get().c;
  const f = db.prepare('SELECT count(*) c FROM files').get().c;
  /* 设置和回收站也要算「有数据」：以前只数目录和文件，库里暂时没有
   * 文件时（新用户、清空了库），loadState 会把整个数据库当空的跳过，
   * 改走 JSON/默认分支 —— 设置明明已经写进库里了却读不出来，
   * seenChangelogVersion 就是这样丢的（更新公告因此反复弹/永不弹，
   * 主题等其他设置也会跟着丢）。 */
  const s = db.prepare('SELECT count(*) c FROM settings').get().c;
  const t = db.prepare('SELECT count(*) c FROM trash').get().c;
  return d === 0 && f === 0 && s === 0 && t === 0;
}

/* ------------------------------------------------------------------ *
 * 写：整体同步
 * ------------------------------------------------------------------ */

/**
 * 按 SQL 里的占位符个数校验参数，个数不对立刻抛错。
 *
 * 为什么要这层：`node:sqlite` 传的参数少于占位符时**不报错**，而是把参数
 * 整体往前对齐，从缺的那个位置开始整列错位。这种错位不会让任何一行写入
 * 失败，只会把数据默默写进错误的列 —— 本项目就因此出现过「目录树整棵
 * 消失」「目录改动重启后失效」两个事故，排查了很久才找到。
 * 宁可让保存当场失败（界面上能立刻看到报错），也不要静默写坏数据。
 */
function bindArgs(sql, params) {
  const want = (sql.match(/\?/g) || []).length;
  if (want !== params.length) {
    throw new Error(`SQL 占位符 ${want} 个，实际传了 ${params.length} 个参数（会导致字段错位）`);
  }
  return params;
}

/* 目录的 upsert 语句单独提出来：bindArgs 要靠它数占位符，
 * 语句和参数分开放，谁都不会漏看另一边的列数。 */
const DIR_UPSERT_SQL = `
  INSERT INTO dirs(id, name, parent_id, color, sort_order, created_at, source_path)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    parent_id = excluded.parent_id,
    color = excluded.color,
    sort_order = excluded.sort_order,
    source_path = excluded.source_path
`;

const FILE_UPSERT_SQL = `
  INSERT INTO files(id, dir_id, name, ext, size, mtime, added_at, path, origin, storage)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    dir_id   = excluded.dir_id,
    name     = excluded.name,
    ext      = excluded.ext,
    size     = excluded.size,
    mtime    = excluded.mtime,
    added_at = excluded.added_at,
    path     = excluded.path,
    origin   = excluded.origin,
    storage  = excluded.storage
`;

const TRASH_UPSERT_SQL = `
  INSERT INTO trash(id, deleted_at, payload) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    deleted_at = excluded.deleted_at,
    payload    = excluded.payload
`;

const SETTINGS_UPSERT_SQL = `
  INSERT INTO settings(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`;

/**
 * 把内存 state 同步进数据库。
 * 只对发生变化的部分做增删改，整个操作包在一个事务里。
 */
function writeAll(state) {
  if (!db) throw new Error('数据库未打开');

  const dirs = state.courses || [];
  const files = state.files || [];
  const trash = state.trash || [];
  const settings = state.settings || {};

  db.exec('BEGIN');
  try {
    /* --- 目录 --- */
    const existDirs = new Set(
      db.prepare('SELECT id FROM dirs').all().map((r) => r.id),
    );
    const wantDirs = new Set(dirs.map((c) => c.id));

    const delDir = db.prepare('DELETE FROM dirs WHERE id = ?');
    for (const id of existDirs) {
      if (!wantDirs.has(id)) delDir.run(id);
    }

    const upDir = db.prepare(DIR_UPSERT_SQL);
    dirs.forEach((c, i) => {
      /* ⚠️ 参数必须和上面 INSERT 的 7 列一一对应：
       *   id, name, parent_id, color, sort_order, created_at, source_path
       *
       * 这里曾经漏掉 parentId，从它开始整列错位：颜色写进 parent_id、
       * 序号写进 color、创建时间写进 sort_order。后果有两个，都很严重：
       *   1. 每个目录的「上级目录」都是一个不存在的 id，整棵树挂不到根上
       *      —— 侧栏目录空白、主区也看不到东西，像数据全丢了（但能搜到）。
       *   2. 在软件里改了目录结构（新建/移动/重命名），重启后全部失效
       *      —— 因为 parentId 根本没存进去，读回来永远是坏值。
       * 改这里时请数一遍占位符，或者跑 test/unit-db-roundtrip.js。 */
      upDir.run(...bindArgs(DIR_UPSERT_SQL, [
        c.id,
        c.name || '',
        c.parentId || null,
        c.color || null,
        c.sortOrder ?? i,
        c.createdAt || Date.now(),
        c.sourcePath || null,
      ]));
    });

    /* --- 文件 --- */
    const existFiles = new Set(
      db.prepare('SELECT id FROM files').all().map((r) => r.id),
    );
    const wantFiles = new Set(files.map((f) => f.id));

    const delFile = db.prepare('DELETE FROM files WHERE id = ?');
    for (const id of existFiles) {
      if (!wantFiles.has(id)) delFile.run(id);
    }

    const upFile = db.prepare(FILE_UPSERT_SQL);
    for (const f of files) {
      upFile.run(...bindArgs(FILE_UPSERT_SQL, [
        f.id,
        f.courseId || null,
        f.name || '',
        f.ext || '',
        f.size || 0,
        f.mtime || 0,
        f.addedAt || 0,
        /* path 缺失的老记录（JSON 时代的残缺数据）不能把整个事务拖垮：
           以前这里传 undefined，SQLite 直接抛错回滚 —— 每一次保存都
           失败，设置永远存不下来，更新公告就会每次启动都弹。
           缺 path 就存空串，界面会把它当作「原文件丢失」处理，
           正好可以走重新定位流程。 */
        f.path ?? '',
        f.origin || null,
        f.storage || 'link',
      ]));
    }

    /* --- 回收站 --- */
    const existTrash = new Set(
      db.prepare('SELECT id FROM trash').all().map((r) => r.id),
    );
    const wantTrash = new Set(trash.map((t) => t.id));

    const delTrash = db.prepare('DELETE FROM trash WHERE id = ?');
    for (const id of existTrash) {
      if (!wantTrash.has(id)) delTrash.run(id);
    }

    const upTrash = db.prepare(TRASH_UPSERT_SQL);
    for (const t of trash) {
      upTrash.run(...bindArgs(TRASH_UPSERT_SQL, [
        t.id,
        t.deletedAt || Date.now(),
        JSON.stringify({ files: t.files || [], courses: t.courses || [] }),
      ]));
    }

    /* --- 设置 --- */
    const upSet = db.prepare(SETTINGS_UPSERT_SQL);
    for (const [k, v] of Object.entries(settings)) {
      const sv = JSON.stringify(v);
      /* undefined 序列化出来还是 undefined，绑不进 SQLite，
         同样会拖垮整个事务（同上）——这种值跳过不存 */
      if (sv === undefined) continue;
      upSet.run(k, sv);
    }

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 维护
 * ------------------------------------------------------------------ */

/** 数据库体检：完整性与体积 */
function health() {
  if (!db) return { ok: false, reason: '未打开' };
  let integrity = 'unknown';
  try {
    integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  } catch { /* 忽略 */ }

  let bytes = 0;
  try { bytes = fs.statSync(dbPath).size; } catch { /* 忽略 */ }

  const counts = {
    dirs: db.prepare('SELECT count(*) c FROM dirs').get().c,
    files: db.prepare('SELECT count(*) c FROM files').get().c,
    trash: db.prepare('SELECT count(*) c FROM trash').get().c,
  };

  return { ok: integrity === 'ok', integrity, bytes, path: dbPath, counts };
}

/** 在线备份到指定文件（SQLite 官方推荐的 VACUUM INTO） */
function backupTo(target) {
  if (!db) throw new Error('数据库未打开');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

module.exports = {
  open,
  close,
  isOpen,
  isEmpty,
  readAll,
  writeAll,
  health,
  backupTo,
  get path() { return dbPath; },
};
