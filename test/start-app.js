/* 后台启动 Electron（带 CDP 端口 9333），不抢焦点。
   用真实 userData，保留用户的资料库数据。 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9333;
const logFile = path.resolve(__dirname, '.electron.log');

const out = fs.openSync(logFile, 'w');
const child = spawn(
  path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [
    ROOT,
    `--remote-debugging-port=${PORT}`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
  { stdio: ['ignore', out, out], detached: true },
);
child.unref();
console.log('已启动 electron，PID', child.pid);
