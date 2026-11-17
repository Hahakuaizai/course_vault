'use strict';

/* ============================================================
   桌宠的「桌面模式」主进程模块（pet-main.js）
   - 宠物配置的唯一事实来源在主窗口的 pet.js（localStorage）；
     这里只负责：开/关一个透明置顶小窗口（pet-stage.html）、
     转发配置、拖动时挪窗口、右键时弹系统原生菜单，
     以及把菜单里的选择以命令形式发回主窗口执行。
   - 外部窗口的位置按宠物分开存 userData/pet-window.json
     （{byPet: {宠物id: {x, y}}}，屏幕坐标，和主窗口 localStorage
     里的内部位置互相独立；旧版的单位置格式会自动当兜底）。
   - 主窗口关闭时必须带走宠物窗口，否则 window-all-closed
     不触发，应用会只剩一只宠物退不出去。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { BrowserWindow, Menu, screen } = require('electron');

function register({ ipcMain, app, getWin }) {
  let petWin = null;
  let lastCfg = null;
  let pendingDragStart = false; // 拖出交接时窗口还没加载完，先记着，加载好补发
  let winSeq = 0; // 窗口编号（日志里区分第几个窗口）

  /* 【临时诊断】把窗口生命周期和拖动裁决记进 userData/pet-debug.log，
     排查「桌面宠物点了没反应」用；定位后删。 */
  const dbgFile = () => path.join(app.getPath('userData'), 'pet-debug.log');
  try {
    if (fs.existsSync(dbgFile()) && fs.statSync(dbgFile()).size > 262144) fs.writeFileSync(dbgFile(), '');
  } catch { /* 忽略 */ }
  function dbg(msg) {
    try { fs.appendFileSync(dbgFile(), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* 写不进就算了 */ }
  }
  const rejectCount = {};
  function dbgReject(what) {
    rejectCount[what] = (rejectCount[what] || 0) + 1;
    if (rejectCount[what] <= 20) dbg(`REJECT ${what} #${rejectCount[what]}（发送方不是当前宠物窗口）`);
  }
  /* 窗口还活着吗（关窗事件没到但窗口已销毁时，按无窗口处理） */
  function liveWin() {
    if (petWin && petWin.isDestroyed()) { petWin = null; }
    return petWin;
  }

  const posFile = () => path.join(app.getPath('userData'), 'pet-window.json');

  function loadPosMap() {
    try {
      const p = JSON.parse(fs.readFileSync(posFile(), 'utf8'));
      if (p && typeof p === 'object') {
        if (p.byPet && typeof p.byPet === 'object') return p.byPet;
        /* 旧格式：整个文件就是 {x, y}（不分宠物）。留作兜底，
           哪只宠物先上桌面就先用这个位置，之后各自存各自的。 */
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) return { __legacy: { x: p.x, y: p.y } };
      }
    } catch { /* 没有存过就算了 */ }
    return {};
  }

  function posFor(petId) {
    const m = loadPosMap();
    return (petId && m[petId]) || m.__legacy || null;
  }

  function savePos() {
    if (!petWin) return;
    try {
      const b = petWin.getBounds();
      const m = loadPosMap();
      m[(lastCfg && lastCfg.pet) || 'kunkun'] = { x: b.x, y: b.y };
      fs.writeFileSync(posFile(), JSON.stringify({ byPet: m }));
    } catch { /* 存不下不影响使用 */ }
  }

  function createPetWin() {
    if (liveWin()) { dbg('win:create skipped (already exists)'); return; }
    const mySeq = ++winSeq;
    const pos = posFor(lastCfg && lastCfg.pet);
    dbg(`win:create #${mySeq} pet=${lastCfg && lastCfg.pet} pos=${pos ? pos.x + ',' + pos.y : 'default'}`);
    petWin = new BrowserWindow({
      width: 140,
      height: 140,
      x: pos ? pos.x : undefined,
      y: pos ? pos.y : undefined,
      transparent: true,
      frame: false,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    petWin.setAlwaysOnTop(true, 'screen-saver');
    if (!pos) {
      const wa = screen.getPrimaryDisplay().workArea;
      petWin.setPosition(wa.x + wa.width - 190, wa.y + wa.height - 190);
    }
    petWin.loadFile(path.join(__dirname, 'pet-stage.html'));
    petWin.webContents.on('did-finish-load', () => {
      if (!petWin) return;
      if (lastCfg) petWin.webContents.send('pet:config', lastCfg);
      if (pendingDragStart) {
        pendingDragStart = false;
        petWin.webContents.send('pet:command', { type: 'dragStart' });
      }
    });
    petWin.on('closed', () => { dbg(`win:closed #${mySeq}`); petWin = null; });
    /* 主窗口一关，宠物窗口跟着关 */
    const mw = getWin();
    if (mw && !mw._petWinHooked) {
      mw._petWinHooked = true;
      mw.on('closed', () => closePetWin());
    }
  }

  function closePetWin() {
    if (!petWin) return;
    savePos();
    const w = petWin;
    petWin = null;
    w.close();
  }

  function sendCmd(cmd) {
    const mw = getWin();
    if (!mw) return;
    if (cmd.type === 'openSettings') {
      if (mw.isMinimized()) mw.restore();
      mw.show();
      mw.focus();
    }
    mw.webContents.send('pet:external-command', cmd);
  }

  const fromMainWin = (e) => {
    const mw = getWin();
    return !!mw && BrowserWindow.fromWebContents(e.sender) === mw;
  };

  /* 指针屏幕坐标是否落在主窗口内容区内（留一点边距防误判） */
  function pointerInsideMain(x, y, inset) {
    const mw = getWin();
    if (!mw || mw.isMinimized()) return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const b = mw.getContentBounds();
    const i = inset || 0;
    return x >= b.x + i && x <= b.x + b.width - i && y >= b.y + i && y <= b.y + b.height - i;
  }

  /* 把桌面宠物收回主窗口内：把它的屏幕位置换算成窗口内坐标，
     通知主窗口切回内部模式，然后关掉外部窗口 */
  function dockInside() {
    const mw = getWin();
    if (!petWin || !mw) return;
    const b = petWin.getBounds();
    const cb = mw.getContentBounds();
    const x = Math.min(Math.max(4, b.x - cb.x), Math.max(4, cb.width - b.width - 4));
    const y = Math.min(Math.max(4, b.y - cb.y), Math.max(4, cb.height - b.height - 4));
    sendCmd({ type: 'dockInside', x: Math.round(x), y: Math.round(y) });
    closePetWin();
  }

  /* --- 主窗口 → 外部窗口 --- */

  ipcMain.handle('pet:external-open', (_e, cfg) => {
    lastCfg = cfg;
    dbg(`open pet=${cfg && cfg.pet} win=${!!liveWin()}`);
    if (!liveWin()) createPetWin();
    else petWin.webContents.send('pet:config', cfg);
    return true;
  });

  ipcMain.handle('pet:external-close', () => {
    closePetWin();
    return true;
  });

  ipcMain.on('pet:external-config', (_e, cfg) => {
    lastCfg = cfg;
    if (petWin) petWin.webContents.send('pet:config', cfg);
  });

  /* --- 外部窗口自身 --- */

  const fromPetWin = (e) => petWin && BrowserWindow.fromWebContents(e.sender) === petWin;

  ipcMain.on('pet:move-by', (e, d) => {
    if (!fromPetWin(e)) { dbgReject('move-by'); return; }
    if (!d) return;
    const b = petWin.getBounds();
    petWin.setPosition(b.x + Math.round(d.dx || 0), b.y + Math.round(d.dy || 0));
  });

  ipcMain.on('pet:drag-end', (e, p) => {
    if (!fromPetWin(e)) { dbgReject('drag-end'); return; }
    /* 在桌面上拖动后松手，落点在主窗口范围内 → 直接收回软件内 */
    if (p && pointerInsideMain(p.screenX, p.screenY, 8)) { dbg('drag-end: dock inside'); dockInside(); return; }
    dbg('drag-end: stay on desktop');
    savePos();
    /* 舞台自己会复位拖动态，这里再补一发 dragStop 兜底，
       防止某次命令丢失让它一直以为自己在被拖着 */
    petWin.webContents.send('pet:command', { type: 'dragStop' });
  });

  ipcMain.on('pet:resize', (e, s) => {
    if (!fromPetWin(e) || !s) return;
    petWin.setSize(
      Math.min(420, Math.max(40, Math.round(s.w || 140))),
      Math.min(420, Math.max(40, Math.round(s.h || 140))),
    );
  });

  /* --- 拖出交接：主窗口里的宠物被拖出边界后，桌面窗口接棒 ---
     指针还被主窗口捕获着，后续移动由主窗口转发屏幕坐标过来，
     这边只负责把宠物窗口摆到指针下面；松手时按落点决定去留。 */

  ipcMain.on('pet:drag-out', (e, p) => {
    if (!fromMainWin(e) || !p) return;
    dbg(`drag-out win=${!!liveWin()}`);
    if (p.cfg) lastCfg = p.cfg;
    if (!liveWin()) {
      pendingDragStart = true;
      createPetWin();
    } else {
      if (p.cfg) petWin.webContents.send('pet:config', p.cfg);
      petWin.webContents.send('pet:command', { type: 'dragStart' });
    }
    petWin.setSize(
      Math.min(420, Math.max(40, Math.round(p.w || 140))),
      Math.min(420, Math.max(40, Math.round(p.h || 140))),
    );
    petWin.setPosition(
      Math.round((p.screenX || 0) - (p.grabDX || 0)),
      Math.round((p.screenY || 0) - (p.grabDY || 0)),
    );
  });

  ipcMain.on('pet:drag-move', (e, p) => {
    if (!fromMainWin(e) || !petWin || !p) return;
    petWin.setPosition(
      Math.round((p.screenX || 0) - (p.grabDX || 0)),
      Math.round((p.screenY || 0) - (p.grabDY || 0)),
    );
  });

  ipcMain.on('pet:drag-end-out', (e, p) => {
    if (!fromMainWin(e)) return;
    if (!liveWin()) {
      /* dragOut 还在路上（配置异步构建）就先松手了：窗口还没建。
         按落点直接回话让主窗口状态落地，窗口随后由 stayOut
         触发的 applyPet 正常打开，不再把这次裁决丢掉。 */
      dbg('drag-end-out: no window yet');
      if (!(p && pointerInsideMain(p.screenX, p.screenY, 8))) sendCmd({ type: 'stayOut' });
      return;
    }
    /* 拖出去又拖回窗口里松手 → 收回软件内，等于没出去 */
    if (p && pointerInsideMain(p.screenX, p.screenY, 8)) { dbg('drag-end-out: dock inside'); dockInside(); return; }
    dbg('drag-end-out: stay out');
    savePos();
    petWin.webContents.send('pet:command', { type: 'dragStop' });
    /* 落点裁决由主进程统一回话：留在桌面 → stayOut。
       主窗口收到后才切桌面模式，避免它抢先打开外部窗口、
       又被收回动作关掉，两边状态对不上（幽灵窗口）。 */
    sendCmd({ type: 'stayOut' });
  });

  /* 右键菜单用系统原生的：宠物窗口只有宠物本体那么大，
     HTML 菜单弹不下；原生菜单不受窗口边界限制。
     菜单模型由 pet-stage.js 按当前宠物包组装。 */
  ipcMain.on('pet:context-menu', (e, model) => {
    if (!fromPetWin(e)) { dbgReject('context-menu'); return; }
    if (!model) return;
    dbg('context-menu: popup');
    const template = [];
    const groups = (model.groups || []).filter((g) => (g.items || []).length);
    if (groups.length) {
      template.push({
        label: '播放动作',
        submenu: groups.map((g) => ({
          label: g.label,
          submenu: g.items.map((it) => ({
            label: it.label,
            click: () => { if (petWin) petWin.webContents.send('pet:play', it.id); },
          })),
        })),
      });
      template.push({ type: 'separator' });
    }
    template.push({
      label: '更换宠物',
      submenu: (model.pets || []).map((p) => ({
        label: p.label,
        type: 'checkbox',
        checked: !!p.tick,
        click: () => sendCmd({ type: 'setPet', id: p.id }),
      })),
    });
    template.push({
      label: '桌宠大小',
      submenu: (model.sizes || []).map((s) => ({
        label: s.label,
        type: 'checkbox',
        checked: !!s.tick,
        click: () => {
          sendCmd({ type: 'setSize', key: s.key });
          /* 系统菜单里塞不下滑动条：选「自定义」时顺带打开主窗口的
             桌宠设置页，那里的滑块会直接显示出来 */
          if (s.key === 'custom') sendCmd({ type: 'openSettings' });
        },
      })),
    });
    template.push({ type: 'separator' });
    template.push({ label: '打开桌宠设置', click: () => sendCmd({ type: 'openSettings' }) });
    template.push({ label: '切回软件内显示', click: () => dockInside() });
    template.push({ label: '隐藏桌宠', click: () => sendCmd({ type: 'setPet', id: 'none' }) });
    Menu.buildFromTemplate(template).popup({ window: petWin });
  });

  /* 【临时诊断】舞台侧的事件回传（按下/松手/右键/收到配置与命令） */
  ipcMain.on('pet:debug', (e, msg) => {
    if (!fromPetWin(e) && !fromMainWin(e)) return;
    dbg(`stage: ${msg}`);
  });

  /* 桌宠配置的权威副本：userData/pet-config.json。
     这台机器上渲染层的 localStorage 跨重启会丢（日志实测），
     文件一直可靠，所以配置改存文件。保存走节流（滑杆拖动时
     每秒几十次，攒 300ms 写一次），退出前把没落盘的刷掉。 */
  const cfgFile = () => path.join(app.getPath('userData'), 'pet-config.json');
  let pendingCfgText = null;
  let cfgWriteTimer = 0;
  const flushCfg = () => {
    if (pendingCfgText === null) return;
    const text = pendingCfgText;
    pendingCfgText = null;
    try { fs.writeFileSync(cfgFile(), text); } catch { /* 写不进就算了 */ }
  };
  ipcMain.handle('pet:config-load', () => {
    try { return fs.readFileSync(cfgFile(), 'utf8'); } catch { return null; }
  });
  ipcMain.on('pet:config-save', (e, text) => {
    if (!fromMainWin(e)) return;
    pendingCfgText = String(text || '');
    if (!cfgWriteTimer) {
      cfgWriteTimer = setTimeout(() => { cfgWriteTimer = 0; flushCfg(); }, 300);
    }
  });

  app.on('before-quit', () => { flushCfg(); closePetWin(); });
}

module.exports = { register };
