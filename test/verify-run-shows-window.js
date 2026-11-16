'use strict';

/**
 * 验证「用其他程序打开」真的把窗口显示出来了。
 *
 * 之前 windowsHide: true 会把 GUI 程序的主窗口一起藏掉：
 * 进程起来了、任务管理器看得见，桌面上却没有窗口，
 * 界面还已经提示「已打开」。用户看到的就是「提示打开了但没启动」。
 *
 * 用记事本验证最安全（不会像编辑器那样加载一堆东西）：
 *   - 打开前记下 notepad 进程列表
 *   - 通过 files.run 打开一个文本文件
 *   - 必须出现一个 MainWindowHandle 非 0 的新进程
 *   - 测完只关掉这次起来的那个
 */

const { connect } = require('./cdp.js');
const { execSync } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ps = (cmd) => {
  try {
    return execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: 'utf8' }).trim();
  } catch { return ''; }
};

const listNotepad = () => ps(
  'Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id',
).split(/\s+/).filter(Boolean).map(Number);

const handleOf = (pid) => ps(
  `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
  + "if ($p) { Write-Output $p.MainWindowHandle }",
);

(async () => {
  const c = await connect();
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };
  const ev = (e) => c.ev(e);

  let opened = [];
  try {
    const target = await ev(`(async () => {
      const st = await window.vault.getState();
      const f = st.files.find((x) => ['.txt', '.md', '.py', '.js'].includes(x.ext));
      return f ? { id: f.id, name: f.name } : null;
    })()`);
    if (!target) throw new Error('库里没有可用于测试的文本文件');

    const before = new Set(listNotepad());
    const res = await ev(`window.vault.files.run(
      ${JSON.stringify(target.id)}, 'notepad',
    )`);
    await sleep(3200);

    const fresh = listNotepad().filter((id) => !before.has(id));
    opened = fresh;
    check('files:run 没报错', !!res, JSON.stringify(res).slice(0, 80));
    check('记事本进程真的起来了', fresh.length > 0, `${fresh.length} 个新进程`);

    if (fresh.length) {
      const handles = fresh.map((id) => ({ id, h: Number(handleOf(id) || 0) }));
      const withWindow = handles.filter((x) => x.h > 0);
      check('记事本有可见的主窗口（不是被藏起来了）',
        withWindow.length > 0,
        handles.map((x) => `pid ${x.id} handle=${x.h}`).join(' | '));
    }
  } finally {
    for (const id of opened) {
      try { execSync(`taskkill /PID ${id} /F`, { stdio: 'ignore' }); } catch { /* 忽略 */ }
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
