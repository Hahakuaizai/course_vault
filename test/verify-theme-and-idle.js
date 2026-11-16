'use strict';

/**
 * 回归测试：主题切换的揭幕与光线，以及静置时界面不动。
 *
 * 覆盖四个已修 bug：
 *   1. 切换主题时页面上方先出现一条横贯窗口的黑色条带。
 *      根因：揭幕克隆层 #appL 的 z-index 是 5，而 .titlebar 是 30，
 *      两者同在根层叠上下文，克隆层永远盖不住顶部 46px。
 *   2. 没切主题时界面自己出现光线横扫。
 *      根因：.main::before 上挂着 `pmDrift 26s infinite alternate`。
 *   3. 光线粗得像一块色块（30vmax 厚）。
 *      现在主光 7vmax、弥散 17vmax 且重度模糊。
 *   4. 深→浅时月光紫完全看不见。
 *      根因：白底上 screen 趋近白、soft-light 染色几乎为零。改用 normal。
 *
 * 跑法：先 `npx electron . --remote-debugging-port=9333`，再
 *       `node test/verify-theme-and-idle.js`
 */

const fs = require('fs');
const { connect } = require('./cdp');

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`); }
}

(async () => {
  const c = await connect();
  const ev = c.evaluate;

  /* ---------- 0. 确认跑的是工作区源码 ---------- */
  const ver = await ev(`
    return { script: [...document.scripts].map((s) => s.src).find((s) => s.includes('page-motion')) || '' };
  `);
  check('page-motion.js 来自工作区源码', ver.script.includes('course-vault/src/page-motion.js'), ver.script);

  /* ---------- 1. 等开屏横扫彻底播完，再开始任何断言 ----------
     开屏那一下是 900ms 起播、1150ms 动画 + 摘类延时，加起来约 2.2s。
     如果测试恰好在启动后的这段时间里连上，会把它当成「静置时自己动」。
     `npx electron` 启动耗时不定，所以不能靠固定 sleep —— 这里轮询等它
     真的停下来。 */
  await ev(`
    window.__settleT0 = performance.now();
    window.__settleP = new Promise((resolve) => {
      const done = () => {
        const el = document.querySelector('.cv-sweep');
        const mainAnims = document.getAnimations().filter((a) =>
          a.animationName && a.effect?.target?.classList?.contains('main'));
        return el && !el.classList.contains('go') && mainAnims.length === 0;
      };
      const tick = () => {
        if (done() || performance.now() - window.__settleT0 > 15000) resolve(done());
        else setTimeout(tick, 100);
      };
      tick();
    });
    return true;
  `);
  const settled = await ev(`return window.__settleP`);
  check('开屏动画已完全停下（后续断言的前提）', settled === true, settled);

  /* ---------- 1b. 主区背景层没有持续动画 ---------- */
  const idle0 = await ev(`
    const anims = document.getAnimations().filter((a) => {
      if (!a.animationName) return false;
      const t = a.effect && a.effect.target;
      return t && (t.classList.contains('main') || t.classList.contains('cv-sweep'));
    });
    return {
      n: anims.length,
      names: anims.map((a) => a.animationName),
      mainAnim: getComputedStyle(document.querySelector('.main'), '::before').animationName,
    };
  `);
  check('主区背景层没有持续动画', idle0.n === 0, idle0);
  check('pmDrift 已从样式表移除', idle0.mainAnim === 'none', idle0.mainAnim);

  /* ---------- 2. 静置 25 秒：横扫层零触发 ----------
     开屏那次横扫在 900ms 起播、约 2.7s 结束。先等它彻底播完再装
     观察器 —— 关键是要等到 `.go` 已经被摘掉，否则观察器会捕获到
     开屏那一发的尾巴。 */
  await ev(`
    window.__waitClear = setInterval(() => {
      const el = document.querySelector('.cv-sweep');
      if (el && !el.classList.contains('go')) {
        clearInterval(window.__waitClear);
        window.__cleared = true;
      }
    }, 100);
    return true;
  `);
  await c.wait(5000);
  const cleared = await ev(`clearInterval(window.__waitClear); return !!window.__cleared`);
  check('开屏横扫已播完（观察前提）', cleared === true, cleared);

  await ev(`
    window.__idleLog = [];
    const sw = document.querySelector('.cv-sweep');
    window.__idleMo = new MutationObserver(() => window.__idleLog.push(sw.className));
    window.__idleMo.observe(sw, { attributes: true, attributeFilter: ['class'] });
    window.__idleT0 = performance.now();
    return true;
  `);
  console.log('  … 静置 25 秒');
  await c.wait(25000);
  /* ★ 必须在这里断开观察器。
     后面的步骤会真的切换主题（那是它们该做的事），每切一次横扫层就会
     多一条 class 记录。观察器若不断开，这些后续触发会被算进「静置期间
     自己动了」，测试就会报一个根本不存在的问题（实测一次记到 22 条）。 */
  const after = await ev(`
    window.__idleMo.disconnect();
    return {
      log: window.__idleLog,
      sec: Math.round((performance.now() - window.__idleT0) / 1000),
      mainAnims: document.getAnimations()
        .filter((a) => a.animationName && a.effect?.target?.classList?.contains('main'))
        .map((a) => a.animationName),
    };
  `);
  check(`静置 ${after.sec} 秒横扫层零触发`, after.log.length === 0, after.log);
  check(`静置 ${after.sec} 秒主区零动画`, after.mainAnims.length === 0, after.mainAnims);

  /* ---------- 3. 层级：克隆层盖住 titlebar，但低于弹窗 ---------- */
  const z = await ev(`
    const ok = window.__vaultThemeReveal.prepare('light');
    const a = document.getElementById('appL');
    if (!a) return { ok, err: 'no appL' };
    const r = {
      ok,
      appLZ: Number(getComputedStyle(a).zIndex),
      tbZ: Number(getComputedStyle(document.querySelector('.app .titlebar')).zIndex),
      fxZ: Number(getComputedStyle(document.querySelector('.tsw-fx')).zIndex),
      bandZ: Number(getComputedStyle(document.querySelector('.tsw-band')).zIndex),
      overlayZ: Number(getComputedStyle(document.querySelector('.overlay')).zIndex),
    };
    window.__vaultThemeReveal.finish(false);
    return r;
  `);
  check('克隆层 z-index 高于 titlebar（顶部不再被旧主题压住）', z.appLZ > z.tbZ, z);
  check('光屑层 z-index 高于克隆层（揭幕时粒子仍可见）', z.fxZ > z.appLZ, z);
  check('交界光带 z-index 高于克隆层', z.bandZ > z.appLZ, z);
  check('克隆层仍低于弹窗（弹窗不被克隆体盖住）', z.appLZ < z.overlayZ, z);

  /* ---------- 4. 顶部像素：满幅浅色层必须盖住标题栏 ----------
     先真实切到深色（不要手改 data-theme，会让开关内部状态失同步）。 */
  const theme0 = await ev(`return document.documentElement.dataset.theme`);
  if (theme0 !== 'dark') {
    await ev(`document.querySelector('#themeSwitchHost .tsw').click(); return true`);
    await c.wait(3000);
  }
  const themeNow = await ev(`return document.documentElement.dataset.theme`);
  check('已切到深色作为对照基准', themeNow === 'dark', themeNow);

  await ev(`
    window.__vaultThemeReveal.prepare('light');
    document.getElementById('appL').style.clipPath = 'circle(4000px at 400px 400px)';
    return true;
  `);
  await c.wait(300);
  const shotTop = await c.shot('_verify-top.png', { x: 0, y: 0, width: 640, height: 40 });
  const topRGB = await readPixel(shotTop, 320, 20);
  check('克隆层满幅时顶部是浅色（不是深色标题栏）',
    topRGB.r > 200 && topRGB.g > 200, topRGB);
  await ev(`window.__vaultThemeReveal.finish(false); return true`);
  fs.unlinkSync(shotTop);

  /* ---------- 5. 光线几何：是一道细光，不是色块 ---------- */
  const geo = await ev(`
    const el = document.querySelector('.cv-sweep');
    const b = getComputedStyle(el, '::before');
    const a = getComputedStyle(el, '::after');
    return {
      mainH: parseFloat(b.height),
      softH: parseFloat(a.height),
      vmax: Math.max(innerWidth, innerHeight),
      beforeBlendDark: null,
    };
  `);
  /* 主光厚度应远小于窗口短边（原来的 30vmax 会铺满大半屏） */
  check('主光厚度小于窗口短边的 1/5', geo.mainH < Math.min(1280, 803) / 5,
    { mainH: geo.mainH, vmax: geo.vmax });
  check('弥散层比主光厚但不超过窗口短边的一半', geo.softH > geo.mainH && geo.softH < 803 / 2,
    { softH: geo.softH });

  /* ---------- 6. 两套配色与方向 ---------- */
  const styles = await ev(`
    const el = document.querySelector('.cv-sweep');
    const get = (mode) => {
      el.dataset.mode = mode;
      const b = getComputedStyle(el, '::before');
      const a = getComputedStyle(el, '::after');
      return { blend: b.mixBlendMode, softBlend: a.mixBlendMode, bg: b.backgroundImage };
    };
    return { toDark: get('to-dark'), toLight: get('to-light') };
  `);
  /* 切到深色 = 月光：深底上 screen 才能发光 */
  check('切到深色那套用 screen（深底上发光）', styles.toDark.blend === 'screen', styles.toDark);
  check('切到深色带紫色（月光）', /1[4-9][0-9],\s*1[2-8][0-9],\s*255/.test(styles.toDark.bg), styles.toDark.bg.slice(0, 100));
  /* 切到浅色 = 阳光：白底上 screen 会糊成白，必须 normal */
  check('切到浅色那套用 normal（白底上才看得见）', styles.toLight.blend === 'normal', styles.toLight);
  check('切到浅色是金黄色（阳光）', /255,\s*1[89][0-9]|255,\s*2[0-4][0-9]/.test(styles.toLight.bg), styles.toLight.bg.slice(0, 100));

  /* ---------- 7. 切换方向：浅→深是 fwd，深→浅是 back ---------- */
  const dirs = await ev(`
    const el = document.querySelector('.cv-sweep');
    el.dataset.mode = 'to-dark';
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
    const fwd = getComputedStyle(el, '::before').animationName;
    el.dataset.mode = 'to-light';
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
    const back = getComputedStyle(el, '::before').animationName;
    el.classList.remove('go');
    return { fwd, back };
  `);
  check('切到深色用正向关键帧（左下→右上）', dirs.fwd === 'cv-light-fwd', dirs);
  check('切到浅色用反向关键帧（右上→左下）', dirs.back === 'cv-light-back', dirs);

  /* ---------- 8. 真实切换一轮，确认配色跟着方向走 ----------
     必须等足够久：开关有个 pageLockUntil（动画时长 + 90ms）的锁，
     而且在 reveal 没结束时点击会被直接忽略。前面第 6 步手动改过
     dataset.mode 并触发过 go，等它彻底静下来再点。 */
  await c.wait(4500);
  const themeBefore = await ev(`return document.documentElement.dataset.theme`);
  await ev(`
    window.__modeLog = [];
    const el = document.querySelector('.cv-sweep');
    new MutationObserver(() => {
      if (el.classList.contains('go')) window.__modeLog.push(el.dataset.mode);
    }).observe(el, { attributes: true, attributeFilter: ['class', 'data-mode'] });
    document.querySelector('#themeSwitchHost .tsw').click();
    return true;
  `);
  await c.wait(3000);
  const sw = await ev(`
    return {
      modes: window.__modeLog,
      theme: document.documentElement.dataset.theme,
    };
  `);
  const expectMode = sw.theme === 'dark' ? 'to-dark' : 'to-light';
  /* 主题确实切了才检查配色 —— 没切的话配色检查毫无意义，
     只会掩盖真正的问题（开关被锁）。 */
  check('确实切换了主题', sw.theme !== themeBefore, { themeBefore, after: sw.theme });
  if (sw.theme !== themeBefore) {
    check('切换后横扫用了对应的配色', sw.modes.includes(expectMode), { ...sw, expectMode });
  }

  /* 切回最初的主题 */
  await c.wait(2000);
  const nowT = await ev(`return document.documentElement.dataset.theme`);
  if (nowT !== theme0) {
    await ev(`document.querySelector('#themeSwitchHost .tsw').click(); return true`);
    await c.wait(2500);
  }
  const restored = await ev(`return document.documentElement.dataset.theme`);
  check('已切回原主题', restored === theme0, { restored, theme0 });

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  c.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('致命：', e.message);
  process.exit(2);
});

/** 读 PNG 里某点的颜色 */
function readPixel(file, x, y) {
  const { execFileSync } = require('child_process');
  const py = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
print(*im.getpixel((int(sys.argv[2]), int(sys.argv[3]))))
`;
  const out = execFileSync('python', ['-c', py, file, String(x), String(y)], { encoding: 'utf8' }).trim();
  const [r, g, b] = out.split(/\s+/).map(Number);
  return { r, g, b };
}
