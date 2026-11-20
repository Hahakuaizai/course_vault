'use strict';
/*
 * ============================================================
 * 插件一：自动更新内容（changelog）
 * ============================================================
 * 做什么：软件更新后第一次启动时，自动把「这次到底改了什么」总结成
 * 更新内容，交给界面的更新弹窗展示；弹窗只展示这一次的改动，全部
 * 历史留在「设置 → 关于 → 更新内容」里。不再需要人工写更新说明。
 *
 * 怎么判断「哪几处改动属于同一次更新」：在 userData/changelog 里
 * 维护一份安装目录的文件指纹快照。两次启动之间发生变化的全部文件
 * 视为同一次更新的一批 —— 不管它们是被软件内更新器同步进来的，
 * 还是用户解压新版压缩包手动覆盖的，都能认出来。
 *
 * 怎么总结：对每个改动的文本文件做行级对比，挑出这次新写/改写的
 * 注释。本项目的惯例是每处改动都在注释里写明目的（修复/新增/改进
 * 了什么、为什么），取这类注释的第一句作为说明条目并按关键词归类；
 * 没有可用注释的文件用兜底条目，整批都没有时给一条总览条目。
 *
 * 启动速度：register 在 whenReady 里调用，扫描随即异步启动、全程
 * 分片让行；未变的文件只比对大小和修改时间就跳过，不重读内容
 * （桌宠素材几十 MB，不该每次开机全读一遍）。界面通过 changelog:get
 * 等扫描结束才决定弹不弹窗，首屏渲染不等待本插件。
 *
 * 数据文件（userData/changelog/）：
 *   snapshot.json  上次扫描时的 {相对路径: sha1}
 *   prev/          文本文件的上一版内容（只存文本，二进制只记指纹）
 *   history.json   { pendingId, batches: [{id, date, time, ver,
 *                    items: [{type, text}], files: [{path, added,
 *                    removed}]}] }，最多保留 60 批
 * ============================================================
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/* 参与指纹比对的扩展名（与更新器的同步白名单对齐） */
const TRACK_EXT = new Set([
  '.js', '.css', '.html', '.json', '.md', '.bat', '.ico', '.png', '.svg',
  '.webp', '.webm',
]);
/* 能做内容对比的文本扩展名 */
const TEXT_EXT = new Set(['.js', '.css', '.html', '.json', '.md', '.svg', '.bat']);
/* 不参与比对的目录（与更新器一致） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'backups', '.venv', '__pycache__', 'test',
]);
/* 更新器自己的记账文件：每次更新都会变，但不是代码改动，不进快照、
 * 也不出现在「改动文件」里（与更新器的排除表一致） */
const SKIP_FILES = new Set(['version.json', 'package-lock.json', 'vault-data.json']);

const MAX_BATCHES = 60;      // 历史最多保留多少批
const MAX_ITEMS = 8;         // 一批最多展示多少条
const MAX_PER_FILE = 2;      // 单个文件最多贡献多少条
const BIG_FILE = 50 * 1024 * 1024; // 超过这个大小的文件不读内容

/* 文件 → 界面上的模块名（兜底条目用） */
const FILE_LABEL = [
  [/app\.js$/, '主界面逻辑'],
  [/styles\.css$/, '界面样式'],
  [/theme-switch/, '主题开关'],
  [/page-motion/, '页面动效'],
  [/pet/, '桌宠'],
  [/boot-loader/, '启动加载'],
  [/main\.js$/, '主进程'],
  [/preload\.js$/, '预加载'],
  [/updater\.js$/, '更新器'],
  [/db\.js$/, '数据库'],
  [/index\.html$/, '页面结构'],
];
function labelFor(rel) {
  for (const [re, label] of FILE_LABEL) if (re.test(rel)) return label;
  return path.basename(rel);
}

/* ------------------------------------------------------------------ *
 * 目的注释的识别与归类。
 * 归类只用界面已有的三种标签：fix 修复 / new 新增 / improve 改进。
 * ------------------------------------------------------------------ */
const TYPE_RULES = [
  { type: 'fix', keys: ['修复', '解决', '避免', '防止', '根源', '导致', '失效', '回滚', '脱节', '误判', '漏', '丢', '不见', '消失', '错误', '异常', '卡住', 'bug', 'BUG'] },
  { type: 'new', keys: ['新增', '添加', '加入', '支持', '实现', '引入', '增加'] },
  { type: 'improve', keys: ['优化', '改进', '提升', '降低', '统一', '重构', '删除', '移除', '去掉', '替换', '改为', '调整', '精简'] },
];
function classify(text) {
  for (const rule of TYPE_RULES) {
    for (const k of rule.keys) if (text.includes(k)) return rule.type;
  }
  return null;
}

/** 若一行是注释行，返回去掉注释标记后的正文；否则返回 null */
function commentText(rawLine) {
  let t = rawLine.trim();
  if (!t) return null;
  if (t.startsWith('//')) t = t.slice(2);
  else if (t.startsWith('/*')) t = t.slice(2);
  else if (t.startsWith('<!--')) t = t.slice(4).replace(/-->\s*$/, '');
  else if (t.startsWith('*')) t = t.slice(1);
  else return null;
  t = t.replace(/\*\/\s*$/, ''); // 注释结束符号不该混进说明文字
  t = t.replace(/^[★※·\-—\s]+/, '').trim();
  if (t.length < 6) return null;
  if (/^[\s\*=\-]+$/.test(t)) return null;   // 纯分隔线
  if (t.startsWith('@')) return null;        // JSDoc 标签不是说明
  return t;
}

/** 取第一句：以句末标点为界；太长时在逗号/冒号处收尾，去掉未闭合的括号尾巴 */
function firstClause(text) {
  let t = String(text).replace(/\s+/g, ' ').trim();
  const end = t.search(/[。；;！!？?]/);
  if (end >= 6) t = t.slice(0, end);
  const open = t.indexOf('（');
  if (open > 0 && !t.includes('）')) t = t.slice(0, open);
  if (t.length > 66) {
    const cut = Math.max(t.lastIndexOf('，', 66), t.lastIndexOf('：', 66), t.lastIndexOf('、', 66));
    t = cut >= 24 ? t.slice(0, cut) : t.slice(0, 66);
  }
  return t.trim();
}

/**
 * 行级对比（多重集口径，不求精确对齐）：新版里「旧版没有的行」即新增行。
 * 从新增行里提取目的注释，返回 { candidates, added, removed }。
 * candidates: [{ type, text, star }]
 */
function extractFromDiff(oldText, newText) {
  const bag = new Map();
  const oldLines = String(oldText || '').split('\n');
  for (const line of oldLines) {
    const t = line.trim();
    if (t) bag.set(t, (bag.get(t) || 0) + 1);
  }
  let added = 0;
  let removed = 0;
  const addedLines = [];
  for (const line of String(newText || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const n = bag.get(t) || 0;
    if (n > 0) { bag.set(t, n - 1); continue; }
    added++;
    addedLines.push(line);
  }
  for (const n of bag.values()) removed += n;

  const candidates = [];
  const seen = new Set();
  const pushCand = (type, text, star, curated) => {
    if (!type || text.length < 6) return;
    const key = text.slice(0, 14);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ type, text, star: !!star, curated: !!curated });
  };
  /* 跨行注释先攒着：上一行以顿号/逗号结尾、下一行还是注释行时，
   * 两行本是一句话，拼完整再提炼免得拆成两条、后半句还带着符号 */
  let buf = null;
  let bufStar = false;
  const flush = () => {
    if (buf == null) return;
    pushCand(classify(buf), firstClause(buf), bufStar, false);
    buf = null;
    bufStar = false;
  };
  for (const line of addedLines) {
    /* 优先采信手写说明：app.js 里 RELEASE_NOTES 新增的条目本身就是
     * 人工总结好的更新说明（{ type, text } 一行一条），比从注释里
     * 猜目的准得多，排在所有注释候选之前。没有手写条目时（比如
     * 用户自己改的代码）才靠下面的注释提取兜底 */
    const note = line.match(/type:\s*'(fix|new|improve)'[^}]*text:\s*'([^']{8,})'/);
    if (note) {
      flush();
      pushCand(note[1], firstClause(note[2]), true, true);
      continue;
    }
    const body = commentText(line);
    if (!body) { flush(); continue; }
    buf = buf == null ? body : buf + body;
    if (line.includes('★')) bufStar = true;
    if (!/[、，]$/.test(body)) flush();
  }
  flush();
  /* 手写说明条目（curated）最优先，其次带 ★ 的重点注释，其余保持出现顺序 */
  candidates.sort((a, b) => ((b.curated ? 1 : 0) - (a.curated ? 1 : 0)) || ((b.star ? 1 : 0) - (a.star ? 1 : 0)));
  return { candidates, added, removed };
}

/**
 * 把一批文件改动组装成说明条目。
 * details: [{ rel, kind: 'changed'|'added'|'deleted', binary,
 *             candidates, added, removed }]
 */
function composeItems(details) {
  const items = [];
  const usedKeys = new Set();
  const push = (type, text) => {
    const key = text.slice(0, 14);
    for (const k of usedKeys) {
      if (k.startsWith(key) || key.startsWith(k)) return false;
    }
    usedKeys.add(key);
    items.push({ type, text });
    return true;
  };
  /* 第一轮：每个文件先贡献一条最好的 */
  for (const d of details) {
    if (items.length >= MAX_ITEMS) break;
    if (d.candidates && d.candidates.length) push(d.candidates[0].type, d.candidates[0].text);
  }
  /* 第二轮：还有名额时补第二条 */
  for (const d of details) {
    if (items.length >= MAX_ITEMS) break;
    if (d.candidates && d.candidates.length > 1) push(d.candidates[1].type, d.candidates[1].text);
  }
  /* 删除的文件：明确说一声 */
  for (const d of details) {
    if (items.length >= MAX_ITEMS) break;
    if (d.kind === 'deleted') push('improve', `移除了文件 ${path.basename(d.rel)}`);
  }
  /* 二进制资源（图片/动画等）只报数量 */
  const binCount = details.filter((d) => d.binary && d.kind !== 'deleted').length;
  if (binCount && items.length < MAX_ITEMS) {
    push('improve', `更新了 ${binCount} 个资源文件（图片、动画等）`);
  }
  /* 改动较大但没有可用注释的文件：兜底一条 */
  for (const d of details) {
    if (items.length >= MAX_ITEMS) break;
    if (d.kind === 'deleted' || d.binary) continue;
    if (d.candidates && d.candidates.length) continue;
    if ((d.added || 0) + (d.removed || 0) >= 30) {
      push('improve', `更新了「${labelFor(d.rel)}」相关代码（+${d.added || 0} / −${d.removed || 0} 行）`);
    }
  }
  if (!items.length) {
    items.push({ type: 'improve', text: `本次更新调整了 ${details.length} 个文件` });
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * 扫描：指纹比对 → 生成批次 → 更新快照
 * ------------------------------------------------------------------ */
const tick = () => new Promise((r) => setImmediate(r));

async function walk(dir, base, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(full, base, out);
    } else if (e.isFile() && TRACK_EXT.has(path.extname(e.name).toLowerCase()) && !SKIP_FILES.has(e.name)) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
  await fsp.rename(tmp, file);
}

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 执行一次扫描。storeDir = userData/changelog，appDir = 安装目录。
 * 返回 { batches, pendingId }（与 history.json 同构）。
 * 首次运行只建基线快照，不生成批次（首次安装不该弹更新内容）。
 */
async function scanOnce({ storeDir, appDir, ver }) {
  const snapFile = path.join(storeDir, 'snapshot.json');
  const targetFile = path.join(storeDir, 'snapshot-target.json');
  const histFile = path.join(storeDir, 'history.json');
  const prevDir = path.join(storeDir, 'prev');
  await fsp.mkdir(prevDir, { recursive: true });

  const history = await readJson(histFile, { pendingId: null, batches: [] });
  if (!Array.isArray(history.batches)) history.batches = [];
  /* 快照记的是「上一次扫的是哪个目录」。开发模式（app.getAppPath() 指向项目根）
   * 和打包版（指向 resources/app）看到的是两棵不同的树：build.js、.build-tools/、
   * 未同步的大资源只在开发目录里有。两种模式共用一份快照，切换一次就会把对方
   * 独有的文件全判成「删除」，内容对比也会反过来（新增算成删掉）。
   * 目录对不上就当作首次运行：只重建基线，不出批次。 */
  const prevTarget = await readJson(targetFile, null);
  const sameTarget =
    typeof prevTarget === 'string' && path.resolve(prevTarget) === path.resolve(appDir);
  const oldSnap = sameTarget ? await readJson(snapFile, null) : null;
  const firstRun = !oldSnap;

  const rels = [];
  await walk(appDir, appDir, rels);
  rels.sort();

  const newSnap = {};
  const details = [];
  let n = 0;
  for (const rel of rels) {
    if (++n % 40 === 0) await tick(); // 分片让行，别占住主进程
    const full = path.join(appDir, ...rel.split('/'));
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    if (st.size > BIG_FILE) {
      newSnap[rel] = { h: `big:${st.size}`, s: st.size, m: 0 };
      continue;
    }
    /* 快速路径：大小和修改时间都和上次一样，内容必然没变，直接沿用
     * 上次的指纹，不读文件。更新器换文件必然产生新修改时间，所以
     * 真改过的文件不会被这条漏掉。老格式快照（纯指纹字符串）没有
     * 元数据，自然走读文件分支，扫完即升级成新格式 */
    const oldRaw = firstRun ? undefined : oldSnap[rel];
    const oldMeta = oldRaw && typeof oldRaw === 'object' ? oldRaw : null;
    const oldHash = oldMeta ? oldMeta.h : oldRaw;
    let buf = null;
    let hash;
    if (oldMeta && oldMeta.s === st.size && oldMeta.m === st.mtimeMs && oldMeta.h) {
      hash = oldMeta.h;
    } else {
      try { buf = await fsp.readFile(full); } catch { continue; }
      hash = sha1(buf);
    }
    newSnap[rel] = { h: hash, s: st.size, m: st.mtimeMs };
    if (firstRun) {
      if (TEXT_EXT.has(path.extname(rel).toLowerCase())) {
        const prevPath = path.join(prevDir, ...rel.split('/'));
        await fsp.mkdir(path.dirname(prevPath), { recursive: true });
        await fsp.writeFile(prevPath, buf);
      }
      continue;
    }
    if (oldHash === hash) continue;
    const isText = TEXT_EXT.has(path.extname(rel).toLowerCase());
    const d = {
      rel,
      kind: oldHash ? 'changed' : 'added',
      binary: !isText,
      candidates: [], added: 0, removed: 0,
    };
    if (isText) {
      let oldText = '';
      if (d.kind === 'changed') {
        try { oldText = await fsp.readFile(path.join(prevDir, ...rel.split('/')), 'utf8'); } catch { /* 上一版内容缺失时按全新增处理 */ }
      }
      const r = extractFromDiff(oldText, buf.toString('utf8'));
      d.candidates = r.candidates.slice(0, MAX_PER_FILE);
      d.added = r.added;
      d.removed = r.removed;
      const prevPath = path.join(prevDir, ...rel.split('/'));
      await fsp.mkdir(path.dirname(prevPath), { recursive: true });
      await fsp.writeFile(prevPath, buf);
    }
    details.push(d);
  }

  /* 快照里有、目录里没了的 = 被删除的文件 */
  if (!firstRun) {
    for (const rel of Object.keys(oldSnap)) {
      if (rel in newSnap) continue;
      details.push({ rel, kind: 'deleted', binary: !TEXT_EXT.has(path.extname(rel).toLowerCase()), candidates: [], added: 0, removed: 0 });
      try { await fsp.unlink(path.join(prevDir, ...rel.split('/'))); } catch { /* 本来就没有 */ }
    }
  }

  await writeJson(snapFile, newSnap);
  /* 和快照一起记下这次扫的目录，下次目录一变就知道基线不适用了 */
  await writeJson(targetFile, appDir);

  if (firstRun || !details.length) return history;

  const batch = {
    id: `b${Date.now().toString(36)}`,
    date: localDate(),
    time: Date.now(),
    ver: ver || '',
    items: composeItems(details),
    files: details.slice(0, 12).map((d) => ({ path: d.rel, added: d.added || 0, removed: d.removed || 0 })),
  };
  history.batches.unshift(batch);
  history.batches = history.batches.slice(0, MAX_BATCHES);
  history.pendingId = batch.id;
  await writeJson(histFile, history);
  return history;
}

/* ------------------------------------------------------------------ *
 * 注册：main.js 在 whenReady 里调一次。
 * 扫描立即异步启动（窗口还在创建，扫描全程分片让行不抢首屏），
 * changelog:get 会等它完成，界面拿到的一定是本次启动的最新结论。
 * ------------------------------------------------------------------ */
function register({ app, ipcMain, getVersion }) {
  const storeDir = path.join(app.getPath('userData'), 'changelog');
  let data = { pendingId: null, batches: [] };
  const ready = (async () => {
    try {
      /* ★ 修复自动说明里的版本号对不上：以前记的是安装包写死的版本，
       * 软件实际显示的版本是 version.json 里每次更新自动递增的那个，
       * 两边对不上。现在优先取主进程给的真实版本 */
      const ver = (getVersion && getVersion()) || app.getVersion();
      data = await scanOnce({ storeDir, appDir: app.getAppPath(), ver });
    } catch { /* 扫描失败不影响软件使用，下次启动再试 */ }
    return data;
  })();

  ipcMain.handle('changelog:get', async () => {
    const d = await ready;
    return { batches: d.batches || [], pendingId: d.pendingId || null };
  });

  ipcMain.handle('changelog:seen', async (_e, id) => {
    const d = await ready;
    if (id && d.pendingId === id) {
      d.pendingId = null;
      try { await writeJson(path.join(storeDir, 'history.json'), d); } catch { /* 忽略 */ }
    }
    return true;
  });
}

module.exports = { register, _test: { extractFromDiff, composeItems, firstClause, scanOnce } };
