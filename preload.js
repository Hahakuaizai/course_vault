'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('vault', {
  bootstrap: () => invoke('app:bootstrap'),
  getState: () => invoke('state:get'),

  courses: {
    create: (name, color, parentId) => invoke('course:create', { name, color, parentId }),
    rename: (id, name) => invoke('course:rename', { id, name }),
    setColor: (id, color) => invoke('course:setColor', { id, color }),
    move: (id, parentId) => invoke('course:move', { id, parentId }),
    reorder: (parentId, orderedIds) => invoke('course:reorder', { parentId, orderedIds }),
    remove: (id, trash = true) => invoke('course:delete', { id, trash }),
    run: (id, program, mode) => invoke('course:run', { id, program, mode }),
    project: (id) => invoke('course:project', id),
    dir: (id) => invoke('course:dir', id),
    reveal: (id) => invoke('course:reveal', id),
  },

  /** 拖进来 / 粘贴进来的 File 对象 → 真实磁盘路径。
   *  Electron 32+ 起 File.path 被移除，必须走 webUtils。 */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  /**
   * 读剪贴板里的文件路径。
   *
   * Electron 45 的 clipboard 换成了 Blob 式新 API，readBuffer / CF_HDROP
   * 都拿不到了，所以退回「问系统」：用 PowerShell 的 Get-Clipboard
   * -Format FileDropList 读，这是 Windows 官方支持的读法。
   * 代价是每次约 200~400ms，但粘贴是低频操作，可以接受。
   */
  clipboard: {
    readFiles: () => invoke('clipboard:readFiles'),
    hasFiles: () => invoke('clipboard:hasFiles'),
  },

  files: {
    pickFiles: () => invoke('dialog:pickFiles'),
    pickFolder: () => invoke('dialog:pickFolder'),
    scan: (paths) => invoke('files:scan', { paths }),
    search: (payload) => invoke('files:search', payload),
    import: (paths, courseId, mode, dupMode, buildTree, nameOverride) => invoke(
      'files:import', { paths, courseId, mode, dupMode, buildTree, nameOverride },
    ),
    preview: (id) => invoke('file:preview', id),
    highlight: (id, text) => invoke('file:highlight', { id, text }),
    remove: (id, trash = true) => invoke('file:remove', { id, trash }),
    removeMany: (ids, trash = true) => invoke('files:removeMany', { ids, trash }),
    moveMany: (ids, courseId) => invoke('files:moveMany', { ids, courseId }),
    copyMany: (ids, dirIds, courseId) => invoke('files:copyMany', { ids, dirIds, courseId }),
    relocate: (id, auto = false) => invoke('file:relocate', { id, auto }),
    relocateTo: (id, path) => invoke('file:relocateTo', { id, path }),
    pickRelocate: (id) => invoke('file:pickRelocate', { id }),
    create: (payload) => invoke('file:create', payload),
    info: (id) => invoke('file:info', id),
    pickSaveDir: () => invoke('dialog:pickSaveDir'),
    reveal: (id) => invoke('file:reveal', id),
    openExternal: (id) => invoke('file:openExternal', id),
    openEditor: (id) => invoke('file:openEditor', id),
    run: (id, program, mode) => invoke('file:run', { id, program, mode }),
    project: (id) => invoke('file:project', id),
    pickProgram: (id) => invoke('file:pickProgram', { id }),
    editors: () => invoke('editor:list'),
    editorsForFile: (id) => invoke('editor:forFile', { id }),
    editorsForDir: () => invoke('editor:forDir'),
    rename: (id, name) => invoke('file:rename', { id, name }),
    saveText: (id, text) => invoke('file:saveText', { id, text }),
    /** 保存图片编辑结果：data 是 Uint8Array（画布编码后的字节） */
    saveImage: (id, mime, data) => invoke('file:saveImage', { id, mime, data }),
    moveToCourse: (id, courseId) => invoke('file:moveToCourse', { id, courseId }),
    setStorage: (id, storage) => invoke('file:setStorage', { id, storage }),
  },

  settings: {
    set: (patch) => invoke('settings:set', patch),
  },

  /* 插件一：自动更新内容（主进程扫描生成，见 src/changelog.js） */
  changelog: {
    get: () => invoke('changelog:get'),
    seen: (id) => invoke('changelog:seen', id),
  },

  /* 插件二（仅本机）：发布助手门禁（见 src/plugin2-main.js） */
  plugin2: {
    status: () => invoke('plugin2:status'),
  },

  library: {
    openBackups: () => invoke('library:openBackups'),
    openFilesDir: () => invoke('library:openFilesDir'),
  },

  storage: {
    info: () => invoke('storage:info'),
    setDir: (dir, migrate) => invoke('storage:setDir', { dir, migrate }),
    pickDir: () => invoke('storage:pickDir'),
  },

  trash: {
    restore: (id) => invoke('trash:restore', { id }),
    purge: (id) => invoke('trash:purge', { id }),
    empty: () => invoke('trash:empty'),
  },

  db: {
    health: () => invoke('db:health'),
    backup: () => invoke('db:backup'),
  },

  dupes: {
    scan: (courseId) => invoke('dupes:scan', { courseId }),
    remove: (fileIds) => invoke('dupes:remove', { fileIds }),
  },

  data: {
    openDir: () => invoke('data:openDir'),
  },

  /** 文件夹封面：单一通道，按 op 分发（见 src/folder-cover-main.js） */
  cover: (msg) => invoke('cover:action', msg),

  /** 桌宠桌面模式（见 src/pet-main.js）：主窗口负责开/关外部窗口与同步
   *  配置；外部窗口（pet-stage）回传拖动、尺寸与右键菜单模型。 */
  pet: {
    openExternal: (cfg) => invoke('pet:external-open', cfg),
    closeExternal: () => invoke('pet:external-close'),
    syncExternal: (cfg) => ipcRenderer.send('pet:external-config', cfg),
    onExternalCommand: (fn) => {
      const h = (_e, cmd) => fn(cmd);
      ipcRenderer.on('pet:external-command', h);
      return () => ipcRenderer.removeListener('pet:external-command', h);
    },
    moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', { dx, dy }),
    dragEnd: (p) => ipcRenderer.send('pet:drag-end', p),
    resize: (w, h) => ipcRenderer.send('pet:resize', { w, h }),
    contextMenu: (model) => ipcRenderer.send('pet:context-menu', model),
    /** 拖出交接：主窗口里的宠物拖出边界后，把几何与配置发给主进程，
     *  后续移动/松手继续转发（见 src/pet-main.js 的 pet:drag-* 通道） */
    dragOut: (p) => ipcRenderer.send('pet:drag-out', p),
    dragMove: (p) => ipcRenderer.send('pet:drag-move', p),
    dragEndOut: (p) => ipcRenderer.send('pet:drag-end-out', p),
    debug: (msg) => ipcRenderer.send('pet:debug', String(msg)),
    /* 桌宠配置存 userData/pet-config.json（localStorage 跨重启不可靠） */
    saveConfig: (text) => ipcRenderer.send('pet:config-save', String(text)),
    loadConfig: () => invoke('pet:config-load'),
    onCommand: (fn) => {
      const h = (_e, cmd) => fn(cmd);
      ipcRenderer.on('pet:command', h);
      return () => ipcRenderer.removeListener('pet:command', h);
    },
    onConfig: (fn) => {
      const h = (_e, cfg) => fn(cfg);
      ipcRenderer.on('pet:config', h);
      return () => ipcRenderer.removeListener('pet:config', h);
    },
    onPlay: (fn) => {
      const h = (_e, name) => fn(name);
      ipcRenderer.on('pet:play', h);
      return () => ipcRenderer.removeListener('pet:play', h);
    },
    /* 桌面自绘菜单窗口（pet-menu.html）专用：主进程把菜单模型
       和状态发过来，菜单里的选择与关闭请求从这里回去 */
    onMenuOpen: (fn) => {
      const h = (_e, data) => fn(data);
      ipcRenderer.on('pet:menu-open', h);
      return () => ipcRenderer.removeListener('pet:menu-open', h);
    },
    menuAction: (a) => ipcRenderer.send('pet:menu-action', a),
    menuClose: () => ipcRenderer.send('pet:menu-close'),
  },

  win: {
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close'),
    setTitlebarTheme: (name) => invoke('win:setTitlebarTheme', name),
    /** 订阅「焦点在子文档（PDF 阅读器）时按下的 Esc」。
     *  返回取消订阅函数。 */
    onEscape: (fn) => {
      const h = () => fn();
      ipcRenderer.on('win:escape', h);
      return () => ipcRenderer.removeListener('win:escape', h);
    },
    /** 订阅主进程代收的导航/显示快捷键（Alt+←、Alt+↑、Ctrl+Shift+R）。
     *  fn 收到 action：nav-up / nav-home / reveal。返回取消订阅函数。 */
    onShortcut: (fn) => {
      const h = (_e, action) => fn(action);
      ipcRenderer.on('win:shortcut', h);
      return () => ipcRenderer.removeListener('win:shortcut', h);
    },
  },

  update: {
    check: () => invoke('update:check'),
    apply: () => invoke('update:apply'),
    info: () => invoke('update:info'),
    pickSource: () => invoke('update:pickSource'),
    restart: () => invoke('update:restart'),
    /** 订阅「自动检测发现更新」。返回取消订阅函数。
     *  检测在主进程按设置的间隔跑，结果从这里推过来。 */
    onAvailable: (fn) => {
      const h = (_e, d) => fn(d);
      ipcRenderer.on('update:available', h);
      return () => ipcRenderer.removeListener('update:available', h);
    },
  },
});
