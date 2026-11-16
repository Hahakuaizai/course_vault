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
  /* 阈值取 170 而不是 200：这条断言要区分的是「浅色标题栏」和
     「深色标题栏」——深色主题的标题栏是 rgb(26,25,23)，两者差着
     一个数量级。可采样点有时会落在标题栏文字或按钮的过渡边缘上
     （实测读到过 199,197,193），卡在 200 会偶发误报。170 既能
     稳稳排除深色（26），又不会被边缘像素绊倒。 */
  check('克隆层满幅时顶部是浅色（不是深色标题栏）',
    topRGB.r > 170 && topRGB.g > 170, topRGB);
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
    };
  `);
  /* 主光厚度应远小于窗口短边（原来的 30vmax 会铺满大半屏） */
  check('主光厚度小于窗口短边的 1/5', geo.mainH < Math.min(1280, 803) / 5,
    { mainH: geo.mainH, vmax: geo.vmax });
  check('弥散层比主光厚但不超过窗口短边的一半', geo.softH > geo.mainH && geo.softH < 803 / 2,
    { softH: geo.softH });

  /* ---------- 6. 两套配色 ---------- */
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
  /* 月光必须是**冷白**，不能带明显色相。旧版掺了紫色（158,132,255 一类），
     在深底上读成霓虹紫而不是月光，用户明确要求换成统一的月光白。
     这里断言 R/G/B 三个通道彼此接近（最大差 < 24），也就是「白」。 */
  const moonRGB = (styles.toDark.bg.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g) || [])
    .map((s) => s.match(/\d+/g).map(Number))
    .filter((c) => c[3] !== undefined ? c[3] > 0.3 : true);
  const moonMaxSpread = moonRGB.length
    ? Math.max(...moonRGB.map((c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])))
    : 999;
  check('切到深色是月光白（无色相，不是紫色）', moonMaxSpread < 24,
    { spread: moonMaxSpread, sample: moonRGB.slice(0, 3) });
  /* 切到浅色 = 阳光：白底上 screen 会糊成白，必须 normal */
  check('切到浅色那套用 normal（白底上才看得见）', styles.toLight.blend === 'normal', styles.toLight);
  check('切到浅色是金黄色（阳光）', /255,\s*1[89][0-9]|255,\s*2[0-4][0-9]/.test(styles.toLight.bg), styles.toLight.bg.slice(0, 100));

  /* ---------- 7. 位置由 pos 驱动，不是 CSS 关键帧 ----------
     改造后这里不再有 cv-light-fwd / cv-light-back 两组 @keyframes：
     光带的位置完全由 page-motion.js 按开关的 pos 算出 --p / --a 写进来。
     这正是参考文件（slider-follow-light.txt）的核心 —— 用关键帧或定时器
     驱动的话，滑块停在中间时光会自顾自扫到终点。

     ★ 前置：等开关的弹簧彻底停下来。
     前面第 3/4 步直接调过 __vaultThemeReveal.prepare / finish，而 finish
     会改 html 与 .app 的 data-theme —— 开关的 MutationObserver 看到变化
     就 setTarget 推一段弹簧，render() 于是每帧调 sweep.set(pos) 覆盖
     我们设的目标。实测这种情况下 u=0 读到的 --p 是 16.76 而不是 114，
     而且数值一直在变（光在追一个移动的目标）。这里先等它真正静止。 */
  await ev(`
    const el = document.querySelector('.cv-sweep');
    window.__qT0 = performance.now();
    window.__qP = new Promise((resolve) => {
      let prev = el.style.getPropertyValue('--p');
      let still = 0;
      const tick = () => {
        const cur = el.style.getPropertyValue('--p');
        still = cur === prev ? still + 1 : 0;
        prev = cur;
        if (still >= 8 || performance.now() - window.__qT0 > 8000) resolve(true);
        else setTimeout(tick, 100);
      };
      tick();
    });
    return true;
  `);
  await ev(`return window.__qP`);
  await c.wait(500);

  const drive = await ev(`
    const el = document.querySelector('.cv-sweep');
    const b = getComputedStyle(el, '::before');
    const api = window.__vaultSweep;
    if (!api) return { err: 'no __vaultSweep' };

    const read = () => ({
      p: +el.style.getPropertyValue('--p'),
      a: +el.style.getPropertyValue('--a'),
    });
    /* set() 现在只更新「目标」，光由它内部的 rAF 平滑追上来 —— 所以要
       等几帧再读，不能同步读（那是旧实现的语义）。用 8 帧 × 90ms 的
       时间常数，足够追到 95% 以上。 */
    const settle = () => new Promise((r) => setTimeout(r, 1400));

    /* ★ 冻结开关的 render 循环，整段测量期间都不能恢复。
       开关的 render() 每帧都会调 window.__vaultSweep.set(pos) —— 那是
       真实运行时的唯一驱动源，但在测试里它会持续覆盖我们设的目标：
       一旦把 api.set 换回原函数，光就跟着开关当前的位置走（实测
       停在 u≈0.76，p=16.76），而不是我们要的 0 / 0.5 / 1。
       所以把替换一直保持到全部读完，最后才恢复。 */
    const saved = { set: api.set, hide: api.hide };
    api.set = () => {}; api.hide = () => {};
    const setAndSettle = async (u) => { saved.set(u, 'to-dark'); await settle(); return read(); };

    const at0 = await setAndSettle(0);
    const atMid = await setAndSettle(0.5);
    const at1 = await setAndSettle(1);

    /* 停住：目标不变时，位置必须纹丝不动 */
    const freezeA = await setAndSettle(0.5);
    const freezeB = await setAndSettle(0.5);

    /* 全部读完再恢复，并主动把光收回屏外 */
    api.set = saved.set; api.hide = saved.hide;
    saved.hide();

    return {
      anim: b.animationName,
      at0, atMid, at1, freezeA, freezeB,
      hasKeyframes: [...document.styleSheets].some((s) => {
        try { return [...s.cssRules].some((r) => r.name === 'cv-light-fwd'); } catch { return false; }
      }),
    };
  `);
  check('没有 CSS 关键帧在驱动光带（cv-light-fwd 已删除）',
    drive.anim === 'none' && drive.hasKeyframes === false, { anim: drive.anim, kf: drive.hasKeyframes });
  check('u=0 时光在屏外且不可见', drive.at0.a === 0, drive.at0);
  check('u=0.5 时光在正中且最亮', Math.abs(drive.atMid.p - 50) < 0.5 && drive.atMid.a === 1, drive.atMid);
  check('u=1 时光在另一端屏外且不可见', drive.at1.a === 0, drive.at1);
  check('同一个 u 重复写，位置完全冻结（跟手停住的关键）',
    drive.freezeA.p === drive.freezeB.p && drive.freezeA.a === drive.freezeB.a,
    { a: drive.freezeA, b: drive.freezeB });

  /* ---------- 8. 真实切换一轮，确认配色跟着方向走 ----------
     必须等足够久：开关有个 pageLockUntil（动画时长 + 90ms）的锁，
     而且在 reveal 没结束时点击会被直接忽略。前面几步手动改过
     dataset.mode、也直接调过 __vaultSweep，等它彻底静下来再点。

     ★ 监听 data-mode 而不是 .go
     改造后没有 .go 这个类了（以前它负责启动 CSS 关键帧）。现在光的
     配色写在 data-mode 上，由 theme-switch.js 的 render() 每帧按 u 的
     变化方向设置。 */
  await c.wait(4500);
  const themeBefore = await ev(`return document.documentElement.dataset.theme`);
  await ev(`
    window.__modeLog = [];
    window.__pLog = [];
    const el = document.querySelector('.cv-sweep');
    new MutationObserver(() => window.__modeLog.push(el.dataset.mode))
      .observe(el, { attributes: true, attributeFilter: ['data-mode'] });
    /* 同时记 --p，确认它真的被推进过（不是一直停在屏外） */
    new MutationObserver(() => window.__pLog.push(+el.style.getPropertyValue('--p')))
      .observe(el, { attributes: true, attributeFilter: ['style'] });
    document.querySelector('#themeSwitchHost .tsw').click();
    return true;
  `);
  await c.wait(3000);
  const sw = await ev(`
    return {
      modes: window.__modeLog,
      pMin: Math.min(...window.__pLog),
      pMax: Math.max(...window.__pLog),
      n: window.__pLog.length,
      theme: document.documentElement.dataset.theme,
    };
  `);
  const expectMode = sw.theme === 'dark' ? 'to-dark' : 'to-light';
  /* 主题确实切了才检查配色 —— 没切的话配色检查毫无意义，
     只会掩盖真正的问题（开关被锁）。 */
  check('确实切换了主题', sw.theme !== themeBefore, { themeBefore, after: sw.theme });
  if (sw.theme !== themeBefore) {
    check('切换后横扫用了对应的配色', sw.modes.includes(expectMode), { ...sw, expectMode });
    /* 光确实扫过一整段：p 至少要跨过 40 个百分点，而不是原地不动 */
    check('切换过程中光带确实移动了', sw.pMax - sw.pMin > 40, { pMin: sw.pMin, pMax: sw.pMax, n: sw.n });
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

  /* ---------- 9. 连点之后不能留下克隆层 ----------
     用户反馈「dark 切到 light 后文件夹网格还是深色，要几秒才变白」。
     根因是连点时 beginReveal() 直接复用了上一轮的克隆层（`if (revealOn)
     return true`），但那一层是按旧目标主题建的，和新 target 对不上，
     于是收尾条件永远不成立 —— appL 这个 `.app` 的完整副本就留在 DOM 上，
     继续命中 `.app[data-theme='dark'] .card` 之类的规则，卡片保持深色。
     修法是 beginReveal 遇到进行中的揭幕先 endReveal(false) 收干净。 */
  await c.wait(3000);
  await ev(`
    const btn = document.querySelector('#themeSwitchHost .tsw');
    for (let i = 0; i < 3; i += 1) setTimeout(() => btn.click(), i * 700);
    return true;
  `);
  await c.wait(9000);
  const burst = await ev(`
    const apps = [...document.querySelectorAll('.app')];
    return {
      nApp: apps.length,
      hasAppL: !!document.getElementById('appL'),
      themes: apps.map((a) => a.getAttribute('data-theme')),
      htmlTheme: document.documentElement.dataset.theme,
      cardBg: document.querySelector('.card')
        ? getComputedStyle(document.querySelector('.card')).backgroundColor : null,
    };
  `);
  check('连点三次后 DOM 里只剩一个 .app（克隆层没有残留）',
    burst.nApp === 1 && !burst.hasAppL, burst);
  check('连点后 .app 与 html 的主题一致',
    burst.themes.every((t) => t === burst.htmlTheme), burst);
  if (burst.cardBg) {
    const dark = +burst.cardBg.match(/\d+/)[0] < 100;
    check('连点后卡片底色与主题一致（不再停在旧主题的深色）',
      (burst.htmlTheme === 'dark') === dark, { theme: burst.htmlTheme, cardBg: burst.cardBg });
  }

  /* ---------- 10. 揭幕期间克隆层自己的配色必须对 ----------
     用户第二次反馈「没修好」，截图是切换过程中卡片一片深色、标题深字
     压在深底上几乎看不见。

     ★ 这一条和上面第 9 条查的是**完全不同**的东西
     第 9 条查「克隆层有没有残留」，我之前的测试只测这个，所以一直
     显示通过。可真正的问题在揭幕**进行中**：
       · 克隆层 #appL 的 data-theme 恒为 light（它是浅色层）；
       · 而 html 的 data-theme 当时还是旧主题（prepare 不写，等 finish
         才落定）；
       · styles.css 里深色规则几乎都是并列双选择器
         `:root[data-theme='dark'] .card, .app[data-theme='dark'] .card`，
         克隆层里的卡片同时命中 `:root[data-theme='dark'] .card`（html
         还是 dark）和 `.app[data-theme='light'] .card`（克隆层自己），
         特异度相同、后写的赢 —— 深色那条在样式表里更靠后，于是克隆层
         的卡片被涂成 #262320。
       · 侧栏/工具栏走 CSS 变量，在克隆层自己的作用域里解析成浅色，
         所以看起来「侧栏浅、卡片深」。
     修法：prepare 里把 html 的 data-theme 同步成克隆层主题。
     下面逐帧采样，只要有一帧克隆层卡片配色与它自己的主题不符就算失败。 */
  const midOk = await ev(`
    const btn = document.querySelector('#themeSwitchHost .tsw');
    const snap = () => {
      const L = document.getElementById('appL');
      const D = document.querySelector('.app:not(#appL)');
      if (!L) return null;
      const c = L.querySelector('.card');
      if (!c) return null;
      const cs = getComputedStyle(c);
      const bg = cs.backgroundColor;
      const m = bg.match(/\\d+/g);
      return {
        Ltheme: L.getAttribute('data-theme'),
        html: document.documentElement.dataset.theme,
        Dtheme: D ? D.getAttribute('data-theme') : null,
        bg, color: cs.color,
        darkBg: m ? +m[0] < 100 : null,
      };
    };
    const bad = [];
    const seen = [];
    const t0 = performance.now();
    return new Promise((resolve) => {
      btn.click();
      const tick = () => {
        const s = snap();
        if (s) {
          seen.push(s);
          if (s.darkBg !== null && (s.Ltheme === 'dark') !== s.darkBg) bad.push(s);
        }
        if (performance.now() - t0 < 2600) setTimeout(tick, 60);
        else resolve({ bad, n: seen.length, sample: seen[0] || null, last: seen[seen.length - 1] || null });
      };
      setTimeout(tick, 60);
    });
  `);
  check('揭幕期间采到了克隆层（测试前提）', midOk.n > 0, midOk.n);
  check('揭幕期间克隆层卡片配色始终跟随克隆层主题（不再深底深字）',
    midOk.bad.length === 0, midOk.bad.slice(0, 2));
  if (midOk.sample) {
    check('揭幕期间 html 的 data-theme 已同步成克隆层主题',
      midOk.sample.html === midOk.sample.Ltheme, midOk.sample);
  }

  /* ---------- 11. 揭幕期间真实界面的卡片文字也要看得见 ----------
     ★ 这一条查的是**另一个**坑，和上面第 10 条不是同一处
     第 10 条修好之后（克隆层卡片变白了），用户截图里「深底深字」
     依然会出现，因为问题在**真实界面那一份**：
       · `body { color: var(--fg-1) }` 在 html=light 时就解析成了深色；
       · `.app[data-theme='dark']` 只把 --fg-1 换成暖白，可它自己
         没有 color 声明 —— 继承属性拿到的是 body 已经算好的**计算值**，
         不是变量本身。于是深底配深字，卡片标题几乎看不见。
       · 揭幕期间恰好就是这个组合：html 跟着克隆层是浅色，真实界面
         带着目标主题的 data-theme（暗→亮时是 dark）。
     修法：styles.css 里给 `.app` 补一条 `color: var(--fg-1)`，
     让它在自己的作用域里重新解析一次。克隆层 #appL 早就有同样一条
     （theme-transition.css），这次补齐真实界面那一份。
     这里断言：揭幕期间真实界面卡片的文字亮度必须与底色拉开距离。 */
  const contrast = await ev(`
    const D = document.querySelector('.app:not(#appL)');
    const L = document.getElementById('appL');
    if (!L) return { err: 'no clone' };
    const lum = (s) => {
      const m = s.match(/\\d+/g);
      if (!m) return null;
      return 0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2];
    };
    const card = D.querySelector('.card');
    if (!card) return { err: 'no card' };
    const cs = getComputedStyle(card);
    const name = card.querySelector('.card-name');
    return {
      bg: cs.backgroundColor,
      color: cs.color,
      nameColor: name ? getComputedStyle(name).color : null,
      bgLum: lum(cs.backgroundColor),
      fgLum: lum(cs.color),
      nameLum: name ? lum(getComputedStyle(name).color) : null,
      Dtheme: D.getAttribute('data-theme'),
      html: document.documentElement.dataset.theme,
    };
  `);
  if (!contrast.err) {
    check('揭幕期间真实界面卡片文字与底色有足够对比（不再深底深字）',
      Math.abs(contrast.fgLum - contrast.bgLum) > 80, contrast);
    if (contrast.nameLum !== null) {
      check('揭幕期间真实界面卡片标题与底色有足够对比',
        Math.abs(contrast.nameLum - contrast.bgLum) > 80, contrast);
    }
  }
  await ev(`window.__vaultThemeReveal.finish(false); return true`);
  await c.wait(1500);

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
