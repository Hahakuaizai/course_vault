'use strict';

/* ============================================================
   文件夹封面 · 主进程
   ------------------------------------------------------------
   与现有数据完全隔离：
     <userData>/folder-covers.json        封面配置（version + covers）
     <userData>/folder-covers/<随机>.jpg  缩略图
   不碰 vault-data.json / vault.db，不碰用户的课程文件夹。

   目录用应用自己的稳定 id 作键（重命名、移动都不变）。
   只对外开一个 IPC 通道 cover:action，按 op 分发。
   ============================================================ */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { dialog, BrowserWindow } = require('electron');

/** 总开关：false 时所有操作都返回空数据，已保存的封面被忽略，文件保留不删 */
const ENABLE_FOLDER_COVER = true;

const COVERS_FILE = 'folder-covers.json';
const THUMB_DIR = 'folder-covers';
const DATA_VERSION = 1;

/** 源图限制 */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

/** 只认本模块自己生成的缩略图文件名，挡住路径穿越 */
const SAFE_THUMB = /^[0-9a-f]{16}\.jpg$/;

let appRef = null;
let getCoursesRef = () => [];
let covers = {};

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */
const coversPath = () => path.join(appRef.getPath('userData'), COVERS_FILE);
const thumbDir = () => path.join(appRef.getPath('userData'), THUMB_DIR);
const thumbPath = (file) => path.join(thumbDir(), file);

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */
function loadCovers() {
  covers = {};
  const p = coversPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    // 文件不存在是正常状态；其它读取错误也不阻塞启动
    if (err.code !== 'ENOENT') backupBroken(p);
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    backupBroken(p);
    return;
  }
  if (!data || typeof data !== 'object' || !data.covers || typeof data.covers !== 'object') {
    backupBroken(p);
    return;
  }

  const out = {};
  for (const [id, v] of Object.entries(data.covers)) {
    if (!id || !v || typeof v !== 'object') continue;
    if (v.type === 'color' && typeof v.colorId === 'string' && v.colorId) {
      out[id] = { type: 'color', colorId: v.colorId, updatedAt: Number(v.updatedAt) || 0 };
    } else if (v.type === 'image' && typeof v.file === 'string' && SAFE_THUMB.test(v.file)) {
      out[id] = { type: 'image', file: v.file, updatedAt: Number(v.updatedAt) || 0 };
    }
  }
  covers = out;
}

/** 损坏的配置另存为 .bak，原文件按空数据继续用 */
function backupBroken(p) {
  try {
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak`);
  } catch {
    /* 备份失败也不能让软件起不来 */
  }
}

/** 先写临时文件再改名：中途断电不会留下半截 JSON */
function writeCovers() {
  const p = coversPath();
  const tmp = `${p}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: DATA_VERSION, covers }, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function removeThumb(file) {
  if (!file || !SAFE_THUMB.test(file)) return;
  try {
    fs.unlinkSync(thumbPath(file));
  } catch {
    /* 文件可能已经被手动删掉，不影响配置更新 */
  }
}

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */
const payload = () => ({ enabled: ENABLE_FOLDER_COVER, covers });

const hasCourse = (id) => {
  if (!id || typeof id !== 'string') return false;
  try {
    return (getCoursesRef() || []).some((c) => c.id === id);
  } catch {
    return false;
  }
};

function doSetColor({ id, colorId }) {
  if (!hasCourse(id)) throw new Error('目录不存在');
  if (typeof colorId !== 'string' || !colorId) throw new Error('颜色无效');

  const prev = covers[id];
  if (colorId === 'default') {
    delete covers[id];
    if (prev?.type === 'image') removeThumb(prev.file);
  } else {
    covers[id] = { type: 'color', colorId, updatedAt: Date.now() };
    if (prev?.type === 'image') removeThumb(prev.file);
  }
  writeCovers();
  return payload();
}

/* 选图：只负责「挑一个文件 + 校验 + 把字节交回去」。
 * 缩放和转码在渲染层用 createImageBitmap / canvas 做（异步，不阻塞主进程）。 */
async function doPickImage(e, { id }) {
  if (!hasCourse(id)) throw new Error('目录不存在');

  const win = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: '选择封面图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths?.length) return { canceled: true };

  const file = res.filePaths[0];
  const ext = path.extname(file).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error('不支持这种图片格式，请选 PNG / JPG / WEBP / BMP');
  }
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error('读不到这个文件，可能已经被移动或删除了');
  }
  if (!st.isFile()) throw new Error('请选择一张图片文件');
  if (st.size > MAX_SOURCE_BYTES) {
    throw new Error(`图片有 ${(st.size / 1024 / 1024).toFixed(1)}MB，超过 30MB 上限`);
  }

  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw new Error('读不到这个文件，可能已经被移动或删除了');
  }
  return { canceled: false, name: path.basename(file), ext, data };
}

function doSaveImage({ id, data }) {
  if (!hasCourse(id)) throw new Error('目录不存在');

  const buf = toBuffer(data);
  if (!buf || !buf.length) throw new Error('图片数据为空');
  if (buf.length > 8 * 1024 * 1024) throw new Error('缩略图异常偏大，已放弃');

  const file = `${crypto.randomBytes(8).toString('hex')}.jpg`;
  fs.mkdirSync(thumbDir(), { recursive: true });
  const target = thumbPath(file);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);

  const prev = covers[id];
  covers[id] = { type: 'image', file, updatedAt: Date.now() };
  try {
    writeCovers();
  } catch (err) {
    // 配置写不进去就把刚落的文件清掉，别留孤儿
    removeThumb(file);
    if (prev) covers[id] = prev; else delete covers[id];
    throw err;
  }
  if (prev?.type === 'image' && prev.file !== file) removeThumb(prev.file);
  return payload();
}

function doRemove({ id }) {
  if (!hasCourse(id)) throw new Error('目录不存在');
  const prev = covers[id];
  if (!prev) return payload();
  delete covers[id];
  writeCovers();
  if (prev.type === 'image') removeThumb(prev.file);
  return payload();
}

/* 取缩略图字节。渲染层转成 blob: URL 显示，CSP 不用放宽。 */
function doThumb({ file }) {
  if (typeof file !== 'string' || !SAFE_THUMB.test(file)) return null;
  try {
    return { mime: 'image/jpeg', data: fs.readFileSync(thumbPath(file)) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */
function register({ ipcMain, app, getCourses }) {
  appRef = app;
  getCoursesRef = typeof getCourses === 'function' ? getCourses : () => [];
  loadCovers();

  ipcMain.handle('cover:action', async (e, msg) => {
    // 总开关关闭：一律回空数据，不读也不写任何文件
    if (!ENABLE_FOLDER_COVER) return { enabled: false, covers: {} };
    const op = msg?.op;
    switch (op) {
      case 'load': return payload();
      case 'setColor': return doSetColor(msg);
      case 'pickImage': return doPickImage(e, msg);
      case 'saveImage': return doSaveImage(msg);
      case 'remove': return doRemove(msg);
      case 'thumb': return doThumb(msg);
      default: throw new Error('未知操作');
    }
  });
}

module.exports = { register };
