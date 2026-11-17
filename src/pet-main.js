'use strict';

/* ============================================================
   桌宠的「桌面模式」主进程模块（pet-main.js）
   - 宠物配置的唯一事实来源在主窗口的 pet.js（localStorage）；
     这里只负责：开/关一个透明置顶小窗口（pet-stage.html）、
     转发配置、拖动时挪窗口、右键时弹系统原生菜单，
     以及把菜单里的选择以命令形式发回主窗口执行。
   - 外部窗口的位置存 userData/pet-window.json（屏幕坐标，
     和主窗口 localStorage 里的内部位置互相独立）。
   - 主窗口关闭时必须带走宠物窗口，否则 window-all-closed
     不触发，应用会只剩一只宠物退不出去。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { BrowserWindow, Menu, screen } = require('electron');

function register({ ipcMain, app, getWin }) {
  let petWin = null;
  let lastCfg = null;

  const posFile = () => path.join(app.getPath('userData'), 'pet-window.json');

  function loadPos() {
    try {
      const p = JSON.parse(fs.readFileSync(posFile(), 'utf8'));
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch { /* 没有存过就算了 */ }
    return null;
  }

  function savePos() {
    if (!petWin) return;
    try {
      const b = petWin.getBounds();
      fs.writeFileSync(posFile(), JSON.stringify({ x: b.x, y: b.y }));
    } catch { /* 存不下不影响使用 */ }
  }

  function createPetWin() {
    const pos = loadPos();
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
      if (petWin && lastCfg) petWin.webContents.send('pet:config', lastCfg);
    });
    petWin.on('closed', () => { petWin = null; });
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

  /* --- 主窗口 → 外部窗口 --- */

  ipcMain.handle('pet:external-open', (_e, cfg) => {
    lastCfg = cfg;
    if (!petWin) createPetWin();
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
    if (!fromPetWin(e) || !d) return;
    const b = petWin.getBounds();
    petWin.setPosition(b.x + Math.round(d.dx || 0), b.y + Math.round(d.dy || 0));
  });

  ipcMain.on('pet:drag-end', (e) => {
    if (fromPetWin(e)) savePos();
  });

  ipcMain.on('pet:resize', (e, s) => {
    if (!fromPetWin(e) || !s) return;
    petWin.setSize(
      Math.min(420, Math.max(40, Math.round(s.w || 140))),
      Math.min(420, Math.max(40, Math.round(s.h || 140))),
    );
  });

  /* 右键菜单用系统原生的：宠物窗口只有宠物本体那么大，
     HTML 菜单弹不下；原生菜单不受窗口边界限制。
     菜单模型由 pet-stage.js 按当前宠物包组装。 */
  ipcMain.on('pet:context-menu', (e, model) => {
    if (!fromPetWin(e) || !model) return;
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
        click: () => sendCmd({ type: 'setSize', key: s.key }),
      })),
    });
    template.push({ type: 'separator' });
    template.push({ label: '打开桌宠设置', click: () => sendCmd({ type: 'openSettings' }) });
    template.push({ label: '切回软件内显示', click: () => sendCmd({ type: 'setMode', mode: 'inside' }) });
    template.push({ label: '隐藏桌宠', click: () => sendCmd({ type: 'setPet', id: 'none' }) });
    Menu.buildFromTemplate(template).popup({ window: petWin });
  });

  app.on('before-quit', () => closePetWin());
}

module.exports = { register };
