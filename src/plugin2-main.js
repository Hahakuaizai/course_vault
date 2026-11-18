'use strict';
/*
 * ============================================================
 * 插件二（仅作者本机）：发布助手 —— 主进程门禁
 * ============================================================
 * 界面代码（src/devtools.js）只有在门禁通过时才会被加载，门禁就是
 * 数据目录里的一个标记文件 plugin2-owner.marker —— 只有作者本机
 * 有，别人装的软件里没有，发布版里更不会有。
 * 本模块在 main.js 里以 try/catch 方式 require：打包脚本会把插件二
 * 的两个文件排除在发布包之外，那时 require 直接失败、静默跳过，
 * 连这条 IPC 都不存在，界面侧的询问会落空并自动放弃加载。
 * ============================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'plugin2-owner.marker';

function register({ app, ipcMain }) {
  ipcMain.handle('plugin2:status', () => {
    try {
      return fs.existsSync(path.join(app.getPath('userData'), MARKER));
    } catch {
      return false;
    }
  });
}

module.exports = { register };
