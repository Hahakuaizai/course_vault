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
   一条 45° 的液态玻璃光带横穿窗口。**配色跟着方向走**：

     切到深色  月光白紫（夜色漫上来）  左下 ──▶ 右上
     切到浅色  阳光金黄（天亮了照进来）右上 ──▶ 左下

   ★ 位置由开关的 pos 直接驱动，不是一段自己跑完的动画
   参考文件（slider-follow-light.txt）的核心是这条链：

       pos ──▶ u ──▶ F = -.14 + 1.28u ──▶ p / A ──▶ 光的位置与亮度

   中间这环不能省。以前这里是「prepare 时给元素加个 .go 类，让 CSS
   @keyframes 自己跑 1150ms」—— 那时光不管滑块停在哪都会一路扫到终点，
   用户的原话是「想做成和滑块速度一致的光线，停在中间光也悬停中间」。
   现在改成：驱动方（开关的 render、设置面板的 rAF）每帧把当前 u 交给
   set()，由它算出 p / A 写进 CSS 变量。pos 不动 → u 不动 → 光冻结。

   ★ 两个驱动方，同一套 set()
     · 开关拖动 / 点击   theme-switch.js 的 render()，u 就是 pos（弹簧驱动）
     · 设置面板 / 跟随系统 app.js 的 animateThemeSwitch()，u 由 rAF 推
   所以两种路径的观感完全一致，只是 u 的来源不同。
   （原来还有第三个「开屏自跑一遍」，用户没切主题光也扫，已去掉。）

   ★ 只在有事情发生时动
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

  let lastP = NaN;
  let lastA = NaN;
  let mode = '';

  /* ---------- 平滑状态 ----------
     targetU 是驱动方给的「真实进度」，curU 是光实际走到的位置。
     非拖动的切换（点击开关 / 面板路径）里，光不追赶驱动进度 ——
     那种追赶起步必然迟滞（弹簧先要加速，前半秒光几乎不动）。
     改走自己的时间轴：切换开始的同一帧启动，按 BAND_MS 走完，
     与主题同时出发、比主题晚到达对侧。拖动时例外：光必须跟手，
     仍用二阶弹簧追赶（见 loop）。 */
  let targetU = null;
  let curU = null;
  let velU = 0; // 光的当前速度（拖动追赶的二阶弹簧用，见 loop）
  let dragging = false;
  let wantIdle = false;
  let raf = 0;
  let idleTimer = 0;
  let lastT = 0;

  /* 光带时间轴（2026-11-17 用户在预览页定版）：
     总时长 2.2s；进度 = 22% 起步偏移 + 78% × 混合缓动。
     起步偏移让亮条从屏幕边缘出发 —— 行程两端各有一截在屏外，
     没有偏移时前约 1/4 行程画面上什么都看不到，又会读成「光晚启动」。
     混合缓动 = 0.35×线性 + 0.65×smootherstep：起步即有约 35% 的
     平均速度（光立刻可见地动），中段提速，末段减速停稳。 */
  const BAND_MS = 2200;
  let bandActive = false;
  let bandFrom = 0;
  let bandTo = 0;
  let bandStart = 0;
  let bandDur = BAND_MS;
  const smootherstep = (q) => q * q * q * (q * (q * 6 - 15) + 10);
  const bandEase = (q) => 0.35 * q + 0.65 * smootherstep(q);
  const bandProgress = (q) => (q >= 1 ? 1 : 0.22 + 0.78 * bandEase(q));

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const ss = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };

  /** 把进度画成 CSS 变量（位置 + 亮度） */
  function paint(u) {
    const F = 1.14 - 1.28 * clamp01(u);
    const p = F * 100;
    const A = ss(-0.1, 0.03, F) * (1 - ss(0.97, 1.12, F));
    /* 死区：变化小到看不出来就不写，省掉无谓的样式重算。 */
    if (Math.abs(p - lastP) < 0.12 && Math.abs(A - lastA) < 0.004) return;
    lastP = p;
    lastA = A;
    el.style.setProperty('--p', p.toFixed(2));
    el.style.setProperty('--a', A.toFixed(3));
  }

  function clearVars() {
    lastP = NaN;
    lastA = NaN;
    targetU = null;
    curU = null;
    velU = 0;
    bandActive = false;
    el.style.setProperty('--p', '-14');
    el.style.setProperty('--a', '0');
  }

  function kick() {
    if (raf) return;
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
    /* ★ 兜底：窗口在后台 / 最小化时浏览器完全不派发 rAF，光会永远停在
       半路，等窗口回到前台才突然补上。用 setTimeout 并行推进 —— 后台
       的 setTimeout 被节流到约 1s 一次，但至少能把光推到终点，
       用户切回来时状态是对的（theme-switch.js 的 kick() 同款处理）。 */
    if (!idleTimer) {
      idleTimer = setTimeout(function backup() {
        idleTimer = 0;
        if (targetU === null || curU === null) return;
        /* 已经追上了：没有待办就收工，别空转 */
        if (curU === targetU) {
          if (wantIdle) clearVars();
          return;
        }
        loop(performance.now());
        /* loop 跑完如果 curU 还没到目标，说明 rAF 那一帧被浏览器丢了
           （窗口在后台时会这样）—— 继续用 setTimeout 推。注意判断
           条件必须是「还没到目标」，不能是「raf 为 0」：loop 在
           「已对齐但驱动方还在跑」的分支里本来就不会请求帧，
           用 raf 判断会让这个兜底每 120ms 空转一次。 */
        if (curU !== targetU && !idleTimer) idleTimer = setTimeout(backup, 120);
      }, 120);
    }
  }

  function loop(t) {
    raf = 0;
    if (targetU === null || curU === null) return;
    const dt = Math.min(64, Math.max(1, t - lastT)) / 1000;
    lastT = t;

    if (bandActive) {
      /* 时间轴驱动：位置只取决于切换开始后过了多久，与驱动方的
         弹簧 / rAF 进度完全脱钩 —— 同帧启动、按 bandDur 到达。 */
      const q = (t - bandStart) / bandDur;
      if (q >= 1) {
        curU = bandTo;
        bandActive = false;
        velU = 0;
      } else {
        curU = bandFrom + (bandTo - bandFrom) * bandProgress(q);
      }
      paint(curU);
    } else {
      /* 弹簧追赶：只剩拖动跟手和拖动收尾的小余量在走这里。
         omega 4.2（拖动）让光柔和跟随、不紧贴滑块；非拖动的 2.6
         只负责把拖动结束时光与目标之间的小差收平。 */
      const omega = dragging ? 4.2 : 2.6;
      const zeta = 1.05;
      let rest = dt;
      while (rest > 0) {
        const h = Math.min(rest, 1 / 120);
        rest -= h;
        const f = -omega * omega * (curU - targetU) - 2 * zeta * omega * velU;
        velU += f * h;
        curU += velU * h;
      }
      if (Math.abs(targetU - curU) < 0.0008 && Math.abs(velU) < 0.004) {
        curU = targetU;
        velU = 0;
      }
      paint(curU);
    }

    if (curU !== targetU) {
      raf = requestAnimationFrame(loop);
    } else if (wantIdle) {
      /* 驱动方说结束了，且光也追到了终点：清掉变量收工。
         注意是「追到终点之后才清」，不是一收到 hide 就清 ——
         否则光会在还差一截的地方突然消失。 */
      clearVars();
    } else {
      /* 已对齐但驱动方还在跑（比如弹簧停在中间）：保持不动，
         不再请求帧。等下一次 set() 再唤醒。 */
    }
  }

  /**
   * 按开关位置更新光的目标位置 —— 整条链的中间那环。
   *
   * @param {number} u 开关位置 0..1（0 = 深色端，1 = 浅色端）
   * @param {'to-dark'|'to-light'} [m] 配色；省略则沿用上一次
   * @param {boolean} [isDrag] 是否正在拖动（决定平滑的时间常数）
   *
   * 映射取自参考文件，但把方向倒了过来：
   *   F = 1.14 - 1.28 * u   → p = F * 100 ∈ [-14, 114]
   *   A = ss(-0.1, 0.03, F) * (1 - ss(0.97, 1.12, F))
   *
   *   u = 0（深色端） → p = 114, A = 0  光在右上屏外、不可见
   *   u = 0.5        → p =  50, A = 1  光压在正中、最亮
   *   u = 1（浅色端） → p = -14, A = 0  光在左下屏外、不可见
   *
   * ★ 为什么是 1.14 - 1.28u 而不是参考文件的 -0.14 + 1.28u
   * 参考版的 u 就是「亮的进度」，所以 u 涨光往一个固定方向走。
   * 我们的 u 是**揭幕的浅色进度**（0=深色、1=浅色），而验收过的方向是
   *   切到深色：左下 → 右上   （u 从 1 降到 0）
   *   切到浅色：右上 → 左下   （u 从 0 升到 1）
   * 要让 u 递减时光往右上走，p 必须随 u 递减 —— 于是符号反过来。
   * A 的两个端点不受影响：u=0/1 时 F=±1.14，两端的 smoothstep 都把它
   * 压成 0；u=0.5 时 F=0.5，A=1。位置和亮度的性质完全保留。
   */
  const set = (u, m, isDrag) => {
    if (m && m !== mode) { mode = m; el.dataset.mode = m; }
    const uu = clamp01(u);
    /* 首次（或刚从 hide 里恢复）：把光的起点对齐到 u。若模式的
       目标端不在当前位置，当场就启动时间轴 —— 和揭幕同帧出发。
       以前这里只做对齐便返回，要等驱动进度涨过 0.003 门槛才
       启动，光总是慢半拍（用户报的「起步太晚」之一）。 */
    if (curU === null) {
      curU = uu; velU = 0; targetU = uu; wantIdle = false;
      const end = m === 'to-light' ? 1 : (m === 'to-dark' ? 0 : null);
      if (!isDrag && end !== null && Math.abs(end - uu) > 0.003) {
        bandFrom = uu;
        bandTo = end;
        bandDur = BAND_MS;
        bandStart = performance.now();
        bandActive = true;
        targetU = end;
      }
      kick();
      return;
    }
    wantIdle = false;
    if (isDrag) {
      /* 拖动跟手：取消时间轴，回到弹簧追赶 */
      dragging = true;
      bandActive = false;
      targetU = uu;
      kick();
      return;
    }
    dragging = false;
    if (bandActive) return; // 时间轴跑着：驱动方的逐帧进度不再接管光
    if (Math.abs(uu - curU) > 0.003) {
      /* 切换开始：驱动进度刚离开光的当前位置（点击后约 1–2 帧内
         触发，感知上就是同一帧）。从光的当前位置向目标端点启动
         时间轴；开关弹簧停稳后的 ±0.0003 级尾巴抖动远小于 0.003
         的门槛，不会误触发第二次横扫。 */
      bandFrom = curU;
      bandTo = uu >= curU ? 1 : 0;
      bandDur = BAND_MS;
      bandStart = performance.now();
      bandActive = true;
      targetU = bandTo;
      kick();
      return;
    }
    /* 其余情况（拖动收尾的小余量、端点附近的尾巴）：交给弹簧收平 */
    targetU = uu;
    kick();
  };

  /* 显式启动横扫：驱动方在揭幕开始的那一帧调用，不再等 set()
     的进度门槛。durationMs 由驱动方按揭幕时长给（要求光到达
     对侧晚于揭幕完成，如面板路径 = THEME_ANIM_MS + 800）。
     起点优先用光的当前位置（连点/中途反向时不跳变），没有
     当前位置时用 fromU。 */
  const begin = (fromU, toU, m, durationMs) => {
    if (m && m !== mode) { mode = m; el.dataset.mode = m; }
    const startU = curU !== null ? curU : clamp01(fromU);
    curU = startU;
    velU = 0;
    bandFrom = startU;
    bandTo = clamp01(toU);
    bandDur = durationMs > 0 ? durationMs : BAND_MS;
    bandStart = performance.now();
    bandActive = true;
    targetU = bandTo;
    wantIdle = false;
    dragging = false;
    paint(curU);
    kick();
  };

  /** 驱动方宣告本次切换结束：等光追到终点后自行清空 */
  const hide = () => {
    wantIdle = true;
    if (curU === null || targetU === null) { clearVars(); return; }
    kick();
  };

  window.__vaultSweep = { set, hide, begin };

  /* 揭幕建立时先定好配色。位置不在这里推 —— 拖动路径下目的地还没定，
     theme-switch.js 会按拖动方向覆盖这个初始值。 */
  window.addEventListener('cv:theme-transition-prepare', (e) => {
    const to = e.detail && e.detail.to;
    if (to !== 'dark' && to !== 'light') return;
    mode = to === 'dark' ? 'to-dark' : 'to-light';
    el.dataset.mode = mode;
  });

  /* 开屏自动横扫已去掉：以前这里有个 900ms 后自跑一遍的「开屏那
     一下」，用户每次进软件、没切主题也会看到光扫过一遍，亮暗模式
     都如此，反馈像故障。光只在真正切换主题时由驱动方带动。 */
}
initSweep();
