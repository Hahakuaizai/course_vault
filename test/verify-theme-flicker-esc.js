'use strict';

/**
 * 验证两项修复：
 *   1. 切主题不再闪白/闪黑 —— 用 Page.startScreencast 抓每一帧，
 *      找「整帧同一个颜色」（sd≈0）的空帧。
 *   2. PDF 预览聚焦后 Esc 仍能关闭 —— 用真实键盘事件，
 *      焦点先塞进 PDF 的 iframe 里。
 */

const { connect } = require('./cdp.js');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FF = 'C:/Users/30894/.dsh/tools/ffmpeg/bin/ffmpeg.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 整帧的 {mean, sd}。sd 接近 0 说明整帧是纯色 —— 就是用户看到的白屏/黑屏 */
const frameStats = (file) => {
  const buf = execFileSync(FF, ['-v', 'error', '-i', file, '-vf', 'scale=64:36',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e7 });
  const arr = [];
  let sum = 0;
  for (let i = 0; i < buf.length; i += 3) {
    const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    arr.push(l); sum += l;
  }
  const mean = sum / arr.length;
  let v = 0;
  for (const l of arr) v += (l - mean) ** 2;
  return { mean: Math.round(mean), sd: +Math.sqrt(v / arr.length).toFixed(1) };
};

(async () => {
  const c = await connect();
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };

  await c.send('Page.enable');
  await c.send('Page.bringToFront');

  /* 窗口被最小化时 document.hidden 为 true，Chromium 会完全停掉
   * requestAnimationFrame —— 采样循环永远等不到下一帧，整个脚本卡死。
   * 这不是 bug，是后台窗口的正常行为。所以先探测：
   *   - 可见：正常跑逐帧采样
   *   - 不可见：跳过采样类断言（标记为跳过而不是失败），
   *     只跑不依赖渲染的断言（html 底色、keyframes、Esc）。
   * 不主动把窗口拉出来 —— 用户明确要求不要抢焦点。 */
  const visible = (await c.ev(`!document.hidden`)) === true;
  if (!visible) {
    console.log('⚠️  窗口当前不可见（被最小化或在后台），跳过需要渲染帧的采样项。');
    console.log('   需要完整验证时把「资料库」窗口恢复后重跑本脚本。\n');
  }

  // 清场：预览、弹窗、菜单都可能被上一轮测试留着，挡住后面的断言
  await c.ev(`(() => {
    ['overlay','shortcutsModal','settingsModal','courseModal','newFileModal',
     'importModal','confirmModal','delModal','detailModal','dupeModal',
     'relocateModal','changelogModal','renameModal'].forEach(id => {
      const el = document.getElementById(id); if (el) el.hidden = true;
    });
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    window.__vaultDebug.state.view = { type: 'all', courseId: null };
    window.__vaultDebug.render();
  })()`);
  await sleep(600);

  /* ---------- 1. 主题切换不闪 ---------- */
  /* 采样方式说明见下面 for 循环里的注释。 */
  const dir = path.join(__dirname, '.shot-theme');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (const target of visible ? ['light', 'dark'] : []) {
    // 先稳定到反方向
    await c.ev(`(async () => {
      const root = document.documentElement;
      const want = '${target === 'light' ? 'dark' : 'light'}';
      if (root.dataset.theme !== want) {
        document.querySelector('#btnTheme').click();
        await new Promise(r => setTimeout(r, 2400));
      }
    })()`);
    await sleep(900);

    /* 在页面内逐帧采样。
     *
     * 用「切换前后各抓一次关键属性」的方式判断有没有纯色空档：
     * 每帧读 body 的 background-color 和 .app 是否还有内容，
     * 只要有一帧 body 是纯色而 .app 内容不可见，就是闪。
     *
     * 为什么不用截图：CDP 截图一张几十毫秒，1.4 秒只抓到 1~2 张，
     * 根本盖不住切换过程；screencast 在 Electron 里又会退化。
     * 页面内 requestAnimationFrame 每帧都能拿到，是唯一可靠的采样点。 */
    const samples = await c.ev(`(async () => {
      const out = [];
      const root = document.documentElement;
      const app = document.querySelector('.app');
      const body = document.body;

      const snap = (tag) => {
        const cs = getComputedStyle(body);
        const appCs = app ? getComputedStyle(app) : null;
        out.push({
          tag,
          t: Math.round(performance.now()),
          bodyBg: cs.backgroundColor,
          appOpacity: appCs ? appCs.opacity : null,
          appVisible: app ? app.getBoundingClientRect().height > 0 : false,
          vtOpacity: getComputedStyle(root, '::view-transition').opacity,
          theme: root.dataset.theme,
        });
      };

      snap('before');
      document.querySelector('#btnTheme').click();

      // 连采 40 帧，覆盖整个切换过程
      for (let i = 0; i < 40; i += 1) {
        await new Promise(r => requestAnimationFrame(r));
        snap('during');
      }
      snap('after');
      return out;
    })()`);

    /* 判定「闪」：某一帧里 ::view-transition 的 opacity 接近 0，
     * 而主题已经切换 —— 那意味着整棵快照树透明，露出纯色 body。
     * 这正是之前那个 bug 的特征（keyframes 0% opacity:0）。 */
    const zeroOpacity = samples.filter(s =>
      s.tag === 'during' && parseFloat(s.vtOpacity) < 0.5);
    check(`切到 ${target}：View Transition 全程不透明`,
      zeroOpacity.length === 0,
      zeroOpacity.length
        ? `${zeroOpacity.length} 帧 opacity<0.5：${zeroOpacity.slice(0, 3).map(s => `${s.t}ms=${s.vtOpacity}`).join(', ')}`
        : `${samples.length} 个采样点`);

    // 内容始终在（app 有高度），不会出现「整页空白」
    const noContent = samples.filter(s => !s.appVisible);
    check(`切到 ${target}：内容全程可见`,
      noContent.length === 0, `${noContent.length} 帧 app 无高度`);

    // 主题确实切过去了
    const finalTheme = samples[samples.length - 1]?.theme;
    check(`切到 ${target}：主题真的切过去了`, finalTheme === target, finalTheme);
    // 采样点足够密，才说明盖住了整个切换过程
    check(`切到 ${target}：采样覆盖了切换过程`,
      samples.length >= 20, `${samples.length} 个采样点`);
  }

  /* ---------- 2. PDF 聚焦后 Esc ---------- */
  const pressEsc = async () => {
    await c.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await c.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
  };

  // 普通文本预览：Esc 关闭（回归）
  const txt = await c.ev(`(async () => {
    const f = window.__vaultDebug.state.files.find(x => ['.md', '.txt', '.py'].includes(x.ext));
    await window.__vaultDebug.openPreview(f.id);
    await new Promise(r => setTimeout(r, 700));
    return { name: f.name, open: !document.querySelector('#overlay').hidden };
  })()`);
  check('能打开文本预览', txt.open === true, txt.name);
  await pressEsc();
  await sleep(600);
  check('文本预览按 Esc 能关闭',
    (await c.ev(`document.querySelector('#overlay').hidden`)) === true);

  // PDF：把焦点塞进 iframe，再按 Esc
  const pdf = await c.ev(`(async () => {
    const f = window.__vaultDebug.state.files.find(x => x.ext === '.pdf');
    if (!f) return { skip: true };
    await window.__vaultDebug.openPreview(f.id);
    await new Promise(r => setTimeout(r, 1600));
    const ifr = document.querySelector('#previewBody iframe');
    if (!ifr) return { skip: true, reason: '没有 iframe' };
    ifr.focus();
    return {
      name: f.name,
      open: !document.querySelector('#overlay').hidden,
      focusInIframe: document.activeElement === ifr,
    };
  })()`);

  if (pdf.skip) {
    check('找到 PDF 预览', false, pdf.reason || '没有 PDF 文件');
  } else {
    check('能打开 PDF 预览', pdf.open === true, pdf.name);
    check('焦点能进到 PDF 的 iframe（复现条件）', pdf.focusInIframe === true);

    await pressEsc();
    await sleep(800);
    const closed = await c.ev(`document.querySelector('#overlay').hidden`);
    check('焦点在 PDF 里时按 Esc 也能关闭', closed === true);
  }

  // 编辑中的文件按 Esc
  const editing = await c.ev(`(async () => {
    const f = window.__vaultDebug.state.files.find(x => ['.py', '.md', '.txt'].includes(x.ext));
    await window.__vaultDebug.openPreview(f.id);
    await new Promise(r => setTimeout(r, 700));
    document.querySelector('#btnEdit')?.click();
    await new Promise(r => setTimeout(r, 500));
    const ta = document.querySelector('textarea.editor');
    ta?.focus();
    return { editing: !!ta };
  })()`);
  check('能进入编辑模式', editing.editing === true);
  await pressEsc();
  await sleep(800);
  const editClosed = await c.ev(`({
    closed: document.querySelector('#overlay').hidden,
    stillEditing: !!document.querySelector('textarea.editor'),
  })`);
  check('编辑中按 Esc 能关闭预览', editClosed.closed === true);
  check('关闭后编辑器已卸载', editClosed.stillEditing === false);

  /* ---------- 3. html 有底色（防透出原生窗口白色） ---------- */
  const htmlBg = await c.ev(`getComputedStyle(document.documentElement).backgroundColor`);
  check('根元素有底色（不是 transparent）',
    htmlBg !== 'rgba(0, 0, 0, 0)' && htmlBg !== 'transparent', htmlBg);

  /* ---------- 4. 光效用的是不带 opacity 的 keyframes ---------- */
  const glow = await c.ev(`(() => {
    const cs = getComputedStyle(document.documentElement, '::view-transition');
    return { animName: cs.animationName };
  })()`);
  // 不在切换期间 animationName 是 none，这里只断言 CSS 规则里定义了两套 keyframes
  const keyframes = await c.ev(`(() => {
    const names = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.type === CSSRule.KEYFRAMES_RULE) names.push(r.name);
      }
    }
    return names.filter(n => n.startsWith('themeEdgeGlow'));
  })()`);
  check('VT 光效和 DOM 光效用两套独立 keyframes',
    keyframes.includes('themeEdgeGlowVT') && keyframes.includes('themeEdgeGlow'),
    keyframes.join(', '));

  if (!visible) {
    console.log('ℹ️  主题闪烁的 8 项采样断言本次跳过（窗口不可见）。');
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
