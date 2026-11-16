/* ============================================================
   页面动效 · Aurora v2 适配层（行为部分）
   ------------------------------------------------------------
   配套 page-motion.css。这里只做三件事：

   1. 滑动指示器 / 分段滑块的定位
      给 .nav、.settings-nav 各塞一块 .pm-ind，给每个 .seg
      塞一块 .pm-pill，然后盯着 .is-active 的变化把它们滑过去。
      app.js 在十几处地方切 .is-active（导航、设置、筛选、
      同步设置 UI……），所以用 MutationObserver 统一兜底，
      不去改 app.js 的任何调用点。

   2. 卡片悬停倾斜
      pointermove 时按指针在卡片内的相对位置算 rotateX/Y，
      写成 CSS 变量 --rx/--ry（上限 1.6°，和参考版一致）。
      CSS 负责把变量拼进 transform。拖拽中（buttons 按下）
      不写变量，免得拖卡片时它一边走一边歪。

   3. 主题开关的 will-change 按需开关
      盯 .tsw-knob 的 style 变化（开关的物理循环逐帧写
      transform），动起来就给 .tsw 打 .is-moving，停 450ms
      后摘掉。CSS 那边据此决定 will-change 是否开启。

   揭幕克隆体 #appL 不用管：它每次揭幕开始时才克隆、结束就
   销毁，克隆会把指示器元素连同当时的 inline 位置一起带走，
   位置天然是对的；它不接事件，也不会有人去量它。

   减少动画时：指示器照样定位（CSS 已关掉过渡，表现为跳变），
   倾斜直接不启用。
   ============================================================ */

const reduceMotion = () =>
  document.documentElement.classList.contains('no-motion')
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- 1. 滑动指示器 ---------- */

const sliders = [];

/**
 * 给一个容器装滑动块。
 * @param {HTMLElement} box 容器（.nav / .settings-nav / .seg）
 * @param {string} itemSel 选项的选择器
 * @param {'v'|'h'} dir v = 竖排（量 top/height），h = 横排（量 left/width）
 */
function addSlider(box, itemSel, dir) {
  if (!box || box.dataset.pmSlider) return;
  box.dataset.pmSlider = '1';

  const ind = document.createElement('div');
  ind.className = dir === 'v' ? 'pm-ind' : 'pm-pill';
  ind.setAttribute('aria-hidden', 'true');
  box.prepend(ind);

  const s = { box, itemSel, dir, ind, raf: 0 };
  sliders.push(s);
  updateSlider(s, true);
  return s;
}

function updateSlider(s, first = false) {
  const act = s.box.querySelector(`${s.itemSel}.is-active`);
  if (!act) { s.ind.style.opacity = '0'; return; }
  /* 容器藏在没打开的弹窗里时 rect 全是 0，下面会统一藏起来，
     等弹窗打开（hidden 变化被观察者捕捉）再重新定位 */
  const r = act.getBoundingClientRect();
  const b = s.box.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) { s.ind.style.opacity = '0'; return; }

  if (first) {
    /* 首次定位不要滑：先关过渡摆好，再恢复，避免开局从角上飞过来 */
    s.ind.style.transition = 'none';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      s.ind.style.transition = '';
    }));
  }
  if (s.dir === 'v') {
    s.ind.style.transform = `translateY(${(r.top - b.top + s.box.scrollTop).toFixed(1)}px)`;
    s.ind.style.height = `${r.height.toFixed(1)}px`;
  } else {
    s.ind.style.transform = `translateX(${(r.left - b.left + s.box.scrollLeft).toFixed(1)}px)`;
    s.ind.style.width = `${r.width.toFixed(1)}px`;
    s.ind.style.top = `${(r.top - b.top + s.box.scrollTop).toFixed(1)}px`;
    s.ind.style.height = `${r.height.toFixed(1)}px`;
  }
  s.ind.style.opacity = '1';
  s.box.classList.add('pm-on');
}

function updateAllSliders() {
  for (const s of sliders) updateSlider(s);
}

function scheduleUpdate() {
  /* 同一帧里类名可能连变多次，合并成一次测量 */
  if (scheduleUpdate.raf) return;
  scheduleUpdate.raf = requestAnimationFrame(() => {
    scheduleUpdate.raf = 0;
    updateAllSliders();
  });
}

function initSliders() {
  document.querySelectorAll('.nav').forEach((el) => addSlider(el, '.nav-item', 'v'));
  document.querySelectorAll('.settings-nav').forEach((el) => addSlider(el, '.snav-item', 'v'));
  document.querySelectorAll('.seg').forEach((el) => addSlider(el, '.seg-btn', 'h'));

  /* .is-active 的一切变化 + 弹窗 hidden 的开关，都可能让位置失效 */
  new MutationObserver(scheduleUpdate).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'hidden'],
    subtree: true,
  });
  /* 点击后 app.js 的处理可能隔一帧才落类名，再补量一次 */
  document.addEventListener('click', () => {
    scheduleUpdate();
    setTimeout(scheduleUpdate, 60);
  }, true);
  window.addEventListener('resize', scheduleUpdate);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleUpdate).catch(() => {});
  }
  /* 布局稳定后再校准两次：侧栏要等设置恢复、目录树渲染完 */
  setTimeout(scheduleUpdate, 300);
  setTimeout(scheduleUpdate, 1200);
}

/* ---------- 2. 卡片倾斜 ---------- */

function initTilt() {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  let cur = null;

  document.addEventListener('pointermove', (e) => {
    if (reduceMotion() || e.pointerType === 'touch') return;
    const card = e.target.closest ? e.target.closest('.card') : null;
    if (!card || card.classList.contains('is-missing')) {
      if (cur) { cur.style.removeProperty('--rx'); cur.style.removeProperty('--ry'); cur = null; }
      return;
    }
    if (e.buttons > 0) return;               /* 拖拽中不歪 */
    if (!card.matches(':hover')) return;
    const r = card.getBoundingClientRect();
    if (r.width === 0) return;
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty('--ry', `${(px * 3.2).toFixed(2)}deg`);
    card.style.setProperty('--rx', `${(-py * 3.2).toFixed(2)}deg`);
    cur = card;
  }, { passive: true });

  document.addEventListener('pointerout', (e) => {
    if (cur && e.target === cur && !cur.contains(e.relatedTarget)) {
      cur.style.removeProperty('--rx');
      cur.style.removeProperty('--ry');
      cur = null;
    }
  });
}

/* ---------- 3. 主题开关 will-change 按需开关 ---------- */

function initSwitchWatch() {
  const attach = (knob) => {
    const host = knob.closest('.tsw');
    if (!host || host.dataset.pmWatch) return;
    host.dataset.pmWatch = '1';
    let timer = 0;
    new MutationObserver(() => {
      host.classList.add('is-moving');
      clearTimeout(timer);
      timer = setTimeout(() => host.classList.remove('is-moving'), 450);
    }).observe(knob, { attributes: true, attributeFilter: ['style'] });
  };

  const knob = document.querySelector('.tsw-knob');
  if (knob) { attach(knob); return; }
  /* 开关是 app.js 异步挂载的，等它出现 */
  const mo = new MutationObserver(() => {
    const k = document.querySelector('.tsw-knob');
    if (k) { attach(k); mo.disconnect(); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 15000);
}

/* ---------- 启动 ---------- */
/* 本文件以 module 方式在 app.js 之后加载，DOM 已就绪；
   app.js 的首轮渲染可能还没落完，所以指示器有 300/1200ms
   的两次延迟校准兜底（见 initSliders）。 */
initSliders();
initTilt();
initSwitchWatch();

/* ---------- 主题切换光线 ----------
   一条 45° 的液态玻璃光带横穿窗口。**配色跟着目的地走**：

     切到深色  月光白紫（夜色漫上来）  左下 ──▶ 右上
     切到浅色  阳光金黄（天亮了照进来）右上 ──▶ 左下

   两个方向共用同一套几何，方向靠 CSS 关键帧反过来（见 page-motion.css
   的 cv-light-fwd / cv-light-back）。

   ★ 触发为什么用 prepare 事件，而不是盯着 data-theme
   `document.documentElement.dataset.theme` 要等揭幕**播完**才更新
   （见 app.js 的 finishThemeReveal）。盯着它的话，光线只能等揭幕结束
   才开始，和圆扩散彻底脱节 —— 用户的原话是「光线出现得有点晚」。
   而且亮→暗那条路径在 prepare 阶段就会把 .app 先切成深色，用
   data-theme 判断方向还可能读到中间态，颜色会反。

   `cv:theme-transition-prepare` 是揭幕**建立的那一刻**派发的，
   detail 里带明确的 `to`（目标主题）。所有路径都会经过它：
     · 点开关 / 拖开关  → theme-switch.js 的 beginReveal
     · 设置面板 / 跟随系统 → app.js 的 animateThemeSwitch
   所以用它触发，光线和揭幕同一帧起步，时长也对齐（800ms），
   到终点时正好和揭幕一起收。

   ★ 只在有事情发生时扫
   以前这里还挂过「空闲时每 18 秒扫一次」的定时器，用户什么都没做
   界面就自己动，像故障重绘 —— 已经去掉。同理，主区背景层那个 26 秒
   的漂移动画（pmDrift）也删了，那才是用户反馈「没切主题也在横扫」的
   真正来源。装饰性动画不该在没有触发源的时候自己动。

   减少动画时整层不创建（设置里的开关和系统偏好都算）。
   样式在 page-motion.css 的 .cv-sweep。 */
function initSweep() {
  if (reduceMotion()) return;
  const el = document.createElement('div');
  el.className = 'cv-sweep';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);

  /**
   * 播一次。
   * @param {'dark'|'light'} target 目标主题 —— 决定配色和方向：
   *        到 dark 用 to-dark（月光紫、左下→右上）；
   *        到 light 用 to-light（阳光金、右上→左下）。
   */
  const play = (target) => {
    if (reduceMotion()) return;
    el.dataset.mode = target === 'dark' ? 'to-dark' : 'to-light';
    el.classList.remove('go');
    void el.offsetWidth;             /* 强制重排，让动画能重新开始 */
    el.classList.add('go');
    clearTimeout(el._t);
    /* 光带动画 1150ms（覆盖揭幕实测时长），留一点余量再摘类 */
    el._t = setTimeout(() => el.classList.remove('go'), 1300);
  };

  /* 开屏那一下：按当前主题选配色，和「刚从另一边切过来」同款 */
  setTimeout(() => {
    play(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, 900);

  /* 主题切换：在揭幕建立的那一刻同步起步 */
  window.addEventListener('cv:theme-transition-prepare', (e) => {
    const to = e.detail && e.detail.to;
    if (to !== 'dark' && to !== 'light') return;
    play(to);
  });
}
initSweep();
