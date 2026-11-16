/**
 * 主题揭幕 · 双份 DOM
 * ------------------------------------------------------------
 * 照抄 aurora-win11-fx.html 的核心机制：
 *
 *   页面上同时叠两份完整界面，下层 appD 是深色，上层 appL 是浅色。
 *   开关每帧写 `appL.style.clipPath = circle(R at 开关中心)`：
 *     R=0    → 只看得到 appD（深色）
 *     R=铺满 → 只看得到 appL（浅色）
 *   中间任意 R 就是「圆形边界」的过渡态。
 *
 *   因为是**逐帧**写的，拖动滑块时页面实时跟着变 —— 这正是 View
 *   Transition 做不到的：它只在切换瞬间拍一次快照，快照期间主线程
 *   还被冻结几十毫秒，既不能跟手，开关也显得「严重延迟」。
 *
 * 和参考版的一处必要差异：
 *   参考版是静态 demo，可以启动时克隆一次、永久复用。我们的界面是活的
 *   （会滚动、增删文件、切视图），静态克隆体很快就会和真实界面不一致。
 *   所以改成**每次拖动/点击开始时才克隆**（此刻两份内容与滚动位置完全
 *   一致），动画结束后立刻销毁。克隆实测 5~8ms，且发生在 pointerdown
 *   那一帧，用户感知不到。
 *
 * 暴露给 theme-switch.js 的接口挂在 window.__vaultThemeReveal 上，
 * 因为开关每帧都要写 clipPath，只有它知道 pos。
 */

/** 当前的揭幕层；null 表示没有正在进行的揭幕 */
let reveal = null;

/** 当前主题的「反面」 */
function otherTheme(name) {
  return name === 'dark' ? 'light' : 'dark';
}

/**
 * 开始一次揭幕：克隆当前界面，把克隆体设成目标主题，盖在上面。
 * 返回是否成功。失败时调用方走瞬时切换。
 *
 * @param {string} target 目标主题
 */
function prepareThemeReveal(target) {
  /* 已经有揭幕在跑：先收掉旧的，避免叠加多层 */
  if (reveal) finishThemeReveal(false);

  const appD = document.querySelector('.app');
  if (!appD) return false;

  const t0 = performance.now();

  /* 克隆。克隆体不接事件，所以不需要重绑任何监听器。 */
  const appL = appD.cloneNode(true);

  /* 克隆体里的 id 全部摘掉：
     · 避免 document.getElementById 拿到克隆体里的那一份
     · 克隆体只用来「看」，不需要被任何代码引用 */
  appL.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  appL.removeAttribute('id');
  appL.id = 'appL';

  /* 下层固定深色、上层固定浅色 —— 和参考版一致。
     这样 R 就单纯表示「浅色露出多少」，pos 和页面完全同源。 */
  appD.dataset.theme = 'dark';
  appL.dataset.theme = 'light';

  appL.setAttribute('aria-hidden', 'true');
  appL.style.position = 'fixed';
  appL.style.inset = '0';
  /* 低于弹窗（70）和开关的 popover 层，高于主界面 */
  appL.style.zIndex = '5';
  appL.style.pointerEvents = 'none';
  appL.style.clipPath = 'circle(0px at 0px 0px)';
  appL.style.willChange = 'clip-path';
  /* 独立合成层：clip-path 每帧变只重绘自己，不牵动整页 */
  appL.style.contain = 'strict';

  /* 克隆体的滚动位置要和原界面一致，否则一露出来就跳 */
  syncScroll(appD, appL);

  appD.parentNode.insertBefore(appL, appD.nextSibling);

  reveal = { appD, appL, target, cloneMs: performance.now() - t0 };
  return true;
}

/** 把 appD 里每个可滚动容器的 scrollTop/Left 抄到克隆体对应位置 */
function syncScroll(from, to) {
  const a = from.querySelectorAll('*');
  const b = to.querySelectorAll('*');
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i].scrollTop || a[i].scrollLeft) {
      b[i].scrollTop = a[i].scrollTop;
      b[i].scrollLeft = a[i].scrollLeft;
    }
  }
}

/**
 * 每帧写圆形裁剪。由 theme-switch.js 的 render() 调用。
 *
 * @param {number} u   开关位置：0 = 深色，1 = 浅色
 * @param {number} cx  开关中心 X（屏幕坐标）
 * @param {number} cy  开关中心 Y
 * @param {number} maxR 盖住整个窗口所需的半径
 */
function writeThemeReveal(u, cx, cy, maxR) {
  if (!reveal) return;
  const e = u * u * (3 - 2 * u);          // smoothstep，和参考版一致
  const r = Math.max(0, maxR * e);
  reveal.appL.style.clipPath =
    `circle(${r.toFixed(1)}px at ${cx.toFixed(1)}px ${cy.toFixed(1)}px)`;
}

/**
 * 结束揭幕：commit 的话把真实界面切成目标主题，然后销毁克隆体。
 *
 * @param {boolean} commit 是否真的切换（false = 用户拖到一半弹回去了）
 */
function finishThemeReveal(commit) {
  if (!reveal) return;
  const { appD, appL, target } = reveal;
  reveal = null;

  appL.remove();

  if (commit) {
    appD.dataset.theme = target;
    document.documentElement.dataset.theme = target;
    applyTheme(target, { titlebar: false });
    S.settings = { ...S.settings, theme: target, themeChoice: target };
    api.settings.set({ theme: target, themeChoice: target }).catch(() => {});
    syncThemeSwitch();
    syncSettingsUI();
  } else {
    appD.dataset.theme = document.documentElement.dataset.theme || 'light';
  }
}

/* 暴露给开关。开关每帧调用 writeThemeReveal。 */
window.__vaultThemeReveal = {
  prepare: prepareThemeReveal,
  write: writeThemeReveal,
  finish: finishThemeReveal,
  active: () => !!reveal,
};

/**
 * 从设置面板 / 跟随系统切换主题时的动画。
 * 这条路径没有拖动过程，所以自己推一个 rAF 把 u 从 0 走到 1（或反过来）。
 */
async function animateThemeSwitch(next) {
  const root = document.documentElement;
  const cur = root.dataset.theme;
  if (cur === next) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || root.classList.contains('no-motion');

  if (!ENABLE_THEME_TRANSITION || reduce || !prepareThemeReveal(next)) {
    finishThemeReveal(true);
    syncTitlebar(next);
    dispatchThemeEvent(THEME_EVENT_START, { to: next, durationMs: 0 });
    dispatchThemeEvent(THEME_EVENT_END, { to: next });
    return;
  }

  /* 圆心：开关在就取开关中心，不在就退回左下角 */
  const sw = document.querySelector('.tsw') || document.getElementById('btnTheme');
  const r = sw ? sw.getBoundingClientRect() : null;
  const W = root.clientWidth;
  const H = root.clientHeight;
  const cx = r && r.width ? r.left + r.width / 2 : 40;
  const cy = r && r.height ? r.top + r.height / 2 : H - 40;
  const maxR = Math.max(
    Math.hypot(cx, cy), Math.hypot(W - cx, cy),
    Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy),
  ) + 60;

  /* 目标：浅色是 u=1（圆铺满），深色是 u=0（圆收尽） */
  const from = cur === 'light' ? 1 : 0;
  const to = next === 'light' ? 1 : 0;

  dispatchThemeEvent(THEME_EVENT_START, { to: next, durationMs: THEME_ANIM_MS });

  await new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const q = Math.min(1, (performance.now() - t0) / THEME_ANIM_MS);
      const u = from + (to - from) * q;
      writeThemeReveal(u, cx, cy, maxR);
      if (q < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  finishThemeReveal(true);
  dispatchThemeEvent(THEME_EVENT_END, { to: next });
  syncTitlebar(next);
}

/** 只同步原生标题栏的配色（不重设页面主题） */
