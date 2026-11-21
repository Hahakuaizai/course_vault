'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeTheme, screen, Menu,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn, execFileSync, execFile } = require('node:child_process');
const db = require('./db');
const { createUpdater } = require('./updater');
const folderCover = require('./src/folder-cover-main');
const petMain = require('./src/pet-main');
const changelogMain = require('./src/changelog');

const isDev = process.argv.includes('--dev');

// 窗口在后台/被遮挡时 Chromium 会节流渲染，导致画面不刷新。
// 关掉这些省电优化，后台窗口也能正常绘制（截图、动画都正常）。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

/* ------------------------------------------------------------------ *
 * 软件更新
 *
 * 两个目录：
 *   APP_DIR     —— 正在运行的程序目录（用户平时启动的那个）
 *   SOURCE_DIR  —— 开发目录（改代码的地方，放在 config 里）
 *
 * 「检查更新」比对两边代码文件的哈希；「应用更新」把开发目录里
 * 有变化的代码文件复制到程序目录，然后重启生效。
 * 只同步代码，不碰 node_modules、用户数据、备份。
 *
 * 具体逻辑在 updater.js —— 抽出去是为了能在纯 Node 里跑测试，
 * 不必为了验证一次更新就启动整个 Electron。
 * ------------------------------------------------------------------ */

/**
 * 代码文件所在的目录（更新要往这里写，必须真实可写）。
 *   - 开发态：就是项目根目录
 *   - 打包后：<安装目录>/resources/app（打包时必须关 asar，否则只读写不进）
 */
let APP_DIR = __dirname;
let SOURCE_DIR = null;

const updater = createUpdater({
  appDir: APP_DIR,
  getSourceDir: () => SOURCE_DIR,
  // 传函数：userData 要等 app ready 之后才确定
  getUserDataDir: () => app.getPath('userData'),
  isPackaged: app.isPackaged,
});

const VERSION_FILE = () => updater.versionFile();
const readVersion = () => updater.readVersion();
const writeVersion = (v) => updater.writeVersion(v);
const diffSources = () => updater.diff();
const checkForUpdate = () => updater.check();
const applyUpdate = () => updater.apply();

const updateConfigFile = () => path.join(app.getPath('userData'), 'update-config.json');

/** 读 update-config.json 的全部内容。
 * 开发目录、上次检测时间、上次自动检测结果都存在这一个文件里，
 * 读写必须合并：任何一边整体覆盖，都会把另一边的字段冲掉。 */
function loadUpdateConfig() {
  try {
    return JSON.parse(fs.readFileSync(updateConfigFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveUpdateConfig(patch) {
  const p = updateConfigFile();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...loadUpdateConfig(), ...patch }, null, 2), 'utf8');
}

/** 从 userData 的 config 里读开发目录设置 */
function loadSourceDir() {
  const cfg = loadUpdateConfig();
  if (cfg.sourceDir && fs.existsSync(cfg.sourceDir)) {
    SOURCE_DIR = cfg.sourceDir;
  }
  // 默认：如果当前运行目录的上一级有同名项目，视为开发目录
  if (!SOURCE_DIR) {
    const guess = path.join(path.dirname(APP_DIR), 'course-vault-dev');
    if (fs.existsSync(guess)) SOURCE_DIR = guess;
  }
}

function saveSourceDir(dir) {
  saveUpdateConfig({ sourceDir: dir });
  SOURCE_DIR = dir;
}

/* ------------------------------------------------------------------ *
 * 自定义协议：vault://f/<fileId>
 * 只允许访问索引中登记过的文件，避免任意路径读取。
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vault',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      /* 图片编辑器要用 fetch 把原图读成 blob（见下面协议处理里的
         Access-Control-Allow-Origin）。不开这个，renderer 里对 vault://
         的 fetch 一律 "Failed to fetch"。 */
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

/* ------------------------------------------------------------------ *
 * 数据层
 * ------------------------------------------------------------------ */
const DATA_FILE = () => path.join(app.getPath('userData'), 'vault-data.json');
const DB_FILE = () => path.join(app.getPath('userData'), 'vault.db');

/**
 * 软件改过几次名字，userData 目录也跟着变过：
 *   course-vault（最初没有 productName） → 课程库 → 资料库（现在）
 * 每次改名 Electron 都会换用新的 userData 路径，用户会以为数据全没了。
 * 这里做一次性迁移：新目录还没有数据、旧目录有时，把旧数据整个搬过来。
 */
const OLD_PRODUCT_DIRS = ['课程库', 'course-vault'];

function migrateOldUserData() {
  try {
    const newDir = app.getPath('userData');
    const newData = path.join(newDir, 'vault-data.json');
    const newDb = path.join(newDir, 'vault.db');
    // 新目录已经有数据就什么都不做
    if (fs.existsSync(newData) || fs.existsSync(newDb)) return;

    const oldDir = OLD_PRODUCT_DIRS
      .map((name) => path.join(path.dirname(newDir), name))
      .find((dir) => {
        if (path.resolve(dir) === path.resolve(newDir)) return false;
        return fs.existsSync(path.join(dir, 'vault-data.json'))
          || fs.existsSync(path.join(dir, 'vault.db'));
      });
    if (!oldDir) return;

    fs.mkdirSync(newDir, { recursive: true });
    for (const name of ['vault-data.json', 'vault.db', 'vault.db-wal', 'vault.db-shm']) {
      const from = path.join(oldDir, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(newDir, name));
    }

    // 入库副本、编辑备份也一并搬过来
    for (const sub of ['files', 'backups', 'update-backup']) {
      const from = path.join(oldDir, sub);
      const to = path.join(newDir, sub);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.cpSync(from, to, { recursive: true });
    }
  } catch {
    /* 迁移失败不阻塞启动，用户仍可手动重新导入 */
  }
}

/**
 * 「入库」模式下文件真正被复制到的地方。
 * 优先用设置里指定的目录（可放在其他盘），没设置才退回用户数据目录。
 * 卸载软件前一直有效，且不受原文件被移动/删除影响。
 */
const VAULT_FILES_DIR = () => {
  const custom = state?.settings?.storeDir;
  if (custom && typeof custom === 'string') return custom;
  return path.join(app.getPath('userData'), 'files');
};

const DEFAULT_STATE = () => ({
  version: 4,
  courses: [],
  files: [],
  /** 回收站：每次删除产生一条记录，可整条还原 */
  trash: [],
  settings: {
    theme: 'light',
    themeChoice: 'light',
    density: 'comfortable',
    showSize: true,
    restoreView: true,
    reduceMotion: false,
    autoSwitchCourse: true,
    duplicateMode: 'skip',
    /** 预览右上角「打开」按钮默认用哪个程序；Shift 点击可临时换 */
    defaultEditor: 'vscode',
    /** 默认导入方式：link=只登记路径 / copy=复制进库 */
    importMode: 'link',
    /** 入库文件存放目录；null = 用户数据目录下的 files/ */
    storeDir: null,
    /** 自动检测更新：开关 + 频率（startup / 1h / 6h / 12h / 24h / daily），见 scheduleAutoCheck */
    autoCheckUpdate: false,
    autoCheckInterval: 'startup',
  },
});

let state = null;
let saveTimer = null;

const STATE_VERSION = 4;

/** 把旧 JSON 里的数据规整到当前版本 */
function normalizeParsed(parsed) {
  const next = { ...DEFAULT_STATE(), ...parsed };
  next.settings = { ...DEFAULT_STATE().settings, ...(parsed.settings || {}) };

  // v1 → v2：早期版本会把主题写死成 dark，并带 mode/libraryRoot 等已废弃字段
  if ((parsed.version || 1) < 2) {
    next.settings.theme = 'light';
    next.files = (next.files || []).map(({ mode, originalPath, ...rest }) => rest);
  }
  // v2 → v3：新增「链接 / 入库」两种存储方式，老记录一律视为链接
  if ((parsed.version || 1) < 3) {
    next.files = (next.files || []).map((f) => ({ storage: 'link', ...f }));
  }
  // v3 → v4：课程升级成多级目录，老课程一律挂在顶层
  if ((parsed.version || 1) < 4) {
    next.courses = (next.courses || []).map((c) => ({ parentId: null, ...c }));
  }
  if (!Array.isArray(next.trash)) next.trash = [];
  next.version = STATE_VERSION;
  return next;
}

/* ------------------------------------------------------------------ *
 * 目录树自愈
 * ------------------------------------------------------------------ */
/**
 * 修复「所有目录的 parentId 都指向不存在的 id」的坏数据。
 *
 * 成因（已在 db.js 修掉，这里只负责把已经写坏的救回来）：
 * `writeAll` 的 INSERT 有 7 个占位符却只传了 6 个参数，从 parent_id 开始
 * 整列错位 —— parent_id 里存的是颜色、color 里存的是序号。回读时每个目录
 * 的父级都是一个不存在的 id，整棵树挂不到根上：侧栏「目录」空白、主区
 * 也只显示顶层文件（文件都挂在目录下），看起来像数据全丢了，但搜索还能
 * 搜到（搜索不走目录树）。
 *
 * 恢复策略，按可信度从高到低：
 *   1. 有文件的目录：用文件真实路径往上找父目录，父目录名和某个目录名
 *      对得上就认（`kvengine/src` → `src` 的父级是 `kvengine`）。
 *   2. 认不出来的（空目录、散文件目录）一律挂回顶层，保证能看见、能点。
 *   3. 颜色被写坏成 `"1.0"` 这种的，按调色板重新分配。
 * 只要发现坏数据就先备份整库，再原地修，不删任何目录和文件。
 */
const DIR_PALETTE = [
  '#5b8def', '#7b6cf6', '#c06be0', '#e86ba8', '#ef7b6b',
  '#f0a44f', '#e0c04a', '#6cc08a', '#4fb8b8', '#6b8a9e',
];

const looksLikeColor = (c) => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.trim());

function repairCourseTree() {
  const courses = state?.courses || [];
  if (courses.length < 2) return { repaired: 0 };

  const ids = new Set(courses.map((c) => c.id));
  /* 坏数据的特征：有目录声明了父级，但那个父级根本不存在。
   * 注意「父子都在库里」时哪怕挂错层也不算坏 —— 只认「指向不存在的 id」，
   * 免得把正常的深树误判成坏数据再打乱一次。 */
  const dangling = courses.filter((c) => c.parentId && !ids.has(c.parentId));
  const colorBroken = courses.filter((c) => !looksLikeColor(c.color));
  if (!dangling.length && !colorBroken.length) return { repaired: 0 };

  // 修之前先把整库备份一份，出问题还能拿回来
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(app.getPath('userData'), 'db-backup');
    fs.mkdirSync(dir, { recursive: true });
    db.backupTo(path.join(dir, `vault-${stamp}.db`));
  } catch (err) {
    console.error('[repair] 备份失败，继续修复：', err.message);
  }

  /* 第 1 步：用文件路径推断父目录。
   *
   * 做法：对每个有文件的目录，把它文件的所在目录（`dirname`）当作「这个目录
   * 在磁盘上的位置」，然后沿这个位置**逐层往上**找，第一个能对上库里某个
   * 目录名的那一层，就是它的父目录。
   *
   * 为什么要逐层往上找而不是只看上一层：目录名和磁盘目录名经常对不上
   * （「计组」的文件在 `D:\DeskBox\文档\jz`，上一层是 `文档`，再上一层是
   * `DeskBox`，都不是库里的目录），只看上一层会漏掉一大半。
   * 为什么要从「自己这层」起步：库里有两个都叫 `src` 的目录
   * （`kvengine/src`、`edu-warning/src`），从文件位置往上撞第一个同名目录
   * 会把 A 的父级认成 B 的父级。 */
  const nameToIds = new Map();
  for (const c of courses) {
    const key = String(c.name || '').trim().toLowerCase();
    if (!key) continue;
    if (!nameToIds.has(key)) nameToIds.set(key, []);
    nameToIds.get(key).push(c.id);
  }

  const parentVote = new Map(); // 子 id -> Map(候选父 id -> 票数)
  for (const f of state.files || []) {
    if (!f.courseId || !f.path) continue;
    const selfDir = path.dirname(path.resolve(f.path));
    const segs = selfDir.split(path.sep).filter(Boolean);
    const selfName = String(
      courses.find((c) => c.id === f.courseId)?.name || '',
    ).trim().toLowerCase();

    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const seg = segs[i].toLowerCase();
      if (seg === selfName) continue; // 撞到自己这层，跳过继续往上
      const cand = nameToIds.get(seg);
      if (!cand) continue;
      const pick = cand.find((id) => id !== f.courseId);
      if (!pick) continue;
      if (!parentVote.has(f.courseId)) parentVote.set(f.courseId, new Map());
      const m = parentVote.get(f.courseId);
      m.set(pick, (m.get(pick) || 0) + 1);
      break;
    }
  }

  /* 按票数挂父级。父级之间也要防环：A 认 B 当爹、B 又认 A 当爹的话，
   * 两个都会从树上消失。这里用「挂之前先试走一遍」判断，而不是看谁先处理 ——
   * 父目录在 courses 里通常排在子目录前面，按处理顺序判断会把正常的
   * 父子关系全挡掉（第一版就是这么错的，结果 28 个目录全挂到了顶层）。 */
  const parentOf = new Map(courses.map((c) => [c.id, c.parentId || null]));
  const wouldCycle = (childId, parentId) => {
    let cur = parentId;
    for (let i = 0; i < 64 && cur; i += 1) {
      if (cur === childId) return true;
      cur = parentOf.get(cur) || null;
    }
    return false;
  };

  for (const c of courses) {
    if (c.parentId && ids.has(c.parentId)) continue; // 本来就是好的
    const votes = parentVote.get(c.id);
    let best = null;
    let bestN = 0;
    if (votes) {
      for (const [pid, n] of votes) {
        if (pid === c.id) continue;
        if (n <= bestN) continue;
        if (wouldCycle(c.id, pid)) continue;
        bestN = n;
        best = pid;
      }
    }
    c.parentId = best; // 推断不出来就挂顶层，至少看得见
    parentOf.set(c.id, best);
  }

  // 断环兜底：往上走 64 层还到不了根，就当挂错了，提到顶层
  const isCyclic = (c) => {
    const seen = new Set();
    let cur = c;
    for (let i = 0; i < 64 && cur?.parentId; i += 1) {
      if (seen.has(cur.id)) return true;
      seen.add(cur.id);
      cur = courses.find((x) => x.id === cur.parentId);
    }
    return false;
  };
  for (const c of courses) {
    if (isCyclic(c)) c.parentId = null;
  }

  // 颜色被写坏（"1.0"、"1794658581565.0" 之类）：按调色板重新分配
  let colorIdx = 0;
  for (const c of courses) {
    if (looksLikeColor(c.color)) continue;
    c.color = DIR_PALETTE[colorIdx % DIR_PALETTE.length];
    colorIdx += 1;
  }

  /* sortOrder 也可能被写成时间戳（错位时那列拿到了 createdAt），
   * 这本身不影响显示（只影响排序），保持原样即可，不额外动它。 */

  saveStateNow();
  console.warn(`[repair] 目录树已修复：${dangling.length} 个目录重新挂载，${colorBroken.length} 个颜色重置`);
  return { repaired: dangling.length, colors: colorBroken.length };
}

function loadState() {
  // 1) 首选数据库
  try {
    db.open(DB_FILE());
    if (!db.isEmpty()) {
      const data = db.readAll();
      state = {
        ...DEFAULT_STATE(),
        ...data,
        settings: { ...DEFAULT_STATE().settings, ...(data.settings || {}) },
        version: STATE_VERSION,
      };
      /* 目录树可能被旧版 writeAll 的字段错位写坏了（见 repairCourseTree）。
       * 放在这里修：读完立刻纠正，后面所有界面都拿到干净的树。 */
      try {
        repairCourseTree();
      } catch (err) {
        console.error('[repair] 修复失败，按原数据继续：', err.message);
      }
      return state;
    }
  } catch (err) {
    console.error('[db] 打开失败，退回 JSON：', err.message);
  }

  // 2) 数据库为空时，看有没有旧 JSON 可迁
  try {
    const raw = fs.readFileSync(DATA_FILE(), 'utf8');
    state = normalizeParsed(JSON.parse(raw));

    // 写进数据库，成功后把旧文件改名留档（不删）
    try {
      db.writeAll(state);
      fs.renameSync(DATA_FILE(), `${DATA_FILE()}.migrated`);
      console.log('[db] 已从 JSON 迁移到 SQLite');
    } catch (err) {
      console.error('[db] 迁移失败，继续用 JSON：', err.message);
    }
    return state;
  } catch {
    state = DEFAULT_STATE();
    state.version = STATE_VERSION;
  }
  return state;
}

function saveStateNow() {
  try {
    db.writeAll(state);
  } catch (err) {
    console.error('[db] 写入失败：', err.message);
    // 兜底：至少留一份 JSON，避免数据彻底丢失
    try {
      const file = DATA_FILE();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.fallback`, JSON.stringify(state, null, 2), 'utf8');
    } catch { /* 忽略 */ }
  }
}

function saveState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveStateNow();
    } catch (err) {
      console.error('[save] failed:', err);
    }
  }, 120);
}

const uid = () => crypto.randomBytes(8).toString('hex');

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
const EXT_KIND = (() => {
  const map = new Map();
  const add = (kind, exts) => exts.forEach((e) => map.set(e, kind));
  add('image', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico']);
  add('video', ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v']);
  add('audio', ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac']);
  add('pdf', ['.pdf']);
  add('word', ['.docx', '.doc']);
  // csv / tsv 也是表格数据，跟 Excel 放一起
  add('excel', ['.xlsx', '.xls', '.csv', '.tsv']);
  add('ppt', ['.pptx', '.ppt']);
  add('markdown', ['.md', '.markdown']);
  // 纯文本单独一类：它是文档，不是代码
  add('text', ['.txt', '.log', '.rtf']);
  add('code', [
    // 脚本 / 通用
    '.py', '.pyw', '.pyi', '.r', '.rmd', '.jl', '.pl', '.pm', '.tcl', '.awk', '.vb', '.vbs',
    // C 家族
    '.c', '.h', '.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hxx', '.hh', '.inl', '.m', '.mm',
    // JVM / .NET
    '.java', '.kt', '.kts', '.scala', '.groovy', '.gradle', '.cs', '.csx', '.fs', '.fsx', '.vbproj',
    // 前端
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.vue', '.svelte',
    '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.styl',
    // 系统级
    '.go', '.rs', '.zig', '.nim', '.d', '.asm', '.s', '.v', '.sv', '.vhd', '.vhdl',
    // 数据 / 配置
    '.json', '.jsonc', '.json5', '.xml', '.xsd', '.xsl', '.plist', '.yaml', '.yml',
    '.toml', '.ini', '.cfg', '.conf', '.properties', '.env', '.gitignore', '.dockerignore',
    '.editorconfig', '.gitattributes', '.csv', '.tsv',
    // 数据库 / 脚本
    '.sql', '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.psm1',
    // 文档式源码
    '.tex', '.sty', '.cls', '.bib', '.mdx',
    // 其他
    '.php', '.rb', '.lua', '.dart', '.swift', '.ex', '.exs', '.erl', '.hrl', '.hs', '.lhs',
    '.ml', '.mli', '.clj', '.cljs', '.elm', '.cr', '.rkt', '.sol', '.proto', '.graphql', '.gql',
    'dockerfile', 'makefile', 'cmakelists.txt', '.cmake', '.mk', '.tf', '.hcl',
  ]);
  return map;
})();

function kindOf(ext) {
  return EXT_KIND.get(String(ext || '').toLowerCase()) || 'other';
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
};

const MAX_TEXT_PREVIEW = 2 * 1024 * 1024; // 2MB
// 超过这个字符数就不再自动猜语言（highlightAuto 很慢）
const MAX_AUTODETECT_CHARS = 40000;

/**
 * 按需加载 highlight.js。
 * 直接 require('highlight.js') 会把全部 193 种语言都塞进来：5.2MB、110ms、
 * 13MB 堆。而我们实际只用到下面这三十来种，加起来才 0.27MB、29ms。
 * 用 core + 逐个 registerLanguage，只在第一次预览代码时才付这个成本。
 */
const HLJS_LANGS = {
  // 主力语言：C / C++ / Python / Java / C# / Go / Rust / JS / TS …
  c: 'c', cpp: 'cpp', python: 'python', java: 'java', csharp: 'csharp',
  go: 'go', rust: 'rust', javascript: 'javascript', typescript: 'typescript',
  objectivec: 'objectivec', kotlin: 'kotlin', scala: 'scala', groovy: 'groovy',
  swift: 'swift', dart: 'dart', php: 'php', ruby: 'ruby', lua: 'lua',
  r: 'r', matlab: 'matlab', julia: 'julia', perl: 'perl', haskell: 'haskell',
  elixir: 'elixir', erlang: 'erlang', clojure: 'clojure', ocaml: 'ocaml',
  fsharp: 'fsharp', lisp: 'lisp', scheme: 'scheme', prolog: 'prolog',
  fortran: 'fortran', delphi: 'delphi', vbnet: 'vbnet', vbscript: 'vbscript',
  d: 'd', nim: 'nim', crystal: 'crystal', elm: 'elm',
  // 系统 / 汇编 / 硬件
  asm: 'x86asm', armasm: 'armasm', mipsasm: 'mipsasm', llvm: 'llvm',
  verilog: 'verilog', vhdl: 'vhdl', glsl: 'glsl', wasm: 'wasm',
  // Web / 配置 / 数据
  xml: 'xml', css: 'css', scss: 'scss', less: 'less', stylus: 'stylus',
  json: 'json', yaml: 'yaml', toml: 'ini', ini: 'ini', properties: 'properties',
  markdown: 'markdown', latex: 'latex', graphql: 'graphql', protobuf: 'protobuf',
  // Shell / 构建 / 数据库
  bash: 'bash', shell: 'shell', powershell: 'powershell', dos: 'dos',
  makefile: 'makefile', cmake: 'cmake', dockerfile: 'dockerfile',
  nginx: 'nginx', apache: 'apache', sql: 'sql', pgsql: 'pgsql',
  // 其他
  vim: 'vim', diff: 'diff', plaintext: 'plaintext',
};

let hljsInstance = null;

function getHljs() {
  if (hljsInstance) return hljsInstance;
  const hljs = require('highlight.js/lib/core');
  for (const name of Object.values(HLJS_LANGS)) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      hljs.registerLanguage(name, require(`highlight.js/lib/languages/${name}`));
    } catch { /* 某个语言包缺失不影响其它语言 */ }
  }
  hljsInstance = hljs;
  return hljs;
}

/**
 * 扩展名 → highlight.js 语言名。
 * 同名文件（Dockerfile / Makefile）没有扩展名，单独按文件名判断。
 */
const EXT_LANG = {
  // C 家族
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hpp': 'cpp', '.hxx': 'cpp', '.hh': 'cpp', '.inl': 'cpp', '.ipp': 'cpp',
  '.m': 'objectivec', '.mm': 'objectivec',
  // JVM / .NET
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.groovy': 'groovy', '.gradle': 'groovy', '.cs': 'csharp', '.csx': 'csharp',
  '.fs': 'fsharp', '.fsx': 'fsharp', '.vb': 'vbnet', '.vbs': 'vbscript',
  // 脚本
  '.py': 'python', '.pyw': 'python', '.pyi': 'python', '.r': 'r', '.rmd': 'r',
  '.jl': 'julia', '.pl': 'perl', '.pm': 'perl', '.rb': 'ruby', '.lua': 'lua',
  '.php': 'php', '.tcl': 'tcl', '.awk': 'awk', '.hs': 'haskell', '.lhs': 'haskell',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hrl': 'erlang',
  '.clj': 'clojure', '.cljs': 'clojure', '.ml': 'ocaml', '.mli': 'ocaml',
  '.elm': 'elm', '.cr': 'crystal', '.nim': 'nim', '.d': 'd', '.dart': 'dart',
  '.swift': 'swift', '.lisp': 'lisp', '.el': 'lisp', '.scm': 'scheme', '.rkt': 'scheme',
  '.pro': 'prolog', '.f90': 'fortran', '.f95': 'fortran', '.f': 'fortran',
  '.pas': 'delphi', '.sol': 'javascript',
  // 前端
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript',
  '.vue': 'xml', '.svelte': 'xml', '.html': 'xml', '.htm': 'xml', '.xhtml': 'xml',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less', '.styl': 'stylus',
  // 系统级
  '.go': 'go', '.rs': 'rust', '.zig': 'c', '.asm': 'x86asm', '.s': 'x86asm',
  '.v': 'verilog', '.sv': 'verilog', '.vhd': 'vhdl', '.vhdl': 'vhdl',
  '.glsl': 'glsl', '.vert': 'glsl', '.frag': 'glsl', '.wasm': 'wasm', '.wat': 'wasm',
  // 数据 / 配置
  '.json': 'json', '.jsonc': 'json', '.json5': 'json', '.xml': 'xml', '.xsd': 'xml',
  '.xsl': 'xml', '.plist': 'xml', '.svg': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.properties': 'properties',
  '.env': 'bash', '.gitignore': 'plaintext', '.dockerignore': 'plaintext',
  '.editorconfig': 'ini', '.gitattributes': 'plaintext',
  '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'protobuf',
  '.tf': 'ini', '.hcl': 'ini',
  // Shell / 构建 / 数据库
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
  '.bat': 'dos', '.cmd': 'dos', '.ps1': 'powershell', '.psm1': 'powershell',
  '.sql': 'sql', '.ddl': 'sql', '.pgsql': 'pgsql',
  '.mk': 'makefile', '.cmake': 'cmake', '.dockerfile': 'dockerfile',
  // 文档式源码
  '.tex': 'latex', '.sty': 'latex', '.cls': 'latex', '.bib': 'latex',
  '.md': 'markdown', '.mdx': 'markdown',
  // 其他
  '.diff': 'diff', '.patch': 'diff', '.vim': 'vim',
};

/** 文件名（无扩展名的那几个）→ 语言 */
const NAME_LANG = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'cmakelists.txt': 'cmake',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
};

/** 给一个文件记录推断高亮语言；推断不出来返回 null */
function languageFor(f) {
  const ext = String(f.ext || '').toLowerCase();
  if (EXT_LANG[ext]) return EXT_LANG[ext];
  const base = String(f.name || '').toLowerCase();
  if (NAME_LANG[base]) return NAME_LANG[base];
  return null;
}

/**
 * 文件类型 → 用什么程序运行。
 * 用户可以在设置里改默认程序，这里只给一个推荐列表。
 */
const RUNNERS = {
  python: { label: 'Python', exts: ['.py', '.pyw'], hint: 'python' },
  javascript: { label: 'Node.js', exts: ['.js', '.mjs', '.cjs'], hint: 'node' },
  typescript: { label: 'TypeScript', exts: ['.ts', '.mts', '.cts'], hint: 'ts-node' },
  shell: { label: 'Shell', exts: ['.sh', '.bash'], hint: 'bash' },
  powershell: { label: 'PowerShell', exts: ['.ps1', '.psm1'], hint: 'powershell' },
  batch: { label: '命令提示符', exts: ['.bat', '.cmd'], hint: 'cmd' },
  java: { label: 'Java', exts: ['.java'], hint: 'java' },
  csharp: { label: 'C# / .NET', exts: ['.cs', '.csx'], hint: 'dotnet' },
  go: { label: 'Go', exts: ['.go'], hint: 'go' },
  rust: { label: 'Rust', exts: ['.rs'], hint: 'cargo' },
  c: { label: 'C', exts: ['.c', '.h'], hint: 'gcc' },
  cpp: { label: 'C++', exts: ['.cpp', '.cc', '.cxx', '.c++'], hint: 'g++' },
  r: { label: 'R', exts: ['.r', '.rmd'], hint: 'Rscript' },
  ruby: { label: 'Ruby', exts: ['.rb'], hint: 'ruby' },
  php: { label: 'PHP', exts: ['.php'], hint: 'php' },
  lua: { label: 'Lua', exts: ['.lua'], hint: 'lua' },
};

/** 这个文件能不能「运行」；能的话返回运行器信息 */
function runnerFor(f) {
  const lang = languageFor(f);
  if (!lang) return null;
  const key = Object.keys(RUNNERS).find((k) => k === lang);
  return key ? { key, ...RUNNERS[key] } : null;
}

/**
 * 读剪贴板里的文件路径（仅 Windows）。
 * Electron 45 拿不到 CF_HDROP 原始数据，改用 PowerShell 的
 * Get-Clipboard -Format FileDropList，这是系统层面的标准读法。
 * 只认「文件列表」：普通文本/图片不会被当成导入。
 */
function readClipboardPaths() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  // 异步执行：PowerShell 起进程要几百毫秒，同步版会把整个界面卡住
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms;'
        + '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
        + '$f=[System.Windows.Forms.Clipboard]::GetFileDropList();'
        + 'if($f){foreach($p in $f){Write-Output $p}}',
      ],
      { encoding: 'utf8', timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) { resolve([]); return; }
        resolve(String(stdout || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((p) => p && fs.existsSync(p)));
      },
    );
  });
}

/**
 * 是不是 VS Code 系编辑器（含 Cursor / Trae / Windsurf 这些 fork）。
 * 它们共用同一套命令行开关，-r / --reuse-window 表示「复用最近的窗口」，
 * 正好对上「项目已经开着就切过去」的需求，不必再拿目录当参数。
 */
function isCodeLikeEditor(exe) {
  const base = path
    .basename(String(exe || ''))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, '');
  return /^(code|code-insiders|code-oss|codium|vscodium|cursor|trae|windsurf|zcode)/.test(base);
}

/**
 * 启动一个程序打开文件。
 *
 * 坑：Windows 上 .cmd / .bat 不是真正的可执行文件，spawn 直接跑会
 * 报 EINVAL —— VS Code 的 CLI 正好是 code.cmd，所以必须绕开：
 *   - .exe 直接 spawn
 *   - .cmd/.bat 走 cmd /c，并且 shell:false（避免路径里的空格被拆）
 *
 * 另一个坑：应用商店版程序的 exe（路径里有 WindowsApps）只是一层转发，
 * 直接 spawn 起不来也拿不到错误。这类改成 cmd /c start 交给 Shell 启动。
 */
function launchFile(exe, targets) {
  const ext = path.extname(exe).toLowerCase();
  const isStoreAlias = /\\WindowsApps\\/i.test(exe);
  const args = Array.isArray(targets) ? targets.slice() : [targets];
  const filePath = args[args.length - 1] || '';

  /* cwd 必须是真实存在的目录，否则 spawn 直接 ENOENT。
     以前这个错误只进了 console，界面上照旧弹「已用 X 打开」，
     用户看到的就是「点了没反应」。这里兜底到家目录。
     传进来的本身就是目录（「打开整个项目」）时，就用它当 cwd ——
     编辑器/程序拿到的相对路径都会以项目根为基准，这才是想要的效果。 */
  let cwd = path.dirname(filePath);
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) cwd = filePath;
    else if (!fs.existsSync(cwd)) cwd = app.getPath('home');
  } catch {
    cwd = app.getPath('home');
  }

  /* windowsHide 只对「会弹控制台黑窗」的启动方式开。
   *
   * 以前是无条件 true，结果 GUI 程序的主窗口被一起藏掉：
   * Node 会把它翻译成 CreateProcess 的 STARTUPINFO(SW_HIDE)，
   * 而记事本 / VS Code 这类程序建主窗口时用 SW_SHOWDEFAULT，
   * 正好读到这个「隐藏」—— 进程在跑、任务管理器里看得见，
   * 屏幕上却没有窗口，界面还已经提示「已打开」。
   * 实测：直接 spawn 记事本 + windowsHide:true → MainWindowHandle=0；
   * 改成 false → 窗口正常。经 cmd.exe 启动的子进程不受影响。
   *
   * Trae 这类自己强制 ShowWindow 的程序看不出问题，所以只有一部分
   * 程序「打不开」，很容易被当成随机故障。 */
  const runViaCmd = isStoreAlias || ext === '.cmd' || ext === '.bat';
  const opts = { detached: true, stdio: 'ignore', cwd, windowsHide: runViaCmd };

  /* 返回 Promise：启动失败要能传到界面，而不是静默吞掉。
     有些目标程序既不发 spawn 也不发 error，所以留一个短超时兜底。 */
  return new Promise((resolve, reject) => {
    let child;
    try {
      if (isStoreAlias) {
        /* start 的第一个引号参数是窗口标题，必须给个空的，否则带空格的
           路径会被当成标题吞掉 */
        child = spawn('cmd.exe', ['/c', 'start', '', exe, ...args], opts);
      } else if (ext === '.cmd' || ext === '.bat') {
        child = spawn('cmd.exe', ['/c', exe, ...args], opts);
      } else {
        child = spawn(exe, args, opts);
      }
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch { /* 忽略 */ }
      fn(val);
    };
    child.on('error', (err) => {
      if (settled) {
        console.error('[run] 启动失败:', exe, err.message);
        return;
      }
      /* 直接 spawn 起不来（商店转发层、被策略拦下…）：再交给 Shell 起一次。
         start 不回报目标是否真的跑起来，所以只要它能被拉起来就算成功 ——
         这比直接告诉用户「打不开」有用得多。 */
      if (!isStoreAlias) {
        try {
          const viaStart = spawn('cmd.exe', ['/c', 'start', '', exe, ...args], opts);
          viaStart.on('spawn', () => done(resolve, viaStart.pid || 0));
          viaStart.on('error', () => done(reject, err));
          return;
        } catch { /* 落到下面的 reject */ }
      }
      done(reject, err);
    });
    child.on('spawn', () => done(resolve, child.pid || 0));
    setTimeout(() => done(resolve, child.pid || 0), 400);
  });
}

/**
 * 把「用户选定的程序」解析成可执行文件路径。
 *
 * 支持三种写法：
 *   - 预设关键字（vscode / notepad / explorer …）
 *   - 绝对路径（用户自己挑的 exe）
 *   - 裸命令名（code / notepad），走 PATH
 */
const PROGRAM_PRESETS = {
  vscode: [
    `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe`,
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
    'D:\\Microsoft VS Code\\Code.exe',
    'D:\\Program Files\\Microsoft VS Code\\Code.exe',
    'E:\\Microsoft VS Code\\Code.exe',
    'F:\\Microsoft VS Code\\Code.exe',
  ],
  cursor: [
    `${process.env.LOCALAPPDATA}\\Programs\\cursor\\Cursor.exe`,
    'C:\\Program Files\\Cursor\\Cursor.exe',
  ],
  notepad: ['C:\\Windows\\notepad.exe'],
  notepadpp: [
    'C:\\Program Files\\Notepad++\\notepad++.exe',
    'C:\\Program Files (x86)\\Notepad++\\notepad++.exe',
  ],
  sublime: [
    'C:\\Program Files\\Sublime Text\\sublime_text.exe',
    'C:\\Program Files\\Sublime Text 3\\sublime_text.exe',
  ],
  explorer: ['C:\\Windows\\explorer.exe'],
};

/** 从 PATH 里找命令，Windows 上要补 .exe/.cmd/.bat */
function findInPath(cmd) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* 下一个 */ }
    }
  }
  return null;
}

function resolveProgram(target) {
  const key = String(target || '').toLowerCase();

  // VS Code 之类装了 CLI 的，优先用 PATH 里的 code.cmd —— 它自己知道
  // 程序装在哪，比硬编码一堆安装路径靠谱（用户可能装到 D 盘）
  const CLI_ALIAS = {
    vscode: ['code', 'code-insiders'],
    cursor: ['cursor'],
    sublime: ['subl', 'sublime_text'],
    notepadpp: ['notepad++'],
  };
  if (CLI_ALIAS[key]) {
    for (const cmd of CLI_ALIAS[key]) {
      const hit = findInPath(cmd);
      if (hit) return hit;
    }
  }

  if (PROGRAM_PRESETS[key]) {
    const hit = PROGRAM_PRESETS[key].find((p) => p && fs.existsSync(p));
    return hit || null;
  }
  // 绝对路径：存在就用
  if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/')) {
    return fs.existsSync(target) ? target : null;
  }
  // 裸命令名
  return findInPath(target);
}

/**
 * 项目根目录探测。
 *
 * 场景：右键一个 .py / .js 文件「用其他软件打开」，如果直接把这个文件
 * 丢给 VS Code，它只开一个孤零零的文件 —— 同目录的兄弟模块、venv、
 * node_modules 全都不在作用域里，跑起来就报「找不到依赖库」。
 *
 * 所以先往上找「这是不是一个项目」，找到就把整个项目文件夹交给编辑器。
 * 标志物按常见生态各挑一两个最有代表性的，宁可漏判也别误判：
 * 误判会把用户随手的 .txt 也当成项目打开，那才是真的烦。
 */
const PROJECT_MARKERS = [
  // Node / 前端
  'package.json', 'tsconfig.json', 'deno.json', 'vite.config.js', 'vite.config.ts',
  // Python
  'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'environment.yml',
  // Rust / Go / Java / .NET
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'global.json',
  // 其他
  'CMakeLists.txt', 'composer.json', 'Gemfile', 'pubspec.yaml', 'mix.exs', 'Package.swift',
];

/** 用「子目录存在」当标志的：.git 这类比配置文件更硬，有它基本就是项目根 */
const PROJECT_MARKER_DIRS = ['.git', '.hg', '.svn', '.venv', 'venv', 'node_modules'];

/** 用「扩展名」当标志的：解决方案/工程文件名不固定，只能扫 */
const PROJECT_MARKER_EXT = /\.(sln|csproj|vbproj|fsproj|xcodeproj|uproject)$/i;

/** 这些目录名本身是项目的「零件」，不能当项目根，路过时要跳过继续往上找 */
const PROJECT_SKIP_DIRS = new Set([
  'node_modules', 'venv', '.venv', 'site-packages', 'dist', 'build', 'target', 'out',
]);

function isProjectDir(dir) {
  for (const m of PROJECT_MARKERS) {
    if (fs.existsSync(path.join(dir, m))) return true;
  }
  for (const m of PROJECT_MARKER_DIRS) {
    try {
      if (fs.statSync(path.join(dir, m)).isDirectory()) return true;
    } catch { /* 不存在 */ }
  }
  // 工程文件名不固定，得扫一遍目录
  try {
    if (fs.readdirSync(dir).some((n) => PROJECT_MARKER_EXT.test(n))) return true;
  } catch { /* 没权限就算了 */ }
  return false;
}

/**
 * 从文件往上找项目根。找不到返回 null。
 *
 * 只往上走 6 层：再高就是「文档」「用户目录」这个级别了，
 * 拿它们当项目根毫无意义，还会让所有文件都变成「属于某个项目」。
 */
function findProjectRoot(filePath) {
  if (!filePath) return null;
  let dir = path.dirname(path.resolve(filePath));
  for (let i = 0; i < 6; i += 1) {
    if (!dir) return null;
    const up = path.dirname(dir);
    if (up === dir) return null; // 到盘符根了
    if (!PROJECT_SKIP_DIRS.has(path.basename(dir).toLowerCase()) && isProjectDir(dir)) {
      return dir;
    }
    dir = up;
  }
  return null;
}

/**
 * 找出一个目录在磁盘上的真实位置。
 *
 * 从磁盘文件夹导入的目录记了 sourcePath，直接用。
 * 手工新建的目录没有 sourcePath，只能从它下面挂着的文件往上推 ——
 * 但这一步很容易猜错，所以定两条严格规则，宁可返回 null：
 *
 *   1. 所有文件都在同一个目录里 → 那个目录就是它（最可靠）。
 *   2. 文件散在子目录里 → 取公共前缀，但**公共前缀的名字必须和目录名
 *      对得上**。用户手工建「计组」目录、往里放 `…\计组\a.pdf` 和
 *      `…\计组\第1章\b.pdf`，公共前缀 `…\计组` 名字正好是「计组」，
 *      可信；而随手把几个散落在 E 盘各处的文件塞进「杂项」，公共前缀
 *      可能是 `E:\`，那种位置告诉用户还不如不说 ——「在电脑上显示」
 *      跳到 E 盘根目录只会让人困惑。
 */
function courseDirOf(course) {
  if (!course) return null;
  if (course.sourcePath && fs.existsSync(course.sourcePath)) return course.sourcePath;

  // 收集这棵子树的所有目录 id
  const ids = new Set([course.id]);
  const stack = [course.id];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of state.courses) {
      if (c.parentId === cur && !ids.has(c.id)) {
        ids.add(c.id);
        stack.push(c.id);
      }
    }
  }

  const dirs = [];
  for (const f of state.files) {
    if (!ids.has(f.courseId) || !f.path) continue;
    dirs.push(path.dirname(path.resolve(f.path)));
  }
  if (!dirs.length) return null;

  const lower = (s) => s.toLowerCase();
  const first = dirs[0];

  // 猜出来的位置必须和目录名对得上 —— 这条对两种规则都适用。
  // 用户把几个散文件塞进「杂项」，公共目录可能是 E:\ 或某个下载目录，
  // 那种位置「在电脑上显示」跳过去只会让人困惑。
  const courseName = String(course.name || '').trim().toLowerCase();
  const nameOk = (dir) => !!courseName && path.basename(dir).toLowerCase() === courseName;

  // 规则 1：所有文件都在同一个目录里
  if (dirs.every((d) => lower(d) === lower(first))) {
    return nameOk(first) && fs.existsSync(first) ? first : null;
  }

  // 规则 2：取公共前缀
  // Windows 路径不区分大小写，逐段比对时统一转小写
  let common = first.split(path.sep);
  for (const d of dirs.slice(1)) {
    const parts = d.split(path.sep);
    let i = 0;
    while (i < common.length && i < parts.length
      && lower(common[i]) === lower(parts[i])) i += 1;
    common = common.slice(0, i);
  }
  // 只剩盘符（比如 E:）说明这些文件跨盘，猜不出有意义的位置
  if (common.length <= 1) return null;
  const guess = common.join(path.sep);
  if (!nameOk(guess)) return null;
  return fs.existsSync(guess) ? guess : null;
}

function findFile(id) {
  return state.files.find((f) => f.id === id) || null;
}

/**
 * 文件存在性/大小的短时效缓存。
 * 每次操作都会 snapshot() 一遍全库，如果每次都 statSync 所有文件，
 * 文件一多（几百上千）光是同步磁盘 IO 就能把主进程卡住。
 * 这里缓存 2 秒：同一批操作里只真正碰一次磁盘，同时又足够新，
 * 外部程序改过文件后卡片上的大小/时间很快会跟上。
 */
const STAT_TTL = 2000;
const statCache = new Map(); // path -> { at, exists, size, mtime }
/* 启动宽限期：这段时间内没缓存过的文件不 stat，调用方用记录里的值。
   大库启动时能省掉成千上万次同步 statSync。 */
let statGraceUntil = 0;

function statOf(p, force) {
  const now = Date.now();
  const hit = statCache.get(p);
  if (hit && now - hit.at < STAT_TTL) return hit;
  /* 宽限期内还没缓存过的，先不碰磁盘；调用方会退回记录里的值。
     force=true 是后台预热自己用的，不受宽限期限制。 */
  if (!force && statGraceUntil && now < statGraceUntil) return null;

  let rec;
  try {
    const st = fs.statSync(p);
    rec = { at: now, exists: st.isFile(), size: st.size, mtime: st.mtimeMs };
  } catch {
    rec = { at: now, exists: false, size: 0, mtime: 0 };
  }
  statCache.set(p, rec);
  return rec;
}

/**
 * 宽限期内把全库 stat 一遍，分片塞进缓存。
 *
 * 为什么需要它：宽限期只是「暂时不 stat」，如果不管，宽限期一到，
 * 第一次点任何东西都会在同一个同步调用里 stat 完整个库 —— 大库上
 * 还是一两百毫秒的卡顿，只是从启动时挪到了第一次操作时。
 *
 * 这里趁着界面已经画出来、用户还在看首屏的空档，按每片 8ms 的预算
 * 分批做完。预热期间宽限期一直顺延，保证中途不会有别的请求插进来
 * 做全量 stat。预热完成后缓存是新鲜的，第一次操作直接命中。
 */
function warmStatCache() {
  const paths = state.files.map((f) => f.path);
  let i = 0;
  const pump = () => {
    const start = Date.now();
    while (i < paths.length && Date.now() - start < 8) statOf(paths[i++], true);
    if (i < paths.length) {
      /* 还没做完：让宽限期继续兜着，下一片排到下一个事件循环 */
      statGraceUntil = Date.now() + 3000;
      setTimeout(pump, 16);
    } else {
      statGraceUntil = 0;
    }
  };
  pump();
}

/** 记录发生变化后（导入、移动、删除…）让缓存失效 */
function invalidateStat(p) {
  if (p) statCache.delete(p);
  else statCache.clear();
}

function publicFile(f) {
  /* 启动宽限期内 statOf 返回 null：先按记录里的信息显示 */
  const st = statOf(f.path) || { exists: true, size: f.size || 0, mtime: f.mtime || 0 };
  const exists = st.exists;
  // 文件存在时用磁盘上的真实大小/时间，否则退回记录里的旧值
  const size = exists ? st.size : f.size;
  const mtime = exists ? st.mtime : f.mtime;
  return {
    id: f.id,
    courseId: f.courseId,
    name: f.name,
    ext: f.ext,
    kind: kindOf(f.ext),
    size,
    mtime,
    addedAt: f.addedAt,
    path: f.path,
    exists,
    storage: f.storage || 'link',
    origin: f.origin || null,
    url: exists ? `vault://f/${f.id}` : null,
  };
}

function snapshot() {
  // 每层目录的直属文件数 / 直属字节数 + 含子孙的总数
  const direct = new Map();
  const directBytes = new Map();
  for (const f of state.files) {
    direct.set(f.courseId, (direct.get(f.courseId) || 0) + 1);
    /* 只统计磁盘上真实存在的文件。
     * 文件在别处被改过 → 用真实大小，不用记录里的旧值；
     * 文件已丢失 → 按 0 算，不能拿旧记录充数 —— 否则一个内容全没了的
     * 文件夹还会显示「340 MB」，比不显示更误导。 */
    const st = statOf(f.path) || { exists: true, size: f.size || 0 };
    const size = st.exists ? st.size : 0;
    directBytes.set(f.courseId, (directBytes.get(f.courseId) || 0) + size);
  }
  const childrenOf = new Map();
  for (const c of state.courses) {
    const p = c.parentId || null;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(c.id);
  }
  // 自底向上累加一次就够，不要每个目录都重算整棵子树（那是 O(n²)）
  // 文件数和字节数用同一套递归，顺手一起算出来。
  const total = new Map();
  const totalBytes = new Map();
  const calc = (id) => {
    if (total.has(id)) return total.get(id);
    let n = direct.get(id) || 0;
    let b = directBytes.get(id) || 0;
    for (const kid of childrenOf.get(id) || []) {
      n += calc(kid);
      b += totalBytes.get(kid) || 0;
    }
    total.set(id, n);
    totalBytes.set(id, b);
    return n;
  };

  const courses = state.courses.map((c) => ({
    ...c,
    parentId: c.parentId || null,
    fileCount: direct.get(c.id) || 0,
    totalCount: calc(c.id),
    // 整棵子树的总字节数，卡片上显示「文件夹 · 12 项 · 340.2 MB」
    totalSize: totalBytes.get(c.id) || 0,
    childCount: (childrenOf.get(c.id) || []).length,
  }));
  return {
    courses,
    files: state.files.map(publicFile),
    settings: state.settings,
    /* 当前程序版本。前端靠它判断「是不是刚更新过」，
     * 更新后版本号会自增，和上次看过的不同就弹更新公告。 */
    version: readVersion(),
    trash: (state.trash || []).map((t) => ({
      id: t.id,
      deletedAt: t.deletedAt,
      files: t.files.map((f) => ({
        id: f.id,
        name: f.name,
        ext: f.ext,
        kind: kindOf(f.ext),
        size: f.size,
        storage: f.storage || 'link',
        courseId: f.courseId,
        originalPath: f.originalPath || f.path,
      })),
      courses: t.courses.map((c) => ({ id: c.id, name: c.name, color: c.color, parentId: c.parentId || null })),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */
/**
 * 导入时要跳过的目录名。
 *
 * 这些是第三方依赖和构建产物，不是用户要管理的「资料」。
 * 典型场景：导入一个 Python 项目，.venv 里有两万个包文件，
 * 真正的项目文件只有几十个 —— 全登记进去既慢又让库里全是噪音。
 *
 * 只按目录名精确匹配，不做模糊判断：用户如果真有个叫 build 的资料
 * 文件夹，也不会被误伤（build 不在这里）。
 */
const SKIP_IMPORT_DIRS = new Set([
  // JS / 前端
  'node_modules', 'bower_components', '.next', '.nuxt', '.svelte-kit',
  // Python
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.pytest_cache', '.mypy_cache',
  '.ipynb_checkpoints', 'site-packages',
  // 版本控制
  '.git', '.svn', '.hg',
  // 编辑器 / 工具
  '.idea', '.vscode', '.vs', '.gradle', '.cache',
  // 其他构建产物
  'dist', 'build', 'out', 'target', '.DS_Store',
]);

/**
 * 递归列出目录下的所有文件。
 *
 * 用同步版：这里的每次 readdir 都在等操作系统回数据，await 一层层串起来
 * 纯属额外开销，实测比同步版慢 40%。导入是个用户主动发起、看得到进度感的
 * 一次性操作，占住主进程这几十毫秒完全值得。
 *
 * 不跟随符号链接（isDirectory 对 symlink 返回 false），避免目录环死循环。
 * stats.skipped 记录被跳过的依赖目录数，用于在导入结果里告诉用户。
 */
function walk(dir, out = [], stats = { skippedDirs: 0 }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 没权限的子目录跳过，不中断整批导入
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_IMPORT_DIRS.has(e.name)) {
        stats.skippedDirs += 1;
        continue;
      }
      walk(p, out, stats);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 展开用户选中的路径，得到实际要导入的文件列表。
 * 返回 { files, skippedDirs } —— skippedDirs 是跳过的依赖目录数量。
 */
async function collectFiles(inputPaths) {
  const files = [];
  const stats = { skippedDirs: 0 };
  for (const p of inputPaths) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) {
        // 顶层就是依赖目录（用户直接选了 .venv）时不拦 ——
        // 那是他明确要导的东西，跳掉反而莫名其妙。
        files.push(...walk(p, [], stats));
      } else if (st.isFile()) {
        files.push(p);
      }
    } catch {
      /* 跳过不可访问项 */
    }
  }
  return { files, skippedDirs: stats.skippedDirs };
}

/** 为「入库」文件生成不冲突的目标文件名 */
function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

/**
 * 导入只做链接：只登记路径，原文件一动不动。
 * 绝不移动、绝不复制、绝不删除原文件 —— 电脑上永远只有用户自己那一份。
 * （早期版本有过「入库」复制模式，现存的老记录仍按 storage='copy' 兼容处理。）
 */

/**
 * 目录索引：按「父目录 + 名字」查目录。
 *
 * 导入时要为每个子目录查一次有没有现成的。原来是 `state.courses.find(...)`
 * 线性扫全表，而目录数会随导入一起涨，整批导入就是 O(目录数²)。
 * 2000 个目录时单是查找就要 20ms，量再大就是肉眼可见的卡。
 */
function makeCourseIndex(courses) {
  const map = new Map();
  const key = (parentId, name) => `${parentId || ''}\u0000${name}`;
  for (const c of courses) map.set(key(c.parentId, c.name), c);
  return {
    get: (name, parentId) => map.get(key(parentId, name)),
    add: (c) => map.set(key(c.parentId, c.name), c),
  };
}

/**
 * 路径索引：绝对路径 → 文件记录。
 *
 * 导入时每个文件都要问「这条路径登记过没有」。原来用
 * `state.files.find(f => path.resolve(f.path) === real)`，2 万条记录时
 * 单个文件 0.7ms，导入 5000 个文件光这一项就是 24 秒 —— 用户看到的
 * 「两分钟还没好」主要来自这里。
 *
 * 保留「先出现者优先」的语义（复制模式下同一路径可能有多条记录）。
 */
function makePathIndex(files) {
  const map = new Map();
  for (const f of files) {
    if (f.storage === 'copy') continue;
    const key = path.resolve(f.path);
    if (!map.has(key)) map.set(key, f);
  }
  return map;
}

/**
 * 路径多重索引：绝对路径 → 记录数组（保持插入顺序）。
 *
 * 2026-11-21 起，同一个磁盘文件允许在多个目录里各登记一条（导入时
 * 只有「目标目录里已有同一条」才算重复，别的目录里有不算 —— 见
 * importFiles 里 existing 的判定）。makePathIndex 一条路径只留一条
 * 记录，表达不了这种关系，所以导入预检和导入本体改用这个多重版；
 * 只问「登记过没有」的老调用方继续用 makePathIndex。
 * 口径和 makePathIndex 一致：入库副本（storage='copy'）不参与。
 */
function makePathMultiIndex(files) {
  const map = new Map();
  for (const f of files) {
    if (f.storage === 'copy') continue;
    const key = path.resolve(f.path);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return map;
}

/** 在指定父级下按名字找目录，没有就建一个（导入文件夹时用来复刻层级） */
function ensureCourse(name, parentId, sourcePath, index) {
  const clean = String(name || '').trim() || '未命名';
  const found = index
    ? index.get(clean, parentId)
    : state.courses.find(
      (c) => (c.parentId || null) === (parentId || null) && c.name === clean,
    );
  if (found) {
    // 之前没记源路径（比如手工建的目录），导入时补上
    if (sourcePath && !found.sourcePath) found.sourcePath = sourcePath;
    return found;
  }
  const course = {
    id: uid(),
    name: clean,
    color: '#5b8def',
    parentId: parentId || null,
    createdAt: Date.now(),
  };
  // 由磁盘文件夹导入而来的目录，记下它对应的真实路径，
  // 这样才能「用编辑器打开这个文件夹」
  if (sourcePath) course.sourcePath = sourcePath;
  state.courses.push(course);
  if (index) index.add(course);
  return course;
}

/**
 * 导入文件夹专用（重复处理选「允许重复」时）：不并入已有的同名
 * 目录，而是另建一个 原名（1）、原名（2）……，整棵文件夹树挂在
 * 新目录下。以前这里和 ensureCourse 一样按名字合并，用户重复导入
 * 同一个文件夹时期望得到一份并列的副本，结果文件全灌进了原目录
 * （2026-11-18 用户报的重大 bug）。
 */
function ensureFreshCourse(name, parentId, sourcePath, index) {
  const clean = String(name || '').trim() || '未命名';
  const found = index
    ? index.get(clean, parentId)
    : state.courses.find(
      (c) => (c.parentId || null) === (parentId || null) && c.name === clean,
    );
  const taken = takenNamesIn(parentId);
  // 没有同名目录、名字也没被同层文件占用：和普通导入一样建
  if (!found && !taken.has(clean)) {
    return ensureCourse(clean, parentId, sourcePath, index);
  }
  const course = {
    id: uid(),
    name: dedupeName(clean, taken, false),
    color: '#5b8def',
    parentId: parentId || null,
    createdAt: Date.now(),
  };
  if (sourcePath) course.sourcePath = sourcePath;
  state.courses.push(course);
  if (index) index.add(course);
  return course;
}

/**
 * 某个目录内已占用的名字集合：它的子目录名 + 它名下的文件名。
 * 文件和文件夹在网格里同处一层展示，命名共用一个命名空间——
 * 新建/添加时要对两者一起避让（2026-11-18 用户定版）。
 * dirId 为 null 表示最外层。
 */
function takenNamesIn(dirId) {
  const taken = new Set();
  for (const c of state.courses) {
    if ((c.parentId || null) === (dirId || null)) taken.add(c.name);
  }
  for (const f of state.files) {
    if ((f.courseId || null) === (dirId || null)) taken.add(f.name);
  }
  return taken;
}

/**
 * 名字被占用时生成「原名（1）」「原名（2）」……第一个空缺序号。
 * 文件名把序号插在扩展名之前：报告.pdf → 报告（1）.pdf。
 * 生成后把新名字加回 taken 集合，同一批次连续调用不会互相撞名。
 */
function dedupeName(name, taken, isFile) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  let base = name;
  let ext = '';
  if (isFile) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      base = name.slice(0, dot);
      ext = name.slice(dot);
    }
  }
  for (let n = 1; ; n += 1) {
    const cand = `${base}（${n}）${ext}`;
    if (!taken.has(cand)) {
      taken.add(cand);
      return cand;
    }
  }
}

/**
 * 写时复制（2026-11-18 用户定的方案）：一条链接记录要改磁盘文件
 * 的内容之前，先看有没有别的记录指着同一个磁盘文件（比对口径
 * 和 makePathIndex 一致：入库副本记录不算）。有，就把文件在同
 * 目录复制一份「名称（1）.ext」，只让当前记录改指向副本，之后
 * 的写入落在副本上 —— 别的记录继续指着原件，编辑互不影响。
 * 没被共享就什么都不做。返回 true 表示这次分叉了。
 */
async function forkIfShared(f) {
  if (!f || f.storage === 'copy' || !f.path) return false;
  const self = path.resolve(f.path);
  const shared = state.files.some(
    (x) => x.id !== f.id && x.storage !== 'copy' && x.path
      && path.resolve(x.path) === self,
  );
  if (!shared) return false;
  const dir = path.dirname(self);
  const base = path.basename(self);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let n = 1;
  let candidate = path.join(dir, `${stem}（${n}）${ext}`);
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${stem}（${n}）${ext}`);
  }
  await fsp.copyFile(self, candidate);
  f.path = candidate;
  // 显示名一直和磁盘名一致时跟着换；用户自己改过的显示名
  // （导入时改名）不动。
  if (f.name === base) f.name = path.basename(candidate);
  return true;
}

/**
 * 磁盘文件夹的「内容签名」：相对路径 → 文件大小。
 *
 * 用来判断「同名文件夹到底是不是同一份内容」。只比相对路径和大小，
 * 不算哈希：导入时每个撞名的文件夹都全量算哈希太慢，而路径+大小
 * 已经足够区分「同一批文件」和「只是恰好重名」（2026-11-21 用户要求：
 * 重名但内容不同要走改名，不能把文件灌进旧文件夹）。
 * 复用 collectFiles 收集，所以依赖目录（node_modules 之类）的跳过
 * 口径和真正导入完全一致。
 */
async function diskFolderSignature(dirAbs) {
  const { files } = await collectFiles([dirAbs]);
  const sig = new Map();
  for (const f of files) {
    let size;
    try {
      size = fs.statSync(f).size;
    } catch {
      continue; // 读不到大小的文件不进签名，下面的比对会因此判「不同」
    }
    sig.set(path.relative(dirAbs, f).split(path.sep).join('/'), size);
  }
  return sig;
}

/**
 * 库里一个目录（含全部后代目录）的内容签名，口径和 diskFolderSignature
 * 对齐：key 是相对这个目录的路径（目录名链 + 文件名，分隔符统一 '/'），
 * value 是记录里的文件大小。注意 key 用的是库里显示的文件名 —— 导入时
 * 改过名的记录会让签名对不上、被判成「内容不同」，方向是保守的：
 * 宁可多建一个「原名（1）」，也不把文件静默灌进可能不相干的目录。
 */
function courseSubtreeSignature(course) {
  // 后代目录集合（含自身）：id → 相对 course 的目录路径（自身为 ''）
  const relOf = new Map([[course.id, '']]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of state.courses) {
      if (c.parentId && relOf.has(c.parentId) && !relOf.has(c.id)) {
        const parentRel = relOf.get(c.parentId);
        relOf.set(c.id, parentRel ? `${parentRel}/${c.name}` : c.name);
        grew = true;
      }
    }
  }
  const sig = new Map();
  for (const f of state.files) {
    if (!relOf.has(f.courseId)) continue;
    const rel = relOf.get(f.courseId);
    sig.set(rel ? `${rel}/${f.name}` : f.name, f.size);
  }
  return sig;
}

/**
 * 磁盘文件夹和库里同名目录是不是同一份内容。
 * 磁盘侧读不出来就返回 false —— 拿不准一律当「内容不同」走改名，
 * 绝不静默合并（合并错了是把两个文件夹搅在一起，改名错了只是多一个
 * （1），代价完全不对等）。
 */
async function sameFolderContent(dirAbs, course) {
  let disk;
  try {
    disk = await diskFolderSignature(dirAbs);
  } catch {
    return false;
  }
  const lib = courseSubtreeSignature(course);
  if (disk.size !== lib.size) return false;
  for (const [k, v] of disk) {
    if (lib.get(k) !== v) return false;
  }
  return true;
}

/**
 * 导入一个文件夹时，它在库里的落点决策（importFiles 真正建目录、
 * scanImport 只读估算落点，共用这一套，免得两边判断漂移）：
 *   - 'new'   ：目标层级下没有同名目录，新建一个就是。
 *   - 'merge' ：已有同名目录，且就是这个磁盘文件夹本人（sourcePath 对上），
 *               或者内容签名一致 —— 并入它，文件再逐个走同目录重复判定。
 *   - 'fresh' ：已有同名目录但内容不同（或用户选了「允许重复」）——
 *               另建「原名（1）」，整棵树挂在新目录下（ensureFreshCourse）。
 * course 是找到的同名目录（'new' 时为 null）。
 */
async function planBaseFolder(dirName, parentId, abs, dup, courseIdx) {
  const found = courseIdx.get(dirName, parentId);
  if (!found) return { mode: 'new', course: null };
  if (dup === 'allow') return { mode: 'fresh', course: found };
  // 同一个磁盘文件夹重复导入：sourcePath 对得上就是本人，直接并入
  if (found.sourcePath && path.resolve(found.sourcePath) === abs) {
    return { mode: 'merge', course: found };
  }
  if (await sameFolderContent(abs, found)) return { mode: 'merge', course: found };
  return { mode: 'fresh', course: found };
}

async function importFiles({ paths, courseId, mode, dupMode, buildTree, nameOverride = null }) {
  /* 导入弹窗里改的名字（只在恰好选了一项时给）：只改库里显示的
   * 名字，磁盘上的原文件/文件夹不动，记录的路径也还是真实路径，
   * 所以路径显示、在文件夹中显示都不受影响。 */
  const cleanOverride = String(nameOverride || '').trim();
  if (cleanOverride && /[\\/:*?"<>|]/.test(cleanOverride)) {
    throw new Error('名称不能包含 \\ / : * ? " < > | 这些字符');
  }
  const useOverride = cleanOverride && (paths || []).length === 1
    ? cleanOverride
    : null;
  let singleIsDir = false;
  if (useOverride) {
    try {
      singleIsDir = (await fsp.stat(path.resolve(paths[0]))).isDirectory();
    } catch { /* 探测失败就当文件处理 */ }
  }
  // courseId 为 null 表示导入到「全部文件」这一层：
  // 选中的文件夹本身会变成顶层目录，文件则直接挂在最外层。
  if (courseId && !state.courses.some((c) => c.id === courseId)) {
    throw new Error('课程不存在');
  }

  const storage = 'link';
  const wanted = dupMode || state.settings.duplicateMode;
  const dup = ['allow', 'replace'].includes(wanted) ? wanted : 'skip';
  const { files: raw, skippedDirs } = await collectFiles(paths);
  const added = [];
  const replaced = [];
  const skipped = [];
  const failed = [];
  // 因「重名但内容不同」被另建为「原名（1）」的文件夹，导入完要告诉用户
  const renamedDirs = [];

  // 每个被选中的文件夹在库里的落点。
  //
  // 无论导入到哪一层，**选中的文件夹本身都要建出对应的目录** ——
  // 否则导入到「项目设计」时，文件夹名会被丢掉，里面的东西直接铺到
  // 「项目设计」下；同时选好几个文件夹时，它们的内容还会混在一起分不清。
  const courseIdx = makeCourseIndex(state.courses);
  const bases = [];
  for (const p of paths) {
    let isDir = false;
    try { isDir = (await fsp.stat(p)).isDirectory(); } catch { /* 忽略 */ }
    if (!isDir) continue;
    const abs = path.resolve(p);
    // 导入到某个目录里 → 在它下面建同名子目录；导入到「全部文件」→ 建顶层目录。
    // 落点由 planBaseFolder 决策，三种：
    //   merge —— 同名目录就是这个文件夹本人、或内容签名一致，并入它；
    //   fresh —— 同名但内容不同（或选了「允许重复」），另建 原名（1）
    //            （见 ensureFreshCourse），不再把文件灌进旧目录
    //            （2026-11-21 用户要求）；
    //   new   —— 没有同名目录，新建。
    // 弹窗里改了名（单选文件夹时）就用新名建目录，磁盘原名不动。
    const dirName = useOverride && singleIsDir ? useOverride : path.basename(abs);
    const plan = await planBaseFolder(dirName, courseId || null, abs, dup, courseIdx);
    const baseCourse = plan.mode === 'fresh'
      ? ensureFreshCourse(dirName, courseId || null, abs, courseIdx)
      : ensureCourse(dirName, courseId || null, abs, courseIdx);
    // 撞名被另建的要记下来，导入完在界面上说一声，不然用户找不到
    // 这批文件会以为导丢了。「允许重复」是用户自己选的，不用记。
    if (plan.mode === 'fresh' && plan.course && dup !== 'allow') {
      renamedDirs.push({ name: dirName, newName: baseCourse.name });
    }
    bases.push({ base: abs, baseCourseId: baseCourse.id });
  }

  // 直接选中的散文件没有自己的文件夹，导入到顶层时先收进「未分类」
  let looseCourseId = courseId;
  const looseDir = () => {
    if (!looseCourseId) looseCourseId = ensureCourse('未分类', null, null, courseIdx).id;
    return looseCourseId;
  };

  /** 某个源文件最终该落在哪个目录 */
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
        parentId = ensureCourse(seg, parentId, dirPath, courseIdx).id;
      }
      return parentId;
    }
    return looseDir();
  };

  // 路径 → 记录数组。导入过程中新登记的文件也要放进去，
  // 否则同一次导入里出现两次的路径会各记一条。
  // 用多重索引是因为同一路径现在可以在多个目录各有一条（见 existing）。
  const pathMulti = makePathMultiIndex(state.files);

  // 目录 → 已占用名字集合（缓存）。导入途中分配掉的名字会写回
  // 集合里，同一批次导入的同名文件依次避让成（1）（2）。
  const takenByDir = new Map();
  const takenFor = (dirId) => {
    const k = dirId || null;
    let s = takenByDir.get(k);
    if (!s) {
      s = takenNamesIn(k);
      takenByDir.set(k, s);
    }
    return s;
  };

  for (const src of raw) {
    // 弹窗里改了名（单选文件时）只换库里显示的名字；ext 仍按
    // 磁盘上的真名算，免得把扩展名改没了之后类型识别跟着错。
    const name = useOverride && !singleIsDir ? useOverride : path.basename(src);
    const ext = path.extname(path.basename(src)).toLowerCase();
    const real = path.resolve(src);

    let st;
    try {
      st = await fsp.stat(real);
    } catch {
      continue;
    }

    const targetCourseId = resolveTarget(real);

    // 「重复」只认目标目录里的那一条（只比对链接模式的记录，入库文件
    // 路径是库内副本，不参与）。其他目录里登记过同一个磁盘文件不算
    // 这里的重复 —— 照常在目标目录新建一条（2026-11-21 用户要求：
    // 导入文件夹时，里面的文件和已导入的其他目录中的文件是同一份，
    // 不该再弹窗提示重复）。
    const existing = (pathMulti.get(real) || [])
      .find((r) => (r.courseId || null) === (targetCourseId || null));

    if (existing && dup === 'skip') {
      skipped.push(name);
      continue;
    }

    // 替换：沿用原记录（id / 课程归属不变），刷新大小与时间
    if (existing && dup === 'replace') {
      existing.name = name;
      existing.ext = ext;
      existing.size = st.size;
      existing.mtime = st.mtimeMs;
      existing.addedAt = Date.now();
      replaced.push(name);
      continue;
    }

    // 与目标目录内已有项（文件或子目录）重名时改名 原名（1）（2）…
    // 同路径重复导入的 skip/replace 在上面已处理，这里只管新记录。
    const finalName = dedupeName(name, takenFor(targetCourseId), true);
    const id = uid();
    const rec = {
      id,
      courseId: targetCourseId,
      name: finalName,
      ext,
      size: st.size,
      mtime: st.mtimeMs,
      addedAt: Date.now(),
      path: real,
      storage,
    };
    state.files.push(rec);
    if (!pathMulti.has(real)) pathMulti.set(real, []);
    pathMulti.get(real).push(rec);
    added.push(rec);
  }

  saveStateNow();
  return {
    added: added.map(publicFile),
    skipped,
    replaced,
    failed,
    count: added.length,
    mode: storage,
    skippedDirs,
    renamedDirs,
  };
}

/* ------------------------------------------------------------------ *
 * 搜索：文件名 + 文件内容
 * ------------------------------------------------------------------ */
const SEARCH_TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.json', '.xml', '.yml', '.yaml',
  '.ini', '.cfg', '.conf', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.java',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.r', '.m', '.go',
  '.rs', '.rb', '.php', '.sh', '.bat', '.ps1', '.sql', '.html', '.htm',
  '.css', '.scss', '.less', '.vue', '.tex', '.srt', '.toml',
]);
const MAX_SEARCH_BYTES = 512 * 1024; // 单文件最多读 512KB 做内容匹配

/** 判断某个文件是否值得读取内容来搜索 */
function isTextSearchable(f) {
  if (!f.path || !fs.existsSync(f.path)) return false;
  if (SEARCH_TEXT_EXT.has(f.ext)) return true;
  // 无扩展名的脚本也算
  return !f.ext;
}

/** 读文件内容并截取关键词附近的片段 */
async function grepFile(f, needle) {
  try {
    const st = await fsp.stat(f.path);
    if (st.size > MAX_SEARCH_BYTES) return null;
    const text = await fsp.readFile(f.path, 'utf8');
    const lower = text.toLowerCase();
    const at = lower.indexOf(needle);
    if (at < 0) return null;

    // 取命中位置前后各一段，去掉换行，做高亮
    const start = Math.max(0, at - 40);
    const end = Math.min(text.length, at + needle.length + 60);
    let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = `…${snippet}`;
    if (end < text.length) snippet = `${snippet}…`;

    const safe = escapeForHtml(snippet);
    // 高亮所有命中（不区分大小写）
    const re = new RegExp(escapeRegExp(needle), 'gi');
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  } catch {
    return null;
  }
}

function escapeForHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 搜索文件。
 *  - scope=name：只比文件名
 *  - scope=content：文件名命中，或文件内容里包含关键词
 *  - kinds：可选类型白名单，如 ['pdf','word']
 *  - courseId：限定在某个目录（含子目录）内
 */
async function searchFiles({ query, scope, kinds, courseId, deep }) {
  const q = String(query || '').trim();
  if (!q) return { files: [], contentMode: scope === 'content' };

  const needle = q.toLowerCase();
  const wantContent = scope === 'content';

  // 目录范围
  let scopeIds = null;
  if (courseId) {
    scopeIds = new Set([courseId]);
    if (deep !== false) {
      let grew = true;
      while (grew) {
        grew = false;
        for (const c of state.courses) {
          if (c.parentId && scopeIds.has(c.parentId) && !scopeIds.has(c.id)) {
            scopeIds.add(c.id);
            grew = true;
          }
        }
      }
    }
  }

  const kindSet = kinds && kinds.length ? new Set(kinds) : null;

  const pool = state.files.filter((f) => {
    if (scopeIds && !scopeIds.has(f.courseId)) return false;
    if (kindSet && !kindSet.has(kindOf(f.ext))) return false;
    return true;
  });

  const hits = [];
  for (const f of pool) {
    const nameHit = f.name.toLowerCase().includes(needle);
    if (nameHit) {
      hits.push({ ...publicFile(f), matched: 'name', snippet: null });
      continue;
    }
    if (wantContent && isTextSearchable(f)) {
      const snippet = await grepFile(f, needle);
      if (snippet) hits.push({ ...publicFile(f), matched: 'content', snippet });
    }
  }

  return { files: hits, contentMode: wantContent, query: q };
}

/**
 * 导入前预检：把将要导入的路径和库里已有记录比对，分类成三份：
 *   - fresh：没登记过的；
 *   - duplicates：目标目录里已经有同一条 —— 只有这份要弹窗问用户；
 *   - crossDir：只在别的目录里登记过同一个磁盘文件 —— 不弹窗，
 *     导入时会在目标目录里照常新建一条（2026-11-21 用户要求）。
 *
 * 分类的前提是先只读地估算每个文件导入后会落在哪个目录：落点算法
 * 和 importFiles 保持一致（文件夹落点共用 planBaseFolder），但这里
 * 绝不建目录 —— 还没导入就把目录建出来，用户取消导入会留下一堆空壳。
 * 近似点：预检不知道导入弹窗里改的名字（nameOverride），单选文件夹
 * 改名时按原名估算；改名后的目录必然是新建的，分类结论不变，无碍。
 *
 * opts: { courseId, buildTree, dupMode } —— 渲染层把导入目标、是否
 * 保留文件夹结构、设置里的重复处理方式传进来，缺省按导入到顶层、
 * 不建树、跳过重复处理。
 */
async function scanImport(paths, opts = {}) {
  const { courseId = null, buildTree = false } = opts || {};
  // 和 importFiles 同一套归一化：只有 allow / replace 是特殊值，其余按 skip
  const dup = ['allow', 'replace'].includes(opts?.dupMode) ? opts.dupMode : 'skip';
  const { files: raw, skippedDirs } = await collectFiles(paths);
  const seen = new Set();
  const fresh = [];
  const duplicates = [];
  const crossDir = [];
  // 告诉渲染层这次选里有没有文件夹，用来决定要不要显示「保留文件夹结构」
  const dirs = [];
  for (const p of paths) {
    try {
      if ((await fsp.stat(p)).isDirectory()) dirs.push(p);
    } catch { /* 忽略不可访问项 */ }
  }

  // 预检和真正导入用的是同一套索引，别在这里又退回线性查找 ——
  // 两万条记录时 5000 个文件要扫 24 秒，用户会以为软件卡死了。
  const courseIdx = makeCourseIndex(state.courses);
  const pathMulti = makePathMultiIndex(state.files);

  // 每个被选中的文件夹的落点估算：merge 进已有目录的用它的 id；
  // 要新建（new / fresh）的目录还没有 id，用 isNew 标记 —— 新目录里
  // 不可能有旧记录，落进去的文件天然不算同目录重复。
  const bases = [];
  for (const p of paths) {
    let isDir = false;
    try { isDir = (await fsp.stat(p)).isDirectory(); } catch { /* 忽略 */ }
    if (!isDir) continue;
    const abs = path.resolve(p);
    if (bases.some((b) => b.base === abs)) continue; // 同一文件夹选了两次只算一个落点
    const plan = await planBaseFolder(path.basename(abs), courseId || null, abs, dup, courseIdx);
    bases.push({
      base: abs,
      target: plan.mode === 'merge'
        ? { id: plan.course.id, isNew: false }
        : { id: null, isNew: true },
    });
  }

  // 散文件的落点：导入到指定目录就落它；导入到顶层则收进「未分类」，
  // 「未分类」还不存在时落点就是待新建的目录。
  const looseTarget = () => {
    if (courseId) return { id: courseId, isNew: false };
    const un = courseIdx.get('未分类', null);
    return un ? { id: un.id, isNew: false } : { id: null, isNew: true };
  };

  /** 估算某个源文件导入后落在哪个目录（只查已有目录，不建） */
  const resolveTargetScan = (real) => {
    for (const { base, target } of bases) {
      if (real !== base && !real.startsWith(base + path.sep)) continue;
      if (!buildTree || target.isNew) return target;
      const relDir = path.dirname(path.relative(base, real));
      if (!relDir || relDir === '.') return target;
      // 保留文件夹结构时逐段按名字往下找已有子目录，任一段没有
      // 就说明那一层导入时会新建，下面的文件都落在新目录里
      let curId = target.id;
      for (const seg of relDir.split(path.sep)) {
        const next = courseIdx.get(seg, curId);
        if (!next) return { id: null, isNew: true };
        curId = next.id;
      }
      return { id: curId, isNew: false };
    }
    return looseTarget();
  };

  for (const src of raw) {
    const real = path.resolve(src);
    if (seen.has(real)) continue; // 本次选择里自己重复的只算一次
    seen.add(real);

    const recs = pathMulti.get(real);
    if (!recs || !recs.length) {
      fresh.push(real);
      continue;
    }
    const target = resolveTargetScan(real);
    const sameDir = !target.isNew
      && recs.some((r) => (r.courseId || null) === target.id);
    const item = { path: real, name: path.basename(real), fileId: recs[0].id };
    if (sameDir) duplicates.push(item);
    else crossDir.push(item);
  }

  return {
    total: fresh.length + duplicates.length + crossDir.length,
    fresh,
    duplicates,
    crossDir,
    dirs,
    // 跳过的依赖目录数（node_modules / .venv 之类），界面上要说一声
    skippedDirs,
  };
}

/* ------------------------------------------------------------------ *
 * 重复文件检测
 * 按内容哈希判断，不是比文件名。同大小才计算哈希，省时间。
 * ------------------------------------------------------------------ */
function hashFileSync(file, algo = 'sha256') {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    do {
      read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read > 0) h.update(buf.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * 在指定目录（含子目录）范围内找内容完全相同的文件。
 * courseId 为 null 时扫描全库。
 */
async function scanDuplicates({ courseId }) {
  let scope = null;
  if (courseId) {
    scope = new Set([courseId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of state.courses) {
        if (c.parentId && scope.has(c.parentId) && !scope.has(c.id)) {
          scope.add(c.id);
          grew = true;
        }
      }
    }
  }

  const pool = state.files.filter((f) => {
    if (scope && !scope.has(f.courseId)) return false;
    try {
      return fs.statSync(f.path).isFile();
    } catch {
      return false;
    }
  });

  // 第一轮：按大小分组，只有大小相同的才可能内容相同
  const bySize = new Map();
  for (const f of pool) {
    let size = f.size;
    try { size = fs.statSync(f.path).size; } catch { continue; }
    if (size === 0) continue; // 空文件不算重复，没有意义
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size).push({ ...f, realSize: size });
  }

  // 第二轮：同大小的算哈希
  const byHash = new Map();
  for (const [, group] of bySize) {
    if (group.length < 2) continue;
    for (const f of group) {
      let hash;
      try {
        hash = hashFileSync(f.path);
      } catch {
        continue;
      }
      const key = `${f.realSize}:${hash}`;
      if (!byHash.has(key)) byHash.set(key, []);
      byHash.get(key).push({ ...f, hash });
    }
  }

  // 只保留真正重复的组
  const groups = [];
  for (const [, list] of byHash) {
    if (list.length < 2) continue;
    // 这组文件分布在几个目录里：跨目录的重复最容易删错地方，
    // 界面上要单独标出来（2026-11-21 用户要求）。
    const dirIds = new Set(list.map((f) => f.courseId || ''));
    groups.push({
      hash: list[0].hash,
      size: list[0].realSize,
      crossDir: dirIds.size > 1,
      dirCount: dirIds.size,
      files: list.map((f) => ({
        id: f.id,
        name: f.name,
        path: f.path,
        courseId: f.courseId,
        storage: f.storage || 'link',
        addedAt: f.addedAt || 0,
        dirPath: pathOfDirNames(f.courseId),
      })),
    });
  }

  // 组内按导入时间排，最早的那份默认保留（同批导入的按文件名定序，保证结果稳定）
  for (const g of groups) {
    g.files.sort((a, b) => a.addedAt - b.addedAt || a.name.localeCompare(b.name, 'zh'));
  }
  groups.sort((a, b) => b.size - a.size);

  const waste = groups.reduce((n, g) => n + g.size * (g.files.length - 1), 0);
  return { groups, scanned: pool.length, waste };
}

/** 目录的完整路径名（用于展示「在哪个目录里」） */
function pathOfDirNames(id) {
  const out = [];
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = state.courses.find((c) => c.id === cur);
    if (!node) break;
    out.unshift(node.name);
    cur = node.parentId || null;
  }
  return out.join(' / ') || '未分类';
}

/* ------------------------------------------------------------------ *
 * 回收站
 * 只保存「记录」而不是原文件：
 *  - 链接模式：原文件一直在磁盘上，还原只是把记录放回去
 *  - 入库模式：副本本来就在库目录里，移进 trash/ 子目录，还原时移回来
 * ------------------------------------------------------------------ */
const TRASH_DIR = () => path.join(VAULT_FILES_DIR(), '.trash');

/** 把一批文件和目录移进回收站 */
async function moveToTrash({ fileIds, courseIds }) {
  const now = Date.now();
  const files = (fileIds || [])
    .map((id) => findFile(id))
    .filter(Boolean);
  const courses = (courseIds || [])
    .map((id) => state.courses.find((c) => c.id === id))
    .filter(Boolean);

  if (!files.length && !courses.length) return { count: 0 };

  // 入库副本挪进 .trash，避免和「仍在库里」的文件混在一起
  const root = path.resolve(VAULT_FILES_DIR());
  const trash = path.resolve(TRASH_DIR());
  const movedCopies = [];

  for (const f of files) {
    if (f.storage !== 'copy') continue;
    const src = path.resolve(f.path);
    if (!src.startsWith(root + path.sep)) continue;
    try {
      await fsp.mkdir(trash, { recursive: true });
      const dest = uniqueTarget(trash, path.basename(src));
      await fsp.rename(src, dest);
      movedCopies.push({ rec: f, from: src, to: dest });
    } catch {
      /* 移动失败就当链接处理，还原时仍指向原路径 */
    }
  }

  const entry = {
    id: uid(),
    deletedAt: now,
    files: files.map((f) => {
      const moved = movedCopies.find((m) => m.rec.id === f.id);
      return {
        ...f,
        path: moved ? moved.to : f.path,
        trashedPath: moved ? moved.to : null,
        originalPath: moved ? moved.from : f.path,
      };
    }),
    courses: courses.map((c) => ({ ...c })),
  };

  state.trash.unshift(entry);

  const doomedFileIds = new Set(files.map((f) => f.id));
  const doomedCourseIds = new Set(courses.map((c) => c.id));
  state.files = state.files.filter((f) => !doomedFileIds.has(f.id));
  state.courses = state.courses.filter((c) => !doomedCourseIds.has(c.id));

  saveStateNow();
  return { count: files.length + courses.length, entryId: entry.id };
}

/** 还原一条回收站记录 */
async function restoreTrash(entryId) {
  const at = state.trash.findIndex((t) => t.id === entryId);
  if (at < 0) throw new Error('回收站里没有这条记录');
  const entry = state.trash[at];

  // 目录先回来，文件才挂得住
  for (const c of entry.courses) {
    if (state.courses.some((x) => x.id === c.id)) continue;
    // 还原期间原位置可能已经有了同名项，按（1）（2）顺延
    // （全软件统一的重名处理）
    c.name = dedupeName(c.name, takenNamesIn(c.parentId || null), false);
    state.courses.push(c);
  }

  for (const f of entry.files) {
    if (state.files.some((x) => x.id === f.id)) continue;
    const { trashedPath, originalPath, ...rest } = f;

    if (trashedPath && fs.existsSync(trashedPath)) {
      // 入库副本移回库目录
      try {
        await fsp.rename(trashedPath, originalPath);
        rest.path = originalPath;
      } catch {
        rest.path = trashedPath;
      }
    }
    // 还原撞名顺延（同上）
    rest.name = dedupeName(rest.name, takenNamesIn(rest.courseId || null), true);
    state.files.push(rest);
  }

  state.trash.splice(at, 1);
  saveStateNow();
  return snapshot();
}

/** 彻底删除一条回收站记录 */
async function purgeTrash(entryId) {
  const at = state.trash.findIndex((t) => t.id === entryId);
  if (at < 0) throw new Error('回收站里没有这条记录');
  const entry = state.trash[at];

  for (const f of entry.files) {
    if (f.trashedPath && fs.existsSync(f.trashedPath)) {
      try { await fsp.unlink(f.trashedPath); } catch { /* 忽略 */ }
    }
  }
  state.trash.splice(at, 1);
  saveStateNow();
  return snapshot();
}

/** 清空回收站 */
async function purgeAllTrash() {
  const all = state.trash;
  state.trash = [];
  for (const entry of all) {
    for (const f of entry.files) {
      if (f.trashedPath && fs.existsSync(f.trashedPath)) {
        try { await fsp.unlink(f.trashedPath); } catch { /* 忽略 */ }
      }
    }
  }
  saveStateNow();
  return snapshot();
}

/**
 * 删除「入库」文件在软件数据目录里的副本。
 * 只删位于 VAULT_FILES_DIR 内的文件，绝不碰用户的原始路径。
 */
async function removeCopies(records) {
  const root = path.resolve(VAULT_FILES_DIR());
  for (const f of records) {
    if (f.storage !== 'copy') continue;
    const target = path.resolve(f.path);
    // 双保险：路径必须确实落在库目录内才允许删除
    if (!target.startsWith(root + path.sep)) continue;
    try {
      await fsp.unlink(target);
    } catch {
      /* 文件可能已被手动删除，忽略 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 文件重新定位（原路径失效后，去电脑里找回来）
 * ------------------------------------------------------------------ */

/** 常见位置优先，加上原路径所在目录，避免一上来就扫整块盘 */
function relocateRoots(oldPath) {
  const roots = [];
  const push = (p) => {
    try { if (p && fs.existsSync(p)) roots.push(p); } catch { /* 忽略 */ }
  };
  if (oldPath) {
    let dir = path.dirname(oldPath);
    // 原目录可能整棵被移动了，往上退两级再找
    for (let i = 0; i < 2 && dir; i += 1) {
      push(dir);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  for (const key of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']) {
    try { push(app.getPath(key)); } catch { /* 某些系统没有该目录 */ }
  }
  // 去重，保持顺序
  return [...new Set(roots)];
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '$recycle.bin', 'system volume information',
  'appdata', 'windows', 'program files', 'program files (x86)',
]);

/**
 * 在常见位置按文件名广度优先搜索。
 * 限时 + 限量，宁可少找几个也不能把界面卡死。
 */
async function searchByName(name, roots, { timeoutMs = 4000, maxEntries = 60000 } = {}) {
  const target = name.toLowerCase();
  const found = [];
  const deadline = Date.now() + timeoutMs;
  let visited = 0;

  const queue = roots.slice();
  const seen = new Set(queue.map((r) => path.resolve(r)));

  while (queue.length && Date.now() < deadline && visited < maxEntries) {
    const batch = queue.splice(0, 24);
    await Promise.all(batch.map(async (dir) => {
      let ents;
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      visited += ents.length;
      for (const ent of ents) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
          const real = path.resolve(full);
          if (seen.has(real)) continue;
          seen.add(real);
          queue.push(full);
        } else if (ent.isFile() && ent.name.toLowerCase() === target) {
          found.push(full);
        }
      }
    }));
  }

  // 信息更完整的排前面（大小非 0、最近修改过）
  const stats = await Promise.all(found.map(async (p) => {
    try {
      const st = await fsp.stat(p);
      return { path: p, size: st.size, mtime: st.mtimeMs };
    } catch {
      return { path: p, size: 0, mtime: 0 };
    }
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats;
}

/** 把一条文件记录指向新路径，并刷新元数据 */
function relocateRecord(f, newPath) {
  const st = fs.statSync(newPath);
  const base = path.basename(newPath);
  f.path = newPath;
  f.name = base;
  f.ext = path.extname(base).toLowerCase();
  f.size = st.size;
  f.mtime = st.mtimeMs;
  saveStateNow();
  return f;
}

/* ------------------------------------------------------------------ *
 * 预览
 * ------------------------------------------------------------------ */

/**
 * 旧版 .doc（Word 97-2003，OLE 复合文档）取正文。
 *
 * 这类文件正文有两种存法：
 *   - 非复杂格式（fComplex=0）：正文是 WordDocument 流里从 fcMin 到 fcMac 的一段
 *   - 复杂格式（fComplex=1）：正文按 piece table 碎片存放，得解析 1Table 里的 CLX
 * 后者才是常态（Word 保存过的文档基本都是），所以两条路都得走。
 *
 * 注意 .doc 里图片、公式都是 OLE 对象，正文本身可能只剩几个字
 * （比如整份题库是 37 个公式对象拼出来的）。这种情况下老老实实
 * 告诉用户「正文以图片/公式为主」，不要假装解析成功了。
 */
function extractLegacyDocText(file) {
  const CFB = require('cfb');
  const c = CFB.read(fs.readFileSync(file), { type: 'buffer' });
  const stream = (name) => c.FullPaths
    .map((fp, i) => ({ fp, entry: c.FileIndex[i] }))
    .find((x) => x.fp.endsWith(name));

  const wdEntry = stream('WordDocument');
  if (!wdEntry) return { text: '', oleObjects: 0 };
  const wd = wdEntry.entry.content;
  if (wd.length < 0x20) return { text: '', oleObjects: 0 };

  // OLE 对象数：正文里的图/公式都在 ObjectPool 下，一个对象一个子流
  const oleObjects = c.FullPaths.filter(
    (fp) => fp.includes('ObjectPool/') && /\/\x01Ole$/.test(fp),
  ).length;

  const flags = wd.readUInt16LE(0x0A);
  const fComplex = (flags >> 2) & 1;
  const fcMin = wd.readUInt32LE(0x18);
  const fcMac = wd.readUInt32LE(0x1C);

  const decode = (buf) => {
    // 偶数位大量为 0 → UTF-16LE，否则按单字节（中文文档里基本不会走到）
    let zeros = 0;
    const probe = Math.min(buf.length, 800);
    for (let i = 1; i < probe; i += 2) if (buf[i] === 0) zeros += 1;
    return zeros > probe / 4 ? buf.toString('utf16le') : buf.toString('latin1');
  };

  if (!fComplex) {
    if (fcMac <= fcMin) return { text: '', oleObjects };
    return { text: decode(wd.slice(fcMin, fcMac)), oleObjects };
  }

  const tbl = stream('1Table') || stream('0Table');
  if (!tbl) return { text: '', oleObjects };
  const tb = tbl.entry.content;

  const fcClx = wd.readUInt32LE(0x01A2);
  const lcbClx = wd.readUInt32LE(0x01A6);
  if (!lcbClx || fcClx + lcbClx > tb.length) return { text: '', oleObjects };
  const clx = tb.slice(fcClx, fcClx + lcbClx);

  // CLX 里先是一串 0x01 Prc 块（格式信息，跳过），最后一个 0x02 是 Pcdt
  let i = 0;
  while (i < clx.length) {
    if (clx[i] === 0x01) {
      i += 3 + clx.readUInt16LE(i + 1);
    } else if (clx[i] === 0x02) {
      const lcb = clx.readUInt32LE(i + 1);
      const plc = clx.slice(i + 5, i + 5 + lcb);
      const n = Math.floor((lcb - 4) / 12);
      if (n <= 0) return { text: '', oleObjects };

      const cps = [];
      for (let k = 0; k <= n; k += 1) cps.push(plc.readUInt32LE(k * 4));

      const parts = [];
      for (let k = 0; k < n; k += 1) {
        const base = (n + 1) * 4 + k * 8;
        const fcRaw = plc.readUInt32LE(base + 2);
        const compressed = (fcRaw & 0x40000000) !== 0;
        const fc = fcRaw & 0x3FFFFFFF;
        const cch = cps[k + 1] - cps[k];
        if (cch <= 0) continue;
        if (compressed) {
          // 压缩片段是单字节，fc 是「字符偏移 × 2」
          parts.push(wd.slice(fc / 2, fc / 2 + cch).toString('latin1'));
        } else {
          parts.push(wd.slice(fc, fc + cch * 2).toString('utf16le'));
        }
      }
      return { text: parts.join(''), oleObjects };
    } else {
      break;
    }
  }
  return { text: '', oleObjects };
}

function buildLegacyDocPreview(f) {
  let text = '';
  let oleObjects = 0;
  try {
    ({ text, oleObjects } = extractLegacyDocText(f.path));
  } catch (err) {
    return {
      type: 'unsupported',
      name: f.name,
      reason: `这个 .doc 解析失败（${err.message}），可用系统程序打开`,
    };
  }

  // 清掉 Word 的控制字符（\r 段落、\x07 表格单元格、\x0c 分页 等）
  const clean = text
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const mostlyMedia = clean.length < 200 && oleObjects > 0;
  const note = mostlyMedia
    ? `这份文档的正文以图片/公式为主（${oleObjects} 个嵌入对象），能提取到的文字只有 ${clean.length} 个字符。要看完整内容请用系统程序打开。`
    : (oleObjects > 0
      ? `已提取正文文字；文档里另有 ${oleObjects} 个图片/公式对象，内嵌预览显示不出来。`
      : '');

  return {
    type: 'legacyDoc',
    name: f.name,
    text: clean,
    oleObjects,
    mostlyMedia,
    note,
  };
}


/**
 * 预览结果缓存。
 * 重开同一个文件（关掉再点开、编辑保存后重看）时不必再读盘解析一遍，
 * 用 size+mtime 当版本号，文件被外部改过就自动失效。
 * 只留最近 12 个，且单条超过 4MB 的不缓存，免得堆越攒越大。
 */
const PREVIEW_CACHE_MAX = 12;
const PREVIEW_CACHE_BYTES = 4 * 1024 * 1024;
const previewCache = new Map(); // id -> { key, data }

function previewCacheKey(f) {
  const st = statOf(f.path);
  if (!st) return `grace:${f.size || 0}:${f.mtime || 0}`;
  return `${st.exists ? 1 : 0}:${st.size}:${st.mtime}`;
}

function cachePreview(id, key, data) {
  if (!data || data.type === 'missing') return data;
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(data));
  } catch {
    return data;
  }
  if (bytes > PREVIEW_CACHE_BYTES) return data;
  previewCache.delete(id);
  previewCache.set(id, { key, data });
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    previewCache.delete(previewCache.keys().next().value);
  }
  return data;
}

/**
 * PPTX 预览：每页文字 + 该页自己的图片。
 *
 * pptx 是个 zip：正文在 ppt/slides/slideN.xml，图片在 ppt/media/，
 * 哪张图属于哪一页记在 ppt/slides/_rels/slideN.xml.rels 里。
 * 所以「按页归属图片」是可以做到的，不是只能把图全堆一起。
 *
 * 图片以 data URL 内嵌返回，避免为一个预览再开一套自定义协议。
 * 单张超过 MAX_SLIDE_IMAGE 的就只报尺寸不内嵌，否则 5MB 的 PPT 能撑爆 IPC。
 */
const MAX_SLIDE_IMAGE = 900 * 1024;

async function buildPptxPreview(f) {
  const JSZip = require('jszip');
  const buf = await fsp.readFile(f.path);
  const zip = await JSZip.loadAsync(buf);

  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)[1]);
      const nb = Number(b.match(/slide(\d+)\.xml$/)[1]);
      return na - nb;
    });

  const unescapeXml = (s) => s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

  const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.emf': '', '.wmf': '', // EMF/WMF 浏览器画不了，跳过
  };

  const slides = [];
  for (const n of slideNames) {
    const xml = await zip.files[n].async('string');

    // 文字：<a:t> 节点。注意保持段落顺序，同一段的多个 run 要拼在一起。
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]));

    // 图片：先读这一页的 rels，拿到 rId → media 路径
    const relsPath = n.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    const relsFile = zip.files[relsPath];
    const images = [];

    if (relsFile) {
      const rels = await relsFile.async('string');
      for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        const tag = rel[0];
        if (!/relationships\/image"/.test(tag)) continue;
        const target = (tag.match(/Target="([^"]+)"/) || [])[1];
        if (!target) continue;

        // Target 是相对 slideN.xml 的路径（常见 ../media/image1.png）
        const mediaPath = path.posix.normalize(
          path.posix.join(path.posix.dirname(n), target),
        );
        const media = zip.files[mediaPath];
        if (!media) continue;

        const ext = path.posix.extname(mediaPath).toLowerCase();
        const mime = MIME_BY_EXT[ext];
        if (!mime) continue; // EMF/WMF 之类，浏览器显示不了

        const data = await media.async('base64');
        // base64 后大小 ≈ 原大小 × 1.37
        const tooBig = data.length > MAX_SLIDE_IMAGE * 1.37;
        images.push({
          url: tooBig ? null : `data:${mime};base64,${data}`,
          name: path.posix.basename(mediaPath),
          tooBig,
          kb: Math.round((data.length * 0.75) / 1024),
        });
      }
    }

    slides.push({ index: slides.length + 1, texts, images });
  }

  const withImages = slides.filter((s) => s.images.length).length;
  const note = withImages
    ? '文字与图片均按页提取；版式（位置、动画）请用系统程序查看'
    : '这份 PPT 没有可显示的图片，仅提取文字';

  return { type: 'slides', slides, name: f.name, note };
}

/** 所有预览结果统一带上「能怎么打开」的信息，前端不用再猜。
 *  注意 defaultEditor 不进缓存：用户改了默认程序要立刻生效。 */
function withOpenInfo(f, data) {
  if (!data) return data;
  const runner = runnerFor(f);
  return {
    ...data,
    ext: data.ext || f.ext,
    runner: runner ? { key: runner.key, label: runner.label, hint: runner.hint } : null,
    defaultEditor: state.settings.defaultEditor || 'vscode',
  };
}

async function buildPreview(id) {
  const f = findFile(id);
  if (!f) throw new Error('文件不存在');
  if (!fs.existsSync(f.path)) return { type: 'missing', name: f.name };

  const key = previewCacheKey(f);
  const hit = previewCache.get(id);
  if (hit && hit.key === key) {
    // 命中后挪到队尾，保持 LRU 顺序
    previewCache.delete(id);
    previewCache.set(id, hit);
    return withOpenInfo(f, hit.data);
  }

  // 缓存里只存解析结果本身，打开方式每次现算
  const data = await buildPreviewUncached(f);
  cachePreview(id, key, data);
  return withOpenInfo(f, data);
}

async function buildPreviewUncached(f) {
  const kind = kindOf(f.ext);

  if (['image', 'video', 'audio', 'pdf'].includes(kind)) {
    return { type: kind, url: `vault://f/${f.id}`, name: f.name, ext: f.ext };
  }

  if (kind === 'word') {
    if (f.ext === '.doc') {
      return buildLegacyDocPreview(f);
    }
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToHtml({ path: f.path });
    return { type: 'html', html: value, name: f.name };
  }

  if (kind === 'excel') {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(f.path, { cellDates: true });
    const sheets = wb.SheetNames.map((n) => ({
      name: n,
      html: XLSX.utils.sheet_to_html(wb.Sheets[n], { editable: false }),
    }));
    return { type: 'sheets', sheets, name: f.name };
  }

  if (kind === 'ppt') {
    if (f.ext === '.ppt') {
      return { type: 'unsupported', name: f.name, reason: '旧版 .ppt 无法内嵌解析，可用系统程序打开' };
    }
    return buildPptxPreview(f);
  }

  if (kind === 'markdown' || kind === 'code' || kind === 'text') {
    const st = await fsp.stat(f.path);
    if (st.size > MAX_TEXT_PREVIEW) {
      return { type: 'unsupported', name: f.name, reason: '文件过大，无法内嵌预览' };
    }
    // 一次读完再判断二进制：原来先 looksBinary() 开一次、readFile() 再开一次，
    // 同一个文件要 open/read/close 两遍，网络盘上尤其明显
    const buf = await fsp.readFile(f.path);
    const probe = Math.min(buf.length, 4096);
    for (let i = 0; i < probe; i += 1) {
      if (buf[i] === 0) {
        return { type: 'unsupported', name: f.name, reason: '二进制内容，无法以文本预览' };
      }
    }
    const text = buf.toString('utf8');

    if (kind === 'markdown') {
      const { marked } = require('marked');
      const hljs = getHljs();
      marked.setOptions({
        gfm: true,
        breaks: true,
        renderer: (() => {
          const r = new marked.Renderer();
          r.code = ({ text: code, lang }) => {
            const language = lang && hljs.getLanguage(lang) ? lang : null;
            const html = language
              ? hljs.highlight(code, { language }).value
              : (code.length > MAX_AUTODETECT_CHARS
                ? code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
                : hljs.highlightAuto(code).value);
            return `<pre><code class="hljs">${html}</code></pre>`;
          };
          return r;
        })(),
      });
      return { type: 'html', html: marked.parse(text), name: f.name, text, editable: true };
    }

    const hljs = getHljs();
    const lang = languageFor(f);
    const escapeOnly = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    // 纯文本（.txt/.log/.rtf）是文档不是代码，不猜语言也不上色：
    // 笔记和日志被随机染色反而更难读
    if (kind === 'text') {
      return { type: 'code', html: escapeOnly(text), name: f.name, ext: f.ext, text, editable: true };
    }

    let html;
    try {
      if (lang && hljs.getLanguage(lang)) {
        html = hljs.highlight(text, { language: lang }).value;
      } else if (text.length > MAX_AUTODETECT_CHARS) {
        // highlightAuto 会把所有语言都试一遍，大文件能卡好几秒；
        // 超过这个长度就放弃猜语言，直接转义输出，反正不影响阅读
        html = escapeOnly(text);
      } else {
        html = hljs.highlightAuto(text).value;
      }
    } catch {
      html = escapeOnly(text);
    }
    return { type: 'code', html, name: f.name, ext: f.ext, text, editable: true };
  }

  return { type: 'unsupported', name: f.name, reason: '暂不支持该格式内嵌预览' };
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */
let win = null;

function createWindow() {
  /* 默认宽度按「刚好铺满四列卡片」来定，而不是按屏幕比例。
   *
   * 卡片固定 232px 宽、间距 12px，四列需要 4×232 + 3×12 = 964px 内容区；
   * 加上侧栏 250 和左右内边距 44，窗口要 1258px。实测临界点是 1270px
   * （内容区 1020px，多出的空间来自网格的剩余分配）。
   * 这里取 1280 留一点余量，避免滚动条或字体差异把它挤回三列。
   *
   * 屏幕比 1280 还小时就用屏幕宽度，但不超过 1280 —— 窗口再宽
   * 第五列就冒出来了，卡片会显得稀。 */
  const { workArea } = screen.getPrimaryDisplay();
  const FOUR_COLS = 1280;
  const width = Math.min(FOUR_COLS, Math.max(940, workArea.width - 80));
  const height = Math.max(720, Math.min(900, Math.round(workArea.height * 0.88)));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#faf9f5',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    // 不开 titleBarOverlay：窗口按钮由页面自己画（titlebar-actions），
    // 否则系统会再叠一层不受页面控制的按钮区，切主题做圆形扩散时
    // 那块区域会先一步变色，动画就断了。
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      plugins: true, // 内置 PDF 查看器
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  /* Esc 兜底：把 Esc 转成一条 IPC 消息发给渲染进程。
   *
   * 为什么需要主进程来转发：PDF 预览用的是 Chromium 内置阅读器，
   * 跑在跨源 iframe 里。用户点一下 PDF 内容，焦点就进了那个子文档，
   * 之后所有键盘事件都被它吃掉，主文档一条也收不到 —— 预览关不掉。
   * 子文档跨源、注入不了脚本，抢焦点又会打断用户在 PDF 里选文字。
   *
   * before-input-event 在**所有 frame 之前**触发，不受焦点位置影响，
   * 是唯一能可靠拿到这种按键的地方。只转发 Esc，其它键一律不拦，
   * 免得影响输入框打字、编辑器快捷键。
   *
   * 注意 focusedFrame 是**只读属性不是方法**，写成 focusedFrame() 会
   * 拿到 undefined，判定永远为 false，消息一条也发不出去。 */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;

    /* 导航/显示类快捷键也由主进程代收，理由同 Esc：焦点在 PDF
     * 子文档里时主文档收不到键；而且 Ctrl+Shift+R 会被默认菜单的
     * 「强制重新加载」抢走（应用菜单已关，这里再兜一层）。
     * 在这里 preventDefault 后页面就不会再收到这次按键，渲染进程
     * 只走 IPC 这一条路，不会重复触发。 */
    let action = null;
    if (input.alt && input.key === 'ArrowLeft') action = 'nav-up';
    else if (input.alt && (input.key === 'ArrowUp' || input.key === 'Home')) action = 'nav-home';
    else if (input.control && input.shift && (input.key === 'R' || input.key === 'r')) action = 'reveal';
    if (action) {
      e.preventDefault();
      win.webContents.send('win:shortcut', action);
      return;
    }

    if (input.key !== 'Escape') return;
    let inSubframe = false;
    try {
      const frame = win.webContents.focusedFrame;
      inSubframe = !!frame && frame !== win.webContents.mainFrame;
    } catch {
      /* 老版本 Electron 没有 focusedFrame，退化成「总是转发」 */
      inSubframe = true;
    }
    // 焦点在主文档时它自己会处理，别重复
    if (inSubframe) win.webContents.send('win:escape');
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ *
 * 自动检测更新
 * ------------------------------------------------------------------ */
/* 小时档的间隔毫秒数。「每次启动」和「每天一次」不走这张表：
 * 前者每次启动查一次，后者按自然日（过了 0 点就算新的一天）。 */
const AUTO_CHECK_EVERY = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

let autoCheckTimer = null;
/* 「每次启动」模式本次运行是否已经查过（查过就不再排） */
let autoStartupDone = false;
/* 本次运行里最近一次尝试检测的时间（含失败的）：检测失败时持久化的
 * 上次检测时间不会更新，拿它兜底，避免失败后每隔几秒重试一次。 */
let autoLastAttempt = 0;
/* 本次运行里是否已经真正完成过一轮检测（算出过一份新结果）。
 * 关于页判断留存结果新不新鲜就靠它：还没跑完时留存的是上一轮的
 * 旧结果，数目可能和现在的实际改动对不上，不能拿去弹窗。 */
let autoSessionChecked = false;

/** 一份比对结果的指纹：文件清单没变，指纹就不变。
 * 页面靠它记「这批变化用户已经点过稍后了」，重启也不会对同一批重复提醒。 */
function updateSig(d) {
  const raw = JSON.stringify([d.changed || [], d.added || [], d.removed || []]);
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** 记下「刚完成一次检测」：时间和结果存进 update-config.json。
 * 自动、手动检测都记 ——「距上次检测满 N 小时」里的上次，指任何一次。
 * keepResult 时把结果一并留下：用户可能在检测完成后才打开设置，
 * 甚至下次启动才打开，提醒条要能凭这份记录在关于页里摆出来。 */
function stampCheck(d, { keepResult = false } = {}) {
  if (!d?.ok) return;
  const patch = { lastCheckAt: Date.now() };
  if (keepResult) {
    patch.lastResult = d.total
      ? {
          ok: true,
          total: d.total,
          changed: d.changed,
          added: d.added,
          removed: d.removed,
          version: d.version,
          depsChanged: !!d.depsChanged,
          sig: updateSig(d),
        }
      : null;
  }
  try { saveUpdateConfig(patch); } catch { /* 记录失败不影响检测本身 */ }
}

/** 把「发现更新」推给页面。页面还没加载完时消息会掉，所以等它加载完再补。 */
function pushUpdateAvailable(d, tries = 0) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) {
    if (tries < 10) setTimeout(() => pushUpdateAvailable(d, tries + 1), 1000);
    return;
  }
  win.webContents.send('update:available', d);
}

/** 比对一次：记时间、存结果，有新东西就推给页面。返回比对结果，出错时 ok=false。 */
function runAutoCheck() {
  autoLastAttempt = Date.now();
  let d;
  try {
    d = checkForUpdate();
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  stampCheck(d, { keepResult: true });
  if (d.ok) autoSessionChecked = true;
  if (d.ok && d.total) pushUpdateAvailable({ ...d, sig: updateSig(d) });
  return d;
}

/**
 * 按设置重排自动检测的定时器。
 *
 * 定时器放在主进程而不是页面里：窗口最小化或收进后台之后，渲染进程的
 * 定时器会被 Chromium 节流（隐藏页最长能压到每分钟一次，极端情况还会
 * 整个冻住），「每 1 小时」就变成了「不知道多久」。主进程的定时器不受影响。
 */
/** 距下一次该检测还有多久（毫秒）。0 = 现在就到期；Infinity = 本次运行不再检测。
 *
 * 三种模式的「到期」都以持久化的上次检测时间为准，而不是本次运行的计时：
 * 每 N 小时 —— 距上次检测已满 N 小时才到期，刚查过就重开软件不会白跑一遍；
 * 每天一次 —— 按自然日：上次检测不在今天（过了 0 点）就到期，不必满 24 小时；
 * 每次启动 —— 每次运行只查一次。 */
function autoCheckDueIn(now = Date.now()) {
  if (!state?.settings?.autoCheckUpdate) return Infinity;
  const mode = state.settings.autoCheckInterval || 'startup';
  const last = Math.max(Number(loadUpdateConfig().lastCheckAt) || 0, autoLastAttempt);
  if (mode === 'startup') return autoStartupDone ? Infinity : 0;
  if (mode === 'daily') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (last < start.getTime()) return 0;
    return start.getTime() + 24 * 60 * 60 * 1000 - now;
  }
  const every = AUTO_CHECK_EVERY[mode];
  if (!every) return Infinity;
  return Math.max(0, last + every - now);
}

function scheduleAutoCheck(delayFirst = 6000) {
  if (autoCheckTimer) {
    clearTimeout(autoCheckTimer);
    autoCheckTimer = null;
  }
  // state 可能在 loadState 之前就被问到（极早期调用），这时按未开启处理
  if (!state?.settings?.autoCheckUpdate) return;

  const dueIn = autoCheckDueIn();
  if (dueIn === Infinity) return;
  /* 到期就尽快跑：开机那次由调用方传 delayFirst=0，启动后立刻开始
   * 检测（用户要求：打开关于时结果要已经备好，弹窗不能让人等）；
   * 设置里刚改完频率时传较大的值，稍让一让界面刷新。
   * 还没到期就按剩余时间排，长开着的软件跨过边界也会准时查。 */
  const wait = dueIn === 0 ? Math.max(300, delayFirst) : dueIn;
  autoCheckTimer = setTimeout(() => {
    autoCheckTimer = null;
    if ((state.settings.autoCheckInterval || 'startup') === 'startup') autoStartupDone = true;
    runAutoCheck();
    // 按新的上次检测时间排下一次（小时/每天模式继续循环，每次启动模式到此为止）
    scheduleAutoCheck();
  }, wait);
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('app:bootstrap', () => snapshot());

  ipcMain.handle('state:get', () => snapshot());

  /* --- 课程 --- */
  ipcMain.handle('course:create', (_e, { name, color, parentId }) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('名称不能为空');
    const parent = parentId || null;
    if (parent && !state.courses.some((c) => c.id === parent)) {
      throw new Error('上级目录不存在');
    }
    // 与同层已有的目录/文件重名时自动改名 原名（1）、原名（2）…
    // （2026-11-18 用户定版：不再报错拦下新建）
    const finalName = dedupeName(trimmed, takenNamesIn(parent), false);
    const course = {
      id: uid(),
      name: finalName,
      color: color || '#5b8def',
      parentId: parent,
      createdAt: Date.now(),
    };
    state.courses.push(course);
    saveStateNow();
    return snapshot();
  });

  ipcMain.handle('course:rename', (_e, { id, name }) => {
    const course = state.courses.find((c) => c.id === id);
    if (!course) throw new Error('目录不存在');
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('名称不能为空');
    // 改名撞上同层已有的目录/文件时按（1）（2）顺延，不再报错
    // （2026-11-18 用户定版：全软件统一的重名处理）。自己原来的
    // 名字先从占用集合里摘掉，改回原名不算撞名。
    const taken = takenNamesIn(course.parentId || null);
    taken.delete(course.name);
    course.name = dedupeName(trimmed, taken, false);
    saveStateNow();
    return snapshot();
  });

  /**
   * 调整同一层级内的顺序（拖拽排序用）。
   * orderedIds 只包含该层的 id，其余目录保持原有相对位置。
   */
  ipcMain.handle('course:reorder', (_e, { parentId, orderedIds }) => {
    const parent = parentId || null;
    const wanted = (orderedIds || []).filter(
      (id) => state.courses.some((c) => c.id === id && (c.parentId || null) === parent),
    );
    if (!wanted.length) return snapshot();

    const wantedSet = new Set(wanted);
    // 把该层的节点按新顺序填回原数组的对应槽位，保持整体结构不变
    let cursor = 0;
    state.courses = state.courses.map((c) => {
      if ((c.parentId || null) !== parent || !wantedSet.has(c.id)) return c;
      const nextId = wanted[cursor];
      cursor += 1;
      return state.courses.find((x) => x.id === nextId) || c;
    });
    saveStateNow();
    return snapshot();
  });

  /** 把目录移到另一个目录下（parentId 为 null 表示移到顶层） */
  ipcMain.handle('course:move', (_e, { id, parentId }) => {
    const node = state.courses.find((c) => c.id === id);
    if (!node) throw new Error('目录不存在');
    const target = parentId || null;
    if (target === id) throw new Error('不能移动到自己下面');
    if (target) {
      if (!state.courses.some((c) => c.id === target)) throw new Error('目标目录不存在');
      // 防止形成环：目标不能是自己的子孙
      let cur = target;
      const seen = new Set();
      while (cur) {
        if (cur === id) throw new Error('不能移动到自己的子目录里');
        if (seen.has(cur)) break;
        seen.add(cur);
        cur = state.courses.find((c) => c.id === cur)?.parentId || null;
      }
    }
    // 移到原地时名字不动；换了位置且目标层已有同名项（文件或
    // 目录）时按（1）（2）顺延，不再报错拦下（全软件统一的重名处理）
    if (target !== (node.parentId || null)) {
      node.name = dedupeName(node.name, takenNamesIn(target), false);
    }
    node.parentId = target;
    saveStateNow();
    return snapshot();
  });

  ipcMain.handle('course:setColor', (_e, { id, color }) => {
    const course = state.courses.find((c) => c.id === id);
    if (!course) throw new Error('课程不存在');
    course.color = color;
    saveStateNow();
    return snapshot();
  });

  // 删除目录：连子目录一起删。trash=true 时进回收站，否则彻底删除
  ipcMain.handle('course:delete', async (_e, { id, trash }) => {
    const course = state.courses.find((c) => c.id === id);
    if (!course) throw new Error('目录不存在');

    // 收集自己 + 所有子孙目录
    const doomedIds = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of state.courses) {
        if (c.parentId && doomedIds.has(c.parentId) && !doomedIds.has(c.id)) {
          doomedIds.add(c.id);
          grew = true;
        }
      }
    }

    const doomedFiles = state.files.filter((f) => doomedIds.has(f.courseId));

    if (trash) {
      await moveToTrash({
        fileIds: doomedFiles.map((f) => f.id),
        courseIds: [...doomedIds],
      });
      return snapshot();
    }

    await removeCopies(doomedFiles);
    state.files = state.files.filter((f) => !doomedIds.has(f.courseId));
    state.courses = state.courses.filter((c) => !doomedIds.has(c.id));
    saveStateNow();
    return snapshot();
  });

  /* --- 重复文件 --- */
  ipcMain.handle('dupes:scan', (_e, { courseId }) => scanDuplicates({ courseId }));

  ipcMain.handle('dupes:remove', async (_e, { fileIds }) => {
    const ids = (fileIds || []).filter((id) => findFile(id));
    if (!ids.length) return { removed: 0, state: snapshot() };
    await moveToTrash({ fileIds: ids });
    return { removed: ids.length, state: snapshot() };
  });

  /* --- 回收站 --- */
  ipcMain.handle('trash:restore', (_e, { id }) => restoreTrash(id));
  ipcMain.handle('trash:purge', (_e, { id }) => purgeTrash(id));
  ipcMain.handle('trash:empty', () => purgeAllTrash());

  /* --- 搜索 --- */
  ipcMain.handle('files:search', (_e, payload) => searchFiles(payload));

  /* --- 导入 --- */
  ipcMain.handle('files:scan', (_e, payload) => scanImport(payload?.paths || [], payload || {}));

  ipcMain.handle('dialog:pickFiles', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择要导入的文件',
      properties: ['openFile', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  /**
   * 读剪贴板里「被复制的文件」。
   *
   * Electron 45 的 clipboard 换成了 Blob 式新 API，readBuffer/CF_HDROP
   * 全部拿不到了（readBuffer 是 undefined），所以只能问系统：
   * PowerShell 的 Get-Clipboard -Format FileDropList 是 Windows 官方读法。
   * 每次约 200~400ms —— 粘贴是低频操作，这个代价可以接受。
   */
  ipcMain.handle('clipboard:hasFiles', async () => (await readClipboardPaths()).length > 0);
  ipcMain.handle('clipboard:readFiles', () => readClipboardPaths());

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择要导入的文件夹',
      properties: ['openDirectory', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('files:import', async (_e, payload) => {
    const result = await importFiles(payload);
    return { ...result, state: snapshot() };
  });

  /**
   * 在指定目录里新建一个空文件。
   * 文件建在用户选的位置（默认桌面），库里只登记路径 —— 和导入一样只做链接，
   * 电脑上永远只有这一份，在软件里编辑就是直接改这份文件。
   */
  ipcMain.handle('file:create', async (_e, payload) => {
    const { courseId, name, saveDir, content } = payload || {};
    const course = state.courses.find((c) => c.id === courseId);
    if (!course) throw new Error('目录不存在');

    const fileName = String(name || '').trim();
    if (!fileName) throw new Error('文件名不能为空');
    // 文件名里不允许出现路径分隔符等非法字符
    if (/[\\/:*?"<>|]/.test(fileName)) {
      throw new Error('文件名不能包含 \\ / : * ? " < > | 这些字符');
    }

    const text = typeof content === 'string' ? content : '';

    let dir = saveDir;
    if (!dir) {
      try { dir = app.getPath('desktop'); } catch { dir = app.getPath('userData'); }
    }
    await fsp.mkdir(dir, { recursive: true });
    // 与目标目录内已有文件/子目录重名时，先按 原名（1）（2）改名，
    // 再交给 uniqueTarget 做磁盘层面的同名避让（2026-11-18 用户定版）
    const wantedName = dedupeName(fileName, takenNamesIn(courseId), true);
    const target = uniqueTarget(dir, wantedName);
    // 同名时实际落盘名字会带 (1)，界面跟着用真实名字
    const displayName = path.basename(target);

    try {
      await fsp.writeFile(target, text, 'utf8');
    } catch (err) {
      throw new Error(`创建文件失败：${err.message}`);
    }

    const st = await fsp.stat(target);
    const rec = {
      id: uid(),
      courseId,
      name: displayName,
      ext: path.extname(displayName).toLowerCase(),
      size: st.size,
      mtime: st.mtimeMs,
      addedAt: Date.now(),
      path: target,
      storage: 'link',
    };
    state.files.push(rec);
    saveStateNow();
    return { file: publicFile(rec), state: snapshot() };
  });

  /** 选一个新建文件要保存到的目录（链接模式用） */
  ipcMain.handle('dialog:pickSaveDir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择新建文件的保存位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: (() => { try { return app.getPath('desktop'); } catch { return undefined; } })(),
    });
    return res.canceled ? null : res.filePaths[0];
  });

  /** 文件详情：真实路径、存储方式、大小、时间、所在目录 */
  ipcMain.handle('file:info', (_e, id) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');

    let exists = false;
    let size = f.size || 0;
    let mtime = f.mtime || 0;
    try {
      const st = fs.statSync(f.path);
      exists = st.isFile();
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* 文件不在了，用记录里的旧值 */ }

    return {
      id: f.id,
      name: f.name,
      ext: f.ext,
      kind: kindOf(f.ext),
      path: f.path,
      storage: f.storage || 'link',
      origin: f.origin || null,
      size,
      mtime,
      addedAt: f.addedAt || 0,
      exists,
      dirPath: pathOfDirNames(f.courseId),
      // 入库文件在库目录内，链接文件在用户自己的位置
      inVault: (() => {
        try {
          const root = path.resolve(VAULT_FILES_DIR());
          return path.resolve(f.path).startsWith(root + path.sep);
        } catch { return false; }
      })(),
    };
  });

  /* --- 文件操作 --- */
  ipcMain.handle('file:preview', async (_e, id) => buildPreview(id));

  /**
   * 编辑时的实时高亮：给一段文本，返回带 hljs 类名的 HTML。
   * 前端用 textarea + 底下垫一层高亮镜像来实现，不引 CodeMirror。
   * 太长的文本直接返回转义结果（打字时每次都高亮全文会很卡）。
   */
  ipcMain.handle('file:highlight', (_e, { id, text }) => {
    const f = findFile(id);
    if (!f) return { html: '' };
    const kind = kindOf(f.ext);
    const escapeOnly = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const src = String(text ?? '');

    // 纯文本 / 超长 / 非代码类：只转义，不上色
    if (kind === 'text' || src.length > MAX_AUTODETECT_CHARS) {
      return { html: escapeOnly(src), lang: null };
    }
    // markdown 编辑时不渲染成 HTML（那样就没法编辑了），按普通文本上色
    const lang = languageFor(f);
    const hljs = getHljs();
    try {
      if (lang && hljs.getLanguage(lang)) {
        return { html: hljs.highlight(src, { language: lang }).value, lang };
      }
      return { html: escapeOnly(src), lang: null };
    } catch {
      return { html: escapeOnly(src), lang: null };
    }
  });

  // 从库中移除。trash=true 时进回收站，否则直接清掉索引（原文件始终保留）
  ipcMain.handle('file:remove', async (_e, { id, trash }) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');

    if (trash) {
      await moveToTrash({ fileIds: [id] });
      return snapshot();
    }

    await removeCopies([f]);
    state.files = state.files.filter((x) => x.id !== id);
    saveStateNow();
    return snapshot();
  });

  /**
   * 原文件找不到了：去电脑里按文件名搜一遍，找到后重新绑定
   * 返回 { found: [...候选路径], bound: 是否已自动重新绑定 }
   */
  ipcMain.handle('file:relocate', async (_e, { id, auto }) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');
    if (fs.existsSync(f.path)) {
      return { found: [], already: true, state: snapshot() };
    }

    const roots = relocateRoots(f.path);
    const hits = await searchByName(f.name, roots);
    if (!hits.length) return { found: [], state: snapshot() };

    // 只有一个候选，或者用户明确要求自动绑定时，直接绑定
    if (auto && hits.length === 1) {
      relocateRecord(f, hits[0].path);
      return { found: hits.map((h) => h.path), bound: true, state: snapshot() };
    }
    return { found: hits.map((h) => h.path), state: snapshot() };
  });

  /** 用用户手动选中的路径重新绑定 */
  ipcMain.handle('file:relocateTo', (_e, { id, path: target }) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');
    if (!target || !fs.existsSync(target)) throw new Error('文件不存在');
    relocateRecord(f, target);
    return snapshot();
  });

  /** 手动挑一个文件来重新绑定（系统文件对话框） */
  ipcMain.handle('file:pickRelocate', async (_e, { id }) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');
    const ext = f.ext || '';
    const res = await dialog.showOpenDialog(win, {
      title: `重新定位「${f.name}」`,
      properties: ['openFile'],
      filters: ext
        ? [{ name: `${ext.slice(1).toUpperCase()} 文件`, extensions: [ext.slice(1)] }, { name: '所有文件', extensions: ['*'] }]
        : [{ name: '所有文件', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    relocateRecord(f, res.filePaths[0]);
    return snapshot();
  });

  /**
   * 把旧版本「入库」的老记录改回链接方式。
   * 界面上已经不再提供「入库」入口，这里只保留 copy → link 这一个方向，
   * 供老数据清理副本时使用；不再支持 link → copy。
   */
  ipcMain.handle('file:setStorage', async (_e, { id, storage }) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');
    if (storage === 'copy') throw new Error('已不再支持入库模式');
    if ((f.storage || 'link') === 'link') return snapshot();

    if (!f.origin) throw new Error('这条记录没有原始路径，无法改回链接');
    if (!fs.existsSync(f.origin)) throw new Error('原始位置的文件已被移动或删除');
    await removeCopies([f]);
    const st = await fsp.stat(f.origin);
    f.path = f.origin;
    f.storage = 'link';
    f.size = st.size;
    f.mtime = st.mtimeMs;
    delete f.origin;

    saveStateNow();
    return snapshot();
  });

  // 打开「入库」文件所在的库目录
  ipcMain.handle('library:openFilesDir', async () => {
    const dir = VAULT_FILES_DIR();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  });

  /**
   * 更改入库目录。
   * 已有入库文件会一并搬到新位置，搬完才写设置；中途失败则回滚设置。
   */
  ipcMain.handle('storage:setDir', async (_e, { dir, migrate }) => {
    const target = dir ? path.resolve(dir) : null;
    const oldDir = path.resolve(VAULT_FILES_DIR());

    if (target) {
      if (!fs.existsSync(target)) throw new Error('目标文件夹不存在');
      if (!fs.statSync(target).isDirectory()) throw new Error('目标不是文件夹');
      if (target === oldDir) return { ok: true, moved: 0, dir: target };
    }

    let moved = 0;
    if (migrate) {
      const copies = state.files.filter((f) => f.storage === 'copy');
      if (copies.length && target) {
        await fsp.mkdir(target, { recursive: true });
        const done = [];
        try {
          for (const f of copies) {
            const src = path.resolve(f.path);
            // 只搬确实在旧库目录里的副本
            if (!src.startsWith(oldDir + path.sep)) continue;
            const dest = uniqueTarget(target, path.basename(src));
            await fsp.copyFile(src, dest);
            const st = await fsp.stat(dest);
            done.push({ rec: f, from: src, to: dest, size: st.size, mtime: st.mtimeMs });
          }
        } catch (err) {
          // 回滚：删掉已经复制过去的新文件
          for (const d of done) {
            try { await fsp.unlink(d.to); } catch { /* 忽略 */ }
          }
          throw new Error(`迁移失败：${err.message}`);
        }

        // 全部复制成功后再改记录、删旧文件
        for (const d of done) {
          d.rec.path = d.to;
          d.rec.size = d.size;
          d.rec.mtime = d.mtime;
          try { await fsp.unlink(d.from); } catch { /* 忽略 */ }
          moved += 1;
        }
      }
    }

    state.settings.storeDir = target;
    saveStateNow();

    // 迁移后清掉旧目录里的空壳
    if (moved && !target) {
      try { await fsp.rmdir(oldDir); } catch { /* 非空就留着 */ }
    }

    return { ok: true, moved, dir: target || oldDir };
  });

  // 让用户选一个文件夹作为入库位置
  ipcMain.handle('storage:pickDir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择入库文件存放位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('documents'),
    });
    return res.canceled ? null : res.filePaths[0];
  });

  /* --- 数据库 --- */
  ipcMain.handle('db:health', () => {
    const h = db.health();
    return { ...h, file: DB_FILE() };
  });

  ipcMain.handle('db:backup', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(app.getPath('userData'), 'db-backup');
    const target = path.join(dir, `vault-${stamp}.db`);
    db.backupTo(target);
    await shell.showItemInFolder(target);
    return { ok: true, path: target };
  });

  // 返回当前入库目录的实际情况（供设置页显示）
  ipcMain.handle('storage:info', async () => {
    const dir = VAULT_FILES_DIR();
    const copies = state.files.filter((f) => f.storage === 'copy');
    let bytes = 0;
    for (const f of copies) {
      try { bytes += fs.statSync(f.path).size; } catch { /* 忽略 */ }
    }
    return {
      dir,
      custom: !!state.settings.storeDir,
      count: copies.length,
      bytes,
      exists: fs.existsSync(dir),
    };
  });

  // 保存文本类文件（原地写回，写前备份）
  /**
   * 重命名文件，并同步改磁盘上的真实文件名。
   *
   * 这个库只登记路径、不搬文件，所以「改名」必须真的去改原文件，
   * 否则下次刷新记录就对不上了。几个细节：
   *  - 用户只写主名（不含扩展名）时，自动沿用原来的扩展名；
   *  - 目标已存在就报错，绝不覆盖别人的文件；
   *  - 文件被别的程序占用时 rename 会失败，把原因原样带出去。
   */
  ipcMain.handle('file:rename', async (_e, { id, name }) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');

    let next = String(name || '').trim();
    if (!next) throw new Error('文件名不能为空');
    if (/[\\/:*?"<>|]/.test(next)) {
      throw new Error('文件名不能包含 \\ / : * ? " < > | 这些字符');
    }
    if (/[. ]$/.test(next)) {
      throw new Error('文件名不能以点或空格结尾');
    }

    const oldPath = f.path;
    if (!fs.existsSync(oldPath)) {
      throw new Error('原文件已不在原位置，无法重命名。可以先「重新定位」再改名');
    }

    // 只改主名时自动补回扩展名，避免手滑把 .py 弄丢变成无类型文件
    const oldExt = path.extname(oldPath);
    if (oldExt && !path.extname(next)) next += oldExt;

    // 和同目录里其他记录撞名（对方的磁盘文件在别的位置）时按
    // （1）（2）顺延，磁盘上的新名字跟着用顺延后的（全软件统一
    // 的重名处理）；自己原来的名字不算撞名。
    {
      const taken = takenNamesIn(f.courseId || null);
      taken.delete(f.name);
      next = dedupeName(next, taken, true);
    }

    const dir = path.dirname(oldPath);
    const target = path.join(dir, next);
    if (path.resolve(target) === path.resolve(oldPath)) {
      return { state: snapshot(), changed: false };
    }
    if (fs.existsSync(target)) {
      throw new Error(`「${next}」已经存在，换一个名字吧`);
    }

    /* 写时复制：这个磁盘文件还有别的记录在共用时，不能真把
     * 原件改名 —— 那会把别的记录的路径一起改失效。改为把
     * 原件复制一份到新名字，只让当前记录指向新文件，原件
     * 留给其他记录。没被共享时照旧真改名。 */
    const shared = f.storage !== 'copy' && state.files.some(
      (x) => x.id !== f.id && x.storage !== 'copy' && x.path
        && path.resolve(x.path) === path.resolve(oldPath),
    );
    try {
      if (shared) await fsp.copyFile(oldPath, target);
      else await fsp.rename(oldPath, target);
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        throw new Error('这个文件正被其他程序占用，先关掉它再重命名');
      }
      if (err.code === 'EXDEV') {
        throw new Error('不能跨磁盘重命名');
      }
      throw new Error(`重命名失败：${err.message}`);
    }

    const st = await fsp.stat(target);
    f.name = next;
    f.ext = path.extname(next).toLowerCase();
    f.path = target;
    f.size = st.size;
    f.mtime = st.mtimeMs;
    invalidateStat(oldPath);
    invalidateStat(target);
    previewCache.delete(f.id);

    saveStateNow();
    return { state: snapshot(), changed: true, name: next, forked: shared };
  });

  ipcMain.handle('file:saveText', async (_e, { id, text }) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');
    if (!fs.existsSync(f.path)) throw new Error('原文件已不存在，无法保存');

    const kind = kindOf(f.ext);
    if (kind !== 'code' && kind !== 'markdown' && kind !== 'text') {
      throw new Error('该格式不支持内置编辑');
    }

    // 写时复制：和别的记录共用同一个磁盘文件时，先分叉再写，
    // 免得改这一条把另一条的内容也改了。分叉后下面的备份和
    // 写入都对着副本走，备份内容仍是改动前的版本。
    const forked = await forkIfShared(f);

    // 备份一份，避免手滑丢失
    const backupDir = path.join(app.getPath('userData'), 'backups');
    await fsp.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(f.path, path.join(backupDir, `${f.id}_${stamp}${f.ext}`));

    await fsp.writeFile(f.path, text, 'utf8');
    const st = await fsp.stat(f.path);
    f.size = st.size;
    f.mtime = st.mtimeMs;
    invalidateStat(f.path); // 刚写过，缓存里的大小/时间已过期
    previewCache.delete(f.id); // 预览也作废，否则重看还是旧内容
    saveStateNow();
    return { ok: true, state: snapshot(), forked };
  });

  /**
   * 保存图片编辑结果（旋转 / 裁剪 / 画笔 / 马赛克 / 橡皮）。
   *
   * 和 saveText 一个套路：先备份旧版本，再覆盖原文件 —— 用户要的就是
   * 「编辑完同步到本地文件」，而不是另存一份。
   *
   * 必须按扩展名校验格式：画布只能编码 png / jpeg / webp 三种。
   * 如果放任前端把 PNG 字节写进 .gif，文件头对不上扩展名，双击就打不开了。
   * 所以这里不猜、不转换，格式不支持就明确报错，让前端别显示编辑入口。
   */
  ipcMain.handle('file:saveImage', async (_e, { id, mime, data }) => {
    const f = findFile(id);
    if (!f) throw new Error('文件不存在');
    if (!fs.existsSync(f.path)) throw new Error('原文件已不存在，无法保存');

    if (kindOf(f.ext) !== 'image') throw new Error('该文件不是图片');

    const EXPECT = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    };
    const want = EXPECT[String(f.ext || '').toLowerCase()];
    if (!want) throw new Error(`这种图片格式不支持内置编辑（${f.ext || '未知扩展名'}）`);
    if (mime && mime !== want) throw new Error('图片格式和文件扩展名不匹配');

    /* Uint8Array 经 IPC 过来会变成 Buffer 或普通对象，两种都接 */
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!buf.length) throw new Error('没有收到图片数据');
    if (buf.length > 200 * 1024 * 1024) throw new Error('图片数据过大，无法保存');

    // 写时复制：同 saveText，共用同一磁盘文件时先分叉再写。
    const forked = await forkIfShared(f);

    // 备份一份，和文本编辑保持一致（旧版本都在「编辑备份」里）
    const backupDir = path.join(app.getPath('userData'), 'backups');
    await fsp.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(f.path, path.join(backupDir, `${f.id}_${stamp}${f.ext}`));

    await fsp.writeFile(f.path, buf);
    const st = await fsp.stat(f.path);
    f.size = st.size;
    f.mtime = st.mtimeMs;
    invalidateStat(f.path);
    previewCache.delete(f.id); // 预览缓存里还是旧图，必须作废
    saveStateNow();
    return { ok: true, state: snapshot(), size: f.size, forked };
  });

  // 用系统默认程序打开编辑（Office / WPS 等）
  ipcMain.handle('file:openEditor', async (_e, id) => {
    const f = findFile(id);
    if (!f || !fs.existsSync(f.path)) throw new Error('文件不存在');
    const err = await shell.openPath(f.path);
    if (err) throw new Error(err);
    return true;
  });

  ipcMain.handle('file:reveal', (_e, id) => {
    const f = findFile(id);
    if (!f || !fs.existsSync(f.path)) throw new Error('文件不存在');
    shell.showItemInFolder(f.path);
    return true;
  });

  ipcMain.handle('file:openExternal', async (_e, id) => {
    const f = findFile(id);
    if (!f || !fs.existsSync(f.path)) throw new Error('文件不存在');
    const err = await shell.openPath(f.path);
    if (err) throw new Error(err);
    return true;
  });

  /**
   * 用指定程序打开 / 运行文件。
   * program 为空时用设置里的默认程序（默认 VS Code），找不到就退回系统关联程序。
   *
   * mode 为 'project' 时，如果这个文件属于某个项目（往上找得到
   * package.json / .git / requirements.txt 之类），就把**整个项目文件夹**
   * 交给程序，而不是只丢一个孤零零的文件进去 —— 只开单文件的话，
   * 同目录的兄弟模块、venv、node_modules 全都不在作用域里，
   * 跑起来就报「找不到依赖库」。
   */
  ipcMain.handle('file:run', async (_e, { id, program, mode }) => {
    const f = findFile(id);
    if (!f || !fs.existsSync(f.path)) throw new Error('文件不存在');

    const target = program || state.settings.defaultEditor || 'vscode';
    const exe = resolveProgram(target);

    // 要按项目打开，但没找到项目根 → 退回按文件打开，不报错
    let projectRoot = null;
    if (mode === 'project') projectRoot = findProjectRoot(f.path);

    if (!exe) {
      // 没有 VS Code 之类，就交给系统默认关联程序
      const err = await shell.openPath(f.path);
      if (err) throw new Error(`${target} 没找到，系统默认程序也打不开：${err}`);
      return { opened: 'system', arg: f.path };
    }

    /* 两个模式，由用户在「打开方式」的二级菜单里自己选。
     *
     *   project 模式（打开整个项目）：把**项目根目录**交给编辑器，
     *     等价于在终端里敲 `code .`。编辑器会载入整个工作区，
     *     依赖解析、跳转、调试配置才都能用。
     *   file 模式（单独打开这个文件）：只给文件，最快。
     *
     * VS Code 系（含 Cursor / Trae / Windsurf 这些 fork）都带 -r（复用最近
     * 的窗口），已经开着就切过去、没开就新开。其它编辑器只给目标路径。
     *
     * 走过两条弯路，记录在这里，别再回去了：
     *   1. 只传文件 → 项目已经在该编辑器里打开时，编辑器认为「没必要动」，
     *      用户看到的是点了没反应。-r 解决了这个。
     *   2. 以前是**自动**判定项目、无条件把「目录 + 文件」塞给所有程序：
     *      记事本这类只认一个参数的直接打不开；VS Code 收到「目录和文件
     *      两个参数」也会跑偏。现在项目模式只在用户明确点了
     *      「打开整个项目」时启用，而且**只传目录、不夹带文件**。 */
    const targets = projectRoot
      ? (isCodeLikeEditor(exe) ? ['-r', projectRoot] : [projectRoot])
      : (isCodeLikeEditor(exe) ? ['-r', f.path] : [f.path]);

    try {
      await launchFile(exe, targets);
    } catch (err) {
      /* 指定程序起不来（路径失效、被系统拦下…）：退回系统默认关联，
         至少给用户一个能用的窗口，而不是「点了没反应」 */
      console.error('[run] 启动失败，改用系统默认程序:', exe, err.message);
      const msg = await shell.openPath(f.path);
      if (msg) {
        throw new Error(`${path.basename(exe)} 启动失败：${err.message}；系统默认程序也打不开：${msg}`);
      }
      return { opened: 'system', arg: f.path, fallbackFrom: exe };
    }
    return { opened: target, exe, arg: projectRoot || f.path, projectRoot };
  });

  /**
   * 查询一个文件属于哪个项目。找不到返回 null。
   * 前端拿它来决定「打开方式」里的条目该开文件还是开整个项目。
   */
  ipcMain.handle('file:project', (_e, id) => {
    const f = findFile(id);
    if (!f || !f.path) return null;
    const root = findProjectRoot(f.path);
    if (!root) return null;
    return {
      root,
      name: path.basename(root),
      // 文件本来就在项目根这一层时没必要强调「整个项目」
      isRoot: path.dirname(path.resolve(f.path)) === path.resolve(root),
    };
  });

  /**
   * 查一个目录属于哪个项目。
   *
   * 目录没有「文件路径」，拿 `<dir>/_` 骗一下 findProjectRoot，
   * 让它从这个目录本身开始往上找（它内部会先 dirname 一次）。
   * 前端用它决定「用其他软件打开」要不要给「打开整个项目」这一项。
   */
  ipcMain.handle('course:project', (_e, id) => {
    const course = state.courses.find((c) => c.id === id);
    if (!course) return null;
    const dir = courseDirOf(course);
    if (!dir) return null;
    const root = findProjectRoot(path.join(dir, '_'));
    if (!root) return null;
    return {
      root,
      name: path.basename(root),
      isRoot: path.resolve(dir) === path.resolve(root),
    };
  });

  /**
   * 用指定程序打开一个「目录」。
   * 目录位置由 courseDirOf 解析：导入来的有 sourcePath，手工建的
   * 就从它下面的文件路径推公共前缀。实在推不出来才报错。
   *
   * mode: 'project' 时改开项目根 —— 用户点的是 src/ 这种子目录，
   * 但编辑器以子目录为工作区看不到同级的依赖和配置。
   */
  ipcMain.handle('course:run', async (_e, { id, program, mode }) => {
    const course = state.courses.find((c) => c.id === id);
    if (!course) throw new Error('目录不存在');

    let dir = courseDirOf(course);
    if (!dir) {
      throw new Error('这个目录没有对应的磁盘文件夹（里面还没有来自磁盘的文件）');
    }

    if (mode === 'project') {
      const root = findProjectRoot(path.join(dir, '_'));
      if (root) dir = root;
    }

    const target = program || state.settings.defaultEditor || 'vscode';
    const exe = resolveProgram(target);
    if (!exe) {
      const err = await shell.openPath(dir);
      if (err) throw new Error(`${target} 没找到，系统默认程序也打不开：${err}`);
      return { opened: 'system', dir };
    }
    try {
      await launchFile(exe, dir);
    } catch (err) {
      console.error('[run] 启动失败，改用系统默认程序:', exe, err.message);
      const sub = await shell.openPath(dir);
      if (sub) {
        throw new Error(`${path.basename(exe)} 启动失败：${err.message}；系统默认程序也打不开：${sub}`);
      }
      return { opened: 'system', dir, fallbackFrom: exe };
    }
    return { opened: target, exe, dir };
  });

  /** 查询一个目录在磁盘上的位置（右键菜单要拿它决定是否可用） */
  ipcMain.handle('course:dir', (_e, id) => {
    const course = state.courses.find((c) => c.id === id);
    if (!course) return { dir: null };
    return { dir: courseDirOf(course) };
  });

  /** 在资源管理器里打开这个目录（文件夹版的「在文件夹中显示」） */
  ipcMain.handle('course:reveal', async (_e, id) => {
    const course = state.courses.find((c) => c.id === id);
    if (!course) throw new Error('目录不存在');
    const dir = courseDirOf(course);
    if (!dir) {
      throw new Error('这个目录没有对应的磁盘文件夹（里面还没有来自磁盘的文件）');
    }
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  });

  /**
   * 列出「这个扩展名可以用哪些程序打开」。
   *
   * Windows 把「打开方式」候选存在注册表
   *   HKCU\...\Explorer\FileExts\<ext>\OpenWithList
   * 里面是 exe 文件名（不是完整路径），再配合 HKCR\Applications\<exe>
   * 的 FriendlyAppName 拿到人类可读的名字。
   * 这样列出来的就是系统自己认为能开这个类型的程序，
   * 比让用户去文件对话框里翻目录好得多。
   */
  // 同一个扩展名的候选程序结果缓存 10 分钟。
  // 起 PowerShell 要半秒左右，菜单点开两次不该等两遍。
  const assocCache = new Map();
  const ASSOC_TTL = 10 * 60 * 1000;

  ipcMain.handle('editor:forFile', async (_e, { id }) => {
    const f = findFile(id);
    if (!f) return [];
    const ext = String(f.ext || '').toLowerCase();
    if (!ext || process.platform !== 'win32') return [];

    const cached = assocCache.get(ext);
    if (cached && Date.now() - cached.at < ASSOC_TTL) return cached.list;

    try {
      const ps = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ext = '${ext.replace(/'/g, "''")}'

$cands = New-Object System.Collections.ArrayList
$seen = @{}

function Get-ExeFromCmd($cmd) {
  if (-not $cmd) { return '' }
  if ($cmd -match '^\\s*"([^"]+\\.exe)"') { return $matches[1] }
  if ($cmd -match '^\\s*([^\\s"]+\\.exe)') { return $matches[1] }
  return ''
}

function Add-Cand($exe, $path, $name, $isDefault) {
  if (-not $exe) { return }
  $k = $exe.ToLower()
  if ($seen.ContainsKey($k)) {
    if ($isDefault) { $seen[$k].default = $true }
    # 后来的调用可能拿到了更好看的名字，补上
    if ($name -and -not $seen[$k].name) { $seen[$k].name = $name }
    return
  }
  $o = [PSCustomObject]@{ exe = $exe; path = $path; name = $name; default = [bool]$isDefault }
  $seen[$k] = $o
  [void]$cands.Add($o)
}

# 从 exe 的版本信息里取可读名字。
# 注意 FriendlyAppName 有时是 MUI 资源引用（形如 "@C:\\...\\oregres.dll,-205"），
# 那种不能直接显示，得跳过。
function Get-PrettyName($full) {
  if (-not $full -or -not (Test-Path $full)) { return '' }
  $vi = (Get-Item $full).VersionInfo
  if ($vi.FileDescription) { return $vi.FileDescription.Trim() }
  if ($vi.ProductName) { return $vi.ProductName.Trim() }
  return ''
}

function Resolve-App($exe, $isDefault) {
  if (-not $exe) { return }
  $exe = $exe.Trim()
  if (-not $exe) { return }
  $name = ''
  $full = ''
  $appKey = "Registry::HKEY_CLASSES_ROOT\\Applications\\$exe"
  if (Test-Path $appKey) {
    $fn = (Get-ItemProperty $appKey).FriendlyAppName
    # 以 @ 开头的是资源引用，不是给人看的文字
    if ($fn -and -not $fn.StartsWith('@')) { $name = $fn }
    $full = Get-ExeFromCmd (Get-ItemProperty "$appKey\\shell\\open\\command").'(default)'
  }
  if (-not $full) {
    foreach ($h in @('HKCU', 'HKLM')) {
      $ap = "Registry::$h\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe"
      if (Test-Path $ap) {
        $v = (Get-ItemProperty $ap).'(default)'
        if ($v) { $full = $v.Trim('"'); break }
      }
    }
  }
  # 注册表没写友好名时，读 exe 自己的版本信息 —— 这个最准，
  # 比如 Code.exe 的 FileDescription 就是 "Visual Studio Code"，
  # 比拿文件名当标题好看得多。
  if (-not $name) { $name = Get-PrettyName $full }
  Add-Cand $exe $full $name $isDefault
}

function Scan-OpenWithList($key) {
  if (-not (Test-Path $key)) { return }
  $p = Get-ItemProperty $key
  foreach ($n in $p.PSObject.Properties) {
    if ($n.Name -match '^[a-z]$' -and $n.Value) { Resolve-App $n.Value $false }
  }
}

# 1) 用户为这个扩展名手动选过的程序
Scan-OpenWithList "Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$ext\\OpenWithList"
# 2) 系统给这一类文件登记的程序
Scan-OpenWithList "Registry::HKEY_CLASSES_ROOT\\SystemFileAssociations\\$ext\\OpenWithList"

# 3) 默认关联的 ProgId（标记成默认）
$progId = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\$ext").'(default)'
if ($progId) {
  $exePath = Get-ExeFromCmd (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\$progId\\shell\\open\\command").'(default)'
  if ($exePath) {
    $leaf = Split-Path $exePath -Leaf
    $nice = Get-PrettyName $exePath
    Add-Cand $leaf $exePath $nice $true
  }
}

# 4) 其他登记了能打开这类文件的 ProgId
$owp = "Registry::HKEY_CLASSES_ROOT\\$ext\\OpenWithProgids"
if (Test-Path $owp) {
  foreach ($n in (Get-ItemProperty $owp).PSObject.Properties) {
    if ($n.Name -eq '(default)' -or $n.Name -eq 'PSPath' -or $n.Name -eq 'PSParentPath' -or $n.Name -eq 'PSChildName' -or $n.Name -eq 'PSDrive' -or $n.Name -eq 'PSProvider') { continue }
    $exePath = Get-ExeFromCmd (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\$($n.Name)\\shell\\open\\command").'(default)'
    if ($exePath) {
      $leaf = Split-Path $exePath -Leaf
      $nice = Get-PrettyName $exePath
      Add-Cand $leaf $exePath $nice $false
    }
  }
}

@($cands) | ConvertTo-Json -Compress
`;

      // 用 -EncodedCommand 传脚本，免去所有引号/反斜杠转义问题。
      // 必须用异步的 execFile：execFileSync 会把主进程（连同界面）一起卡住，
      // PowerShell 首次启动要 1 秒以上，用同步版会明显卡顿甚至假死。
      const encoded = Buffer.from(ps, 'utf16le').toString('base64');
      const raw = await new Promise((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { encoding: 'utf8', timeout: 6000, windowsHide: true },
          (err, stdout) => resolve(err && !stdout ? '' : stdout),
        );
      });
      const trimmed = String(raw || '').trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : [parsed];

      const out = [];
      const usedPaths = new Set();
      for (const item of list) {
        // 优先用注册表里的完整路径；没有就按 exe 名去 PATH 里找
        let exePath = item.path && fs.existsSync(item.path) ? item.path : findInPath(item.exe);
        if (!exePath || !fs.existsSync(exePath)) continue;
        const lower = exePath.toLowerCase();
        if (usedPaths.has(lower)) continue;
        usedPaths.add(lower);
        out.push({
          label: item.name || path.basename(exePath, path.extname(exePath)),
          exe: exePath,
          key: 'custom',
          isDefault: !!item.default,
        });
      }
      // 默认程序排最前
      out.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
      assocCache.set(ext, { at: Date.now(), list: out });
      return out;
    } catch {
      return [];
    }
  });

  /**
   * 列出「能用文件夹当参数打开」的程序。
   *
   * 文件夹没有扩展名，所以不能用 editor:forFile 那套 FileExts 逻辑。
   * Windows 把「右键文件夹 → 打开方式 / 用 XX 打开」登记在
   *   HKCR\Directory\shell\<verb>\command
   *   HKCU\...\Explorer\FileExts\Directory\OpenWithList
   *   HKCR\Directory\OpenWithProgids
   * 这里把这三处扫一遍，再**筛掉非编辑器**：7-Zip、WinRAR、Everything
   * 之类虽然也登记了文件夹菜单，但把项目目录丢给它们毫无意义。
   * 筛选靠关键字，宁可少列也别让菜单里塞满用不上的东西。
   */
  const dirAssocCache = { at: 0, list: null };
  const DIR_ASSOC_TTL = 10 * 60 * 1000;

  // 名字里带这些词的才算「能打开项目的程序」
  const DIR_APP_HINT = /(code|cursor|windsurf|trae|studio|idea|pycharm|webstorm|goland|clion|rider|phpstorm|rubymine|datagrip|rustrover|fleet|zed|sublime|notepad|atom|brackets|hbuilder|eclipse|emacs|vim|nvim|geany|editor|editplus|ultraedit|textpad|komodo|qt\s*creator|devenv|git\s*bash|cmder|windows\s*terminal|terminal|conemu|tabby|hyper)/i;

  ipcMain.handle('editor:forDir', async () => {
    if (process.platform !== 'win32') return [];
    if (dirAssocCache.list && Date.now() - dirAssocCache.at < DIR_ASSOC_TTL) {
      return dirAssocCache.list;
    }

    try {
      const ps = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cands = New-Object System.Collections.ArrayList
$seen = @{}

function Get-ExeFromCmd($cmd) {
  if (-not $cmd) { return '' }
  if ($cmd -match '^\\s*"([^"]+\\.exe)"') { return $matches[1] }
  if ($cmd -match '^\\s*([^\\s"]+\\.exe)') { return $matches[1] }
  return ''
}

function Get-PrettyName($full) {
  if (-not $full -or -not (Test-Path $full)) { return '' }
  $vi = (Get-Item $full).VersionInfo
  if ($vi.FileDescription) { return $vi.FileDescription.Trim() }
  if ($vi.ProductName) { return $vi.ProductName.Trim() }
  return ''
}

function Add-Cand($exe, $path, $name, $label) {
  if (-not $exe) { return }
  $k = $exe.ToLower()
  if ($seen.ContainsKey($k)) {
    if (-not $seen[$k].name -and $name) { $seen[$k].name = $name }
    if (-not $seen[$k].label -and $label) { $seen[$k].label = $label }
    return
  }
  $o = [PSCustomObject]@{ exe = $exe; path = $path; name = $name; label = $label }
  $seen[$k] = $o
  [void]$cands.Add($o)
}

# 1) HKCR\Directory\shell 下登记的所有动词
$shellRoots = @(
  'Registry::HKEY_CLASSES_ROOT\\Directory\\shell',
  'Registry::HKEY_CLASSES_ROOT\\Folder\\shell'
)
foreach ($root in $shellRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($sub in (Get-ChildItem $root)) {
    # 跳过系统自带的那些动词（find / print / runas / cmd 之类）
    $verb = $sub.PSChildName
    if ($verb -match '^(open|find|print|printto|runas|cmd|pintohome|library|addtoplaylist|cast)$') { continue }
    $cmd = (Get-ItemProperty "$($sub.PSPath)\\command").'(default)'
    $exePath = Get-ExeFromCmd $cmd
    if (-not $exePath) { continue }
    $leaf = Split-Path $exePath -Leaf
    $nice = Get-PrettyName $exePath
    $label = (Get-ItemProperty $sub.PSPath).'(default)'
    # 动词的显示名常带 & 加速键，去掉
    if ($label) { $label = $label -replace '&', '' }
    Add-Cand $leaf $exePath $nice $label
  }
}

# 2) 用户为「文件夹」这个伪扩展名选过的程序
$k = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\Directory\\OpenWithList'
if (Test-Path $k) {
  $p = Get-ItemProperty $k
  foreach ($n in $p.PSObject.Properties) {
    if ($n.Name -match '^[a-z]$' -and $n.Value) { Add-Cand $n.Value '' '' '' }
  }
}

# 3) 登记了能打开文件夹的 ProgId
$owp = 'Registry::HKEY_CLASSES_ROOT\\Directory\\OpenWithProgids'
if (Test-Path $owp) {
  foreach ($n in (Get-ItemProperty $owp).PSObject.Properties) {
    if ($n.Name -eq '(default)' -or $n.Name -like 'PS*') { continue }
    $exePath = Get-ExeFromCmd (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\$($n.Name)\\shell\\open\\command").'(default)'
    if ($exePath) {
      Add-Cand (Split-Path $exePath -Leaf) $exePath (Get-PrettyName $exePath) ''
    }
  }
}

@($cands) | ConvertTo-Json -Compress
`;

      const encoded = Buffer.from(ps, 'utf16le').toString('base64');
      const raw = await new Promise((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { encoding: 'utf8', timeout: 6000, windowsHide: true },
          (err, stdout) => resolve(err && !stdout ? '' : stdout),
        );
      });
      const trimmed = String(raw || '').trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : [parsed];

      const out = [];
      const usedPaths = new Set();
      for (const item of list) {
        let exePath = item.path && fs.existsSync(item.path) ? item.path : findInPath(item.exe);
        if (!exePath || !fs.existsSync(exePath)) continue;
        const lower = exePath.toLowerCase();
        if (usedPaths.has(lower)) continue;

        const label = String(item.label || item.name || '').trim()
          || path.basename(exePath, path.extname(exePath));
        // 只留看起来像「能打开项目」的程序
        if (!DIR_APP_HINT.test(label) && !DIR_APP_HINT.test(item.exe || '')) continue;

        usedPaths.add(lower);
        out.push({ label, exe: exePath, key: 'custom', isDefault: false });
      }
      dirAssocCache.at = Date.now();
      dirAssocCache.list = out;
      return out;
    } catch {
      return [];
    }
  });

  /** 列出本机装了哪些可用的编辑器，前端用它渲染「打开方式」菜单 */
  ipcMain.handle('editor:list', () => {
    const LABELS = {
      vscode: 'VS Code',
      cursor: 'Cursor',
      notepadpp: 'Notepad++',
      sublime: 'Sublime Text',
      notepad: '记事本',
      explorer: '资源管理器',
    };
    return Object.keys(LABELS).map((key) => {
      const exe = resolveProgram(key);
      // CLI 别名可能指向 code.CMD，而注册表里登记的是 Code.exe。
      // 再给一个 guiExe 用来跟「系统候选程序」做去重，避免同一程序出现两遍。
      let guiExe = exe;
      if (exe && /\.(cmd|bat)$/i.test(exe) && PROGRAM_PRESETS[key]) {
        guiExe = PROGRAM_PRESETS[key].find((p) => p && fs.existsSync(p)) || exe;
      }
      return { key, label: LABELS[key], available: !!exe, exe: exe || null, guiExe: guiExe || null };
    });
  });

  /** 让用户从磁盘里挑一个程序，记住它作为某类文件的默认打开方式 */
  ipcMain.handle('file:pickProgram', async (_e, { id }) => {
    const f = findFile(id);
    const label = f ? `${f.name} 用什么程序打开` : '选择程序';
    const res = await dialog.showOpenDialog(win, {
      title: label,
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: '程序', extensions: ['exe', 'bat', 'cmd'] }]
        : undefined,
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  // 换课程只改归属，文件不动
  ipcMain.handle('file:moveToCourse', async (_e, { id, courseId }) => {
    const f = findFile(id);
    const course = state.courses.find((c) => c.id === courseId);
    if (!f || !course) throw new Error('文件或课程不存在');
    f.courseId = courseId;
    saveStateNow();
    return snapshot();
  });

  /* --- 批量操作 --- */
  ipcMain.handle('files:removeMany', async (_e, { ids, trash }) => {
    const list = (ids || []).map((id) => findFile(id)).filter(Boolean);
    if (!list.length) return snapshot();

    if (trash) {
      await moveToTrash({ fileIds: list.map((f) => f.id) });
      return snapshot();
    }

    await removeCopies(list);
    const doomed = new Set(list.map((f) => f.id));
    state.files = state.files.filter((f) => !doomed.has(f.id));
    saveStateNow();
    return snapshot();
  });

  /**
   * 在目标目录下复制一批记录。
   *
   * 这个软件只登记路径、不搬磁盘文件，所以「复制」复制的是库里的记录：
   * 同一个磁盘文件可以在多个目录下各有一条记录，磁盘上始终只有一份。
   * 目录则连同子孙一起复制成新的虚拟目录（同样只是记录）。
   */
  ipcMain.handle('files:copyMany', (_e, { ids, dirIds, courseId }) => {
    const destId = courseId || null;
    if (destId && !state.courses.some((c) => c.id === destId)) {
      throw new Error('目标目录不存在');
    }

    let copied = 0;
    // 粘贴也是「新增」：与目标目录已有项重名的副本改名 原名（1）（2）…
    // 文件与文件夹共用一份占用集合，同一批粘贴内依次避让
    // （2026-11-18 用户定版，与新建/导入同一套规则）。
    const taken = takenNamesIn(destId);
    for (const id of ids || []) {
      const src = findFile(id);
      if (!src) continue;
      state.files.push({
        ...src,
        id: uid(),
        courseId: destId,
        name: dedupeName(src.name, taken, true),
        addedAt: Date.now(),
      });
      copied += 1;
    }

    // 目录：整棵子树一起复制，父子关系在新拷贝里重建。
    // 先把原子树拍成快照再往 state 里推，避免边遍历边修改数组。
    for (const id of dirIds || []) {
      const root = state.courses.find((c) => c.id === id);
      if (!root) continue;

      // 1) 收集原子树（含自己）的所有目录节点
      const subtree = [];
      const stack = [id];
      const visited = new Set();
      while (stack.length) {
        const cur = stack.pop();
        if (visited.has(cur)) continue;
        visited.add(cur);
        const node = state.courses.find((c) => c.id === cur);
        if (!node) continue;
        subtree.push(node);
        for (const kid of state.courses.filter((c) => c.parentId === cur)) {
          stack.push(kid.id);
        }
      }

      // 2) 原子树里每个目录下的文件（快照）
      const filesInSubtree = state.files.filter((f) => visited.has(f.courseId));

      // 3) 建新节点，记录 旧id → 新id
      const idMap = new Map();
      for (const node of subtree) idMap.set(node.id, uid());
      for (const node of subtree) {
        const copy = { ...node, id: idMap.get(node.id) };
        copy.parentId = node.id === id ? destId : idMap.get(node.parentId);
        // 只有子树根落在目标目录这一层，需要按（1）（2）避让重名；
        // 子目录都挂在全新的父目录下，名字不会撞，保持原名。
        if (node.id === id) copy.name = dedupeName(node.name, taken, false);
        delete copy.fileCount;
        delete copy.totalCount;
        delete copy.childCount;
        state.courses.push(copy);
      }

      // 4) 文件记录也跟着复制一份挂到对应新目录
      for (const f of filesInSubtree) {
        state.files.push({
          ...f,
          id: uid(),
          courseId: idMap.get(f.courseId),
          addedAt: Date.now(),
        });
        copied += 1;
      }
      copied += 1;
    }

    if (copied) saveStateNow();
    return { copied, state: snapshot() };
  });

  ipcMain.handle('files:moveMany', (_e, { ids, courseId }) => {
    /* courseId 为 null 表示「移到顶层」—— 文件不属于任何目录，
     * 在「全部文件」里直接平铺显示。拖到侧栏「全部文件」、
     * 或拖到网格空白处都是这个语义。
     *
     * 以前这里无条件要求目录存在，导致「拖到空白处」和右键菜单里的
     * 「全部文件（顶层）」对文件一律报「目录不存在」。 */
    const target = courseId || null;
    if (target && !state.courses.some((c) => c.id === target)) {
      throw new Error('目录不存在');
    }
    const set = new Set(ids || []);
    let moved = 0;
    // 移入的目录里已有同名项时按（1）（2）顺延（全软件统一的
    // 重名处理）；本来就在目标目录里的文件不算新撞名，名字不动。
    const taken = takenNamesIn(target);
    for (const f of state.files) {
      if (set.has(f.id)) {
        if ((f.courseId || null) !== target) {
          f.name = dedupeName(f.name, taken, true);
          f.courseId = target;
        }
        moved += 1;
      }
    }
    if (moved) saveStateNow();
    return { moved, state: snapshot() };
  });

  /* --- 设置 --- */
  ipcMain.handle('settings:set', (_e, patch) => {
    state.settings = { ...state.settings, ...patch };
    saveStateNow();
    /* 自动检测的开关和频率就存在设置里，改完立刻按新设置重排。
     * 用户刚打开开关时希望马上看到结果，所以首次延迟缩短。 */
    if ('autoCheckUpdate' in patch || 'autoCheckInterval' in patch) {
      scheduleAutoCheck(1200);
    }
    return snapshot();
  });

  ipcMain.handle('library:openBackups', async () => {
    const dir = path.join(app.getPath('userData'), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  });

  ipcMain.handle('data:openDir', async () => {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  });

  /* --- 系统集成 --- */
  ipcMain.handle('win:minimize', () => win?.minimize());
  ipcMain.handle('win:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('win:close', () => win?.close());

  // 窗口按钮由页面自己画，标题栏颜色跟着 CSS 变量走，这里无需再同步原生配色。
  // 保留这个 IPC 只是为了不破坏旧版渲染层的调用。
  ipcMain.handle('win:setTitlebarTheme', (_e, name) => {
    if (!win) return false;
    try {
      if (typeof win.setTitleBarOverlay === 'function') {
        const dark = name === 'dark';
        win.setTitleBarOverlay({
          color: dark ? '#14161b' : '#faf9f5',
          symbolColor: dark ? '#aab3c0' : '#57544d',
          height: 46,
        });
      }
      return true;
    } catch {
      return false;
    }
  });

  /* --- 软件更新 --- */
  ipcMain.handle('update:info', () => {
    const cfg = loadUpdateConfig();
    return {
      version: readVersion(),
      appDir: APP_DIR,
      dataDir: app.getPath('userData'),
      sourceDir: SOURCE_DIR,
      packaged: app.isPackaged,
      // 自动检测的上次时间和留存结果：关于页靠它们把提醒条摆出来，
      // 不必等下一次实时推送（见 app.js 的 restoreAutoUpdate）
      lastCheckAt: Number(cfg.lastCheckAt) || 0,
      autoResult: cfg.lastResult || null,
      // 本次运行是否已经检测过一轮、眼下有没有一轮到期未跑：关于页
      // 靠这两个判断留存结果能不能直接拿去弹窗（见 restoreAutoUpdate）
      sessionChecked: autoSessionChecked,
      checkDue: autoCheckDueIn() === 0,
    };
  });

  ipcMain.handle('update:check', () => {
    const d = checkForUpdate();
    // 手动检测也算「检测过」：自动检测的到期判断从这一次重新计时
    stampCheck(d);
    return d;
  });

  ipcMain.handle('update:apply', () => {
    const r = applyUpdate();
    /* 刚应用完，留存的自动检测结果已经过期（写的还是应用前那批
     * 改动），清掉免得下次打开关于又拿它弹窗、数目和实际对不上。
     * apply 失败是抛错的，能走到这里就是应用成功了。 */
    try { saveUpdateConfig({ lastResult: null }); } catch { /* 清理失败不影响应用本身 */ }
    return r;
  });

  ipcMain.handle('update:pickSource', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择开发目录（改代码的地方）',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    saveSourceDir(res.filePaths[0]);
    return checkForUpdate();
  });

  /* --- 文件夹封面（独立模块，独立存储） --- */
  folderCover.register({
    ipcMain,
    app,
    getCourses: () => state?.courses || [],
  });

  /* --- 桌宠桌面模式（独立模块，外部窗口位置独立存储） --- */
  petMain.register({
    ipcMain,
    app,
    getWin: () => win,
  });

  /* --- 插件一：自动更新内容（对比文件指纹生成更新说明，见 src/changelog.js） --- */
  changelogMain.register({ ipcMain, app, getVersion: () => readVersion() });

  /* --- 插件二：发布助手（仅作者本机）。打包发布时本文件被排除，
   * require 失败就静默跳过，发布版里连门禁 IPC 都不存在 --- */
  try { require('./src/plugin2-main').register({ ipcMain, app }); } catch { /* 发布版不带插件二 */ }

  ipcMain.handle('update:restart', () => {
    /* 重启前必须把内存里的数据落盘。
     * 平时保存是 120ms 防抖的，直接 app.exit(0) 会跳过 before-quit 里那次
     * saveStateNow，用户刚改的东西就丢了。 */
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { saveStateNow(); } catch { /* 落盘失败也要继续重启 */ }
    try { db.close(); } catch { /* 忽略 */ }

    app.relaunch();
    app.exit(0);
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
app.whenReady().then(() => {
  /* 关掉 Electron 默认应用菜单：本应用是自绘标题栏、不用原生菜单，
   * 而默认菜单的「强制重新加载」占着 Ctrl+Shift+R，会把界面自己的
   * 「在文件夹中显示」快捷键顶掉（按下去变成刷新界面）。
   * 桌宠的右键菜单是 pet-main 里现搭现弹的，不走应用菜单，不受影响。 */
  Menu.setApplicationMenu(null);
  migrateOldUserData();
  loadState();
  /* 首屏这几秒先别去 stat 全库的文件：库里文件一多，成千上万次同步
     statSync 会把主进程占住一两秒，界面上的表现就是「窗口出来了，
     但什么都点不动」。这段时间先信记录里的信息，宽限期过后自然恢复真实值。 */
  statGraceUntil = Date.now() + 4000;
  /* 首屏出来之后，趁空闲把全库 stat 分片补进缓存（见 warmStatCache） */
  setTimeout(warmStatCache, 2500);
  loadSourceDir();

  // 首次运行写入版本号
  if (!fs.existsSync(VERSION_FILE())) writeVersion('1.0.0');

  /* 版本号按「成功更新次数」自愈：version.json 放在程序目录里，目录
   * 被重置/换位置时会被打回 1.0.0；但每次成功更新都在 userData 的
   * update-backup 里留了一份带时间戳的备份，份数就是成功更新的次数。
   * 版本比它低就补回来（只升不降，备份被手动删过也不会把版本改小） */
  try {
    const bakDir = path.join(app.getPath('userData'), 'update-backup');
    const applies = fs.readdirSync(bakDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
    const curParts = readVersion().split('.').map(Number);
    if (applies > (curParts[2] || 0)) writeVersion(`1.0.${applies}`);
  } catch { /* 没有备份目录 = 还没更新过，不处理 */ }

  // 登记协议处理器
  protocol.handle('vault', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'f') return new Response('Not found', { status: 404 });
      const id = url.pathname.replace(/^\//, '');
      const f = findFile(id);
      if (!f || !fs.existsSync(f.path)) return new Response('Not found', { status: 404 });

      const mime = MIME[f.ext] || 'application/octet-stream';
      const { size } = await fsp.stat(f.path);
      const headers = new Headers({
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        /* 图片编辑器要把原图读成 blob 再画到画布上（直接 drawImage 会
           污染画布，马赛克和保存都做不了）。页面是 file:// 源，vault://
           是另一个源，不加这条 fetch 会以「Failed to fetch」告终。
           这里放开的只是索引里登记过的文件，不是任意路径读取。 */
        'Access-Control-Allow-Origin': '*',
      });

      /* 必须真的按 Range 分段回 206：视频/音频 seek 时浏览器会带
         Range 头来取指定字节段。以前这里无视 Range、永远回整文件
         （200），嘴上却声明 Accept-Ranges —— 浏览器每次 seek 都被
         打回开头，表现就是按方向键、拖进度条永远回到起点（用户
         反复报的 bug，前几轮改播放器代码都没用，根子在这里）。 */
      let start = 0;
      let end = size - 1;
      let partial = false;
      const range = request.headers.get('range');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m && (m[1] || m[2])) {
          if (m[1] === '') {
            // bytes=-N：最后 N 字节
            const n = Math.min(size, parseInt(m[2], 10) || 0);
            start = Math.max(0, size - n);
            end = size - 1;
          } else {
            start = parseInt(m[1], 10);
            end = m[2] ? Math.min(size - 1, parseInt(m[2], 10)) : size - 1;
          }
          if (start > end || start >= size) {
            headers.set('Content-Range', `bytes */${size}`);
            return new Response(null, { status: 416, headers });
          }
          partial = true;
        }
      }
      headers.set('Content-Length', String(end - start + 1));
      if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      if (request.method === 'HEAD' || size === 0) {
        return new Response(null, { status: partial ? 206 : 200, headers });
      }
      const { Readable } = require('node:stream');
      const stream = Readable.toWeb(fs.createReadStream(f.path, { start, end }));
      return new Response(stream, { status: partial ? 206 : 200, headers });
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  });

  registerIpc();
  createWindow();
  /* 自动检测更新：启动后立刻按设置排第一次（delayFirst=0），
   * 用户打开关于时结果应该已经备好了（见 scheduleAutoCheck） */
  scheduleAutoCheck(0);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    saveStateNow();
  } catch {
    /* 退出阶段忽略 */
  }
  db.close();
});
