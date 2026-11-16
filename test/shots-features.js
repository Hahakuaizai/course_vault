'use strict';

/** 截图：浅色/深色下的主题开关特写、公告、教程 */
const { connect } = require('./cdp.js');
const fs = require('fs');
const path = require('path');

const OUT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();

  await c.ev(`(() => {
    ['shortcutsModal','settingsModal','courseModal','newFileModal','importModal',
     'confirmModal','delModal','dupModal','detailModal','dupeModal','relocateModal',
     'changelogModal'].forEach(id => {
      const el = document.getElementById(id); if (el) el.hidden = true;
    });
  })()`);
  await sleep(300);

  const clipShot = async (name, sel, pad = 40) => {
    const box = await c.ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - ${pad}, y: r.top - ${pad},
               width: r.width + ${pad} * 2, height: r.height + ${pad} * 2 };
    })()`);
    if (!box) { console.log(`跳过 ${name}：找不到 ${sel}`); return; }
    await c.send('Page.bringToFront');
    await sleep(400);
    const shot = await c.send('Page.captureScreenshot', {
      format: 'png', clip: { ...box, scale: 3 }, captureBeyondViewport: true,
    });
    const f = path.join(OUT, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log(`截图：${f}`);
  };

  const fullShot = async (name) => {
    await c.send('Page.bringToFront');
    await sleep(500);
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log(`截图：${f}`);
  };

  // 浅色开关
  await c.ev(`(async () => {
    if (document.documentElement.dataset.theme !== 'light') {
      document.querySelector('#btnTheme').click();
      await new Promise(r => setTimeout(r, 900));
    }
  })()`);
  await sleep(600);
  await clipShot('shot-switch-light', '#btnTheme', 30);

  // 深色开关。切主题有 0.5s 扩散 + 1s 边缘光，等久一点再截，
  // 否则会拍到过渡中间态（半亮半暗、位置也还没落定）
  await c.ev(`(async () => {
    if (document.documentElement.dataset.theme !== 'dark') {
      document.querySelector('#btnTheme').click();
      await new Promise(r => setTimeout(r, 1800));
    }
  })()`);
  await sleep(800);
  await clipShot('shot-switch-dark', '#btnTheme', 30);

  // 更新公告
  await c.ev(`(async () => {
    if (document.documentElement.dataset.theme !== 'light') {
      document.querySelector('#btnTheme').click();
      await new Promise(r => setTimeout(r, 900));
    }
    window.__vaultDebug.openChangelog();
  })()`);
  await sleep(700);
  await fullShot('shot-changelog');

  // 使用教程
  await c.ev(`(async () => {
    window.__vaultDebug.closeChangelog();
    document.querySelector('#settingsModal').hidden = false;
    document.querySelector('[data-pane="guide"].snav-item').click();
    await new Promise(r => setTimeout(r, 500));
  })()`);
  await sleep(800);
  await fullShot('shot-guide');

  await c.ev(`(() => {
    document.querySelector('#settingsModal').hidden = true;
    const el = document.querySelector('#changelogModal');
    if (el) el.hidden = true;
  })()`);

  c.close();
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
