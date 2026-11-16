'use strict';

/* ============================================================
   弹性分隔条 · 目录栏（.sidebar）与主区（.main）之间
   ------------------------------------------------------------
   驱动方式：逐帧把目录栏宽度写进 .app 的内联变量 --sidebar-w
   （.sidebar 的 width/flex-basis 本来就读这个变量），把手位置
   与之同步。把手是一条二次贝塞尔曲线（80×160 SVG，双 path
   重叠描边），拖动时按指针速度弯曲、整条偏移，过界后橡皮筋
   并拉成长直细线，松手弹簧回弹。

   规格参数（适配版）：范围 = 场景宽 W 的 20%–40%，初始 26%；
   橡皮筋 p = t + sign(e)·15·(1−exp(−|e|/35))；位置弹簧
   刚度 400 / 阻尼 26（仅未拖动时积分，4 子步）；把手 B/O
   弹簧刚度 680 / 阻尼 34；S/L/R 以 1−exp(−32dt) 趋近。
   宽度比例存 localStorage（cv:sidebarFrac），重启保持；
   双击 / 非拖动 Escape 回到初始 26%。
   ============================================================ */

(() => {
  const app = document.querySelector('.app');
  const layout = document.querySelector('.layout');
  const handle = document.getElementById('elasticHandle');
  const live = document.getElementById('elasticLive');
  if (!app || !layout || !handle) return;

  const pathOuter = handle.querySelector('.elastic-handle-outer');
  const pathInner = handle.querySelector('.elastic-handle-inner');
  const svg = handle.querySelector('.elastic-handle-svg');

  /* ---------- 常量 ---------- */
  const FRAC_MIN = 0.20;
  const FRAC_MAX = 0.40;
  const FRAC_INIT = 0.26;
  const DESIGN_W = 1280;          // 首帧宽度为 0 时的设计宽度
  const STORE_KEY = 'cv:sidebarFrac';
  const HIDE_DELAY = 450;
  const RUBBER_MAX = 15;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, f) => a + (b - a) * f;

  /* 把手内层颜色：静止 #c9c2b8 → 拖动 #a39a8b（按 m 插值） */
  const COL_A = [201, 194, 184];
  const COL_B = [163, 154, 139];

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => mq.matches;

  /* ---------- 状态 ---------- */
  let W = layout.clientWidth || DESIGN_W;   // 场景宽度（.layout 宽）
  let frac = FRAC_INIT;
  try {
    const saved = parseFloat(localStorage.getItem(STORE_KEY) || '');
    if (Number.isFinite(saved)) frac = clamp(saved, FRAC_MIN, FRAC_MAX);
  } catch { /* 存储不可用就用初始值 */ }

  let t = frac * W;        // 目标位置（合法范围内）
  let p = t;               // 可见位置（含橡皮筋偏移）
  let v = 0;               // 位置速度（回弹弹簧）
  let B = 0, O = 0;        // 把手弯曲 / 横移
  let vB = 0, vO = 0;      // B/O 速度
  let L = 60, S = 0, R = 0; // 把手长度 / 粗细 / 透明度

  let dragging = false;
  let pointerId = null;
  let grabOffset = 0;      // 指针相对可见边缘的抓取偏移
  let startTarget = t;     // 本次按下前的目标（取消时恢复）
  let rawPrev = 0, rawTimePrev = 0;
  let speed = 0;           // 指针速度采样 s
  let lastMoveAt = 0;      // 最近一次 move 的时刻（ms）
  let overE = 0;           // 当前过界量 e（拖动中）

  let hovering = false;
  let focused = false;
  let hideTimer = 0;
  let rafId = 0;
  let lastTs = 0;

  const minPx = () => FRAC_MIN * W;
  const maxPx = () => FRAC_MAX * W;
  const shouldShow = () => hovering || dragging || focused;

  /* ---------- 呈现 ---------- */
  function apply() {
    app.style.setProperty('--sidebar-w', p.toFixed(2) + 'px');
    handle.style.left = p.toFixed(2) + 'px';
    const m = currentM;
    const d = `M ${(40 + O).toFixed(2)} ${(80 - L / 2).toFixed(2)} Q ${(40 + O + 2 * B).toFixed(2)} 80 ${(40 + O).toFixed(2)} ${(80 + L / 2).toFixed(2)}`;
    pathOuter.setAttribute('d', d);
    pathInner.setAttribute('d', d);
    pathOuter.setAttribute('stroke-width', (S + 2 * R).toFixed(2));
    pathInner.setAttribute('stroke-width', S.toFixed(2));
    pathInner.setAttribute('stroke',
      `rgb(${Math.round(lerp(COL_A[0], COL_B[0], m))},${Math.round(lerp(COL_A[1], COL_B[1], m))},${Math.round(lerp(COL_A[2], COL_B[2], m))})`);
    svg.style.opacity = R.toFixed(3);
  }

  let currentM = 0;

  function updateAria() {
    const now = (100 * t / W);
    const txt = now.toFixed(1);
    handle.setAttribute('aria-valuenow', txt);
    handle.setAttribute('aria-valuetext', `目录栏宽度百分之 ${txt}`);
    return txt;
  }

  function announce() {
    const txt = updateAria();
    if (live) live.textContent = `目录栏宽度百分之 ${txt}`;
  }

  function persist() {
    try { localStorage.setItem(STORE_KEY, String(clamp(t / W, FRAC_MIN, FRAC_MAX))); } catch { /* 忽略 */ }
  }

  /* ---------- 动画循环 ---------- */
  function ensureLoop() {
    if (!rafId) { lastTs = 0; rafId = requestAnimationFrame(loop); }
  }

  function loop(ts) {
    rafId = 0;
    if (!lastTs) lastTs = ts;
    let dt = Math.min((ts - lastTs) / 1000, 1 / 30);
    lastTs = ts;
    if (dt <= 0) dt = 0.0001;

    /* 速度采样过期（>70ms 无 move）或未拖动 → s 归零 */
    if (!dragging || performance.now() - lastMoveAt > 70) speed = 0;
    const d = clamp(speed / 60, -1, 1);
    const q = dragging ? clamp(Math.abs(overE) / 80, 0, 1) : 0;
    const m = Math.max(Math.abs(d) * (1 - q), q);
    currentM = m;

    const bT = reduced() ? 0 : 4.5 * d * (1 - q);
    const oT = reduced() ? 0 : 9 * d * (1 - q) + 6 * Math.sign(overE) * q;
    const lT = reduced() ? 60 : 60 + 30 * m + 21 * q;
    const rT = shouldShow() ? 1 : 0;
    const sT = (reduced() ? 15 : 15 - 10 * m - 2 * q) * rT;

    /* 子步积分：位置弹簧（仅未拖动）+ B/O 弹簧 */
    const h = dt / 4;
    for (let i = 0; i < 4; i++) {
      if (!dragging && !reduced()) {
        v += ((t - p) * 400 - v * 26) * h;
        p += v * h;
      }
      vB += ((bT - B) * 680 - vB * 34) * h;
      B += vB * h;
      vO += ((oT - O) * 680 - vO * 34) * h;
      O += vO * h;
    }
    const ease = 1 - Math.exp(-32 * dt);
    S += (sT - S) * ease;
    L += (lT - L) * ease;
    R += (rT - R) * ease;

    apply();

    /* 吸附与停机 */
    const settled =
      Math.abs(t - p) < 0.01 && Math.abs(v) < 0.05 &&
      Math.abs(bT - B) < 0.01 && Math.abs(vB) < 0.03 &&
      Math.abs(oT - O) < 0.01 && Math.abs(vO) < 0.03 &&
      Math.abs(sT - S) < 0.01 && Math.abs(lT - L) < 0.01 &&
      Math.abs(rT - R) < 0.001;
    if (settled && !dragging) {
      p = t; v = 0;
      B = 0; O = 0; vB = 0; vO = 0;
      L = 60; S = 15 * rT; R = rT;
      currentM = 0;
      apply();
      return; // 停 RAF
    }
    rafId = requestAnimationFrame(loop);
  }

  /* ---------- 显示 / 隐藏 ---------- */
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; } }
  function scheduleHide() {
    cancelHide();
    if (dragging || focused || hovering) return;
    hideTimer = setTimeout(() => { hideTimer = 0; ensureLoop(); }, HIDE_DELAY);
  }

  handle.addEventListener('pointerenter', () => { hovering = true; cancelHide(); ensureLoop(); });
  handle.addEventListener('pointerleave', () => {
    hovering = false;
    if (!dragging && !focused) scheduleHide(); else ensureLoop();
  });
  handle.addEventListener('focus', () => { focused = true; cancelHide(); ensureLoop(); });
  handle.addEventListener('blur', () => { focused = false; if (!hovering && !dragging) scheduleHide(); else ensureLoop(); });

  /* ---------- 拖动 ---------- */
  function localX(clientX) {
    return clientX - layout.getBoundingClientRect().left;
  }

  handle.addEventListener('pointerdown', (ev) => {
    if (dragging) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    dragging = true;
    pointerId = ev.pointerId;
    startTarget = t;
    grabOffset = localX(ev.clientX) - p;
    rawPrev = localX(ev.clientX) - grabOffset;
    rawTimePrev = ev.timeStamp;
    speed = 0;
    overE = 0;
    lastMoveAt = performance.now();
    cancelHide();
    try { handle.setPointerCapture(ev.pointerId); } catch { /* 忽略 */ }
    app.classList.add('elastic-dragging');
    ensureLoop();
    ev.preventDefault();
  });

  handle.addEventListener('pointermove', (ev) => {
    if (!dragging || ev.pointerId !== pointerId) return;
    const raw = localX(ev.clientX) - grabOffset;
    const dtSec = Math.max((ev.timeStamp - rawTimePrev) / 1000, 0.008);
    speed = clamp((raw - rawPrev) / dtSec, -2200, 2200);
    rawPrev = raw;
    rawTimePrev = ev.timeStamp;
    lastMoveAt = performance.now();

    t = clamp(raw, minPx(), maxPx());
    overE = raw - t;
    if (reduced()) {
      p = t;
      overE = 0;
    } else {
      p = t + Math.sign(overE) * RUBBER_MAX * (1 - Math.exp(-Math.abs(overE) / 35));
    }
    apply();
    ensureLoop();
  });

  function endDrag(cancelled) {
    if (!dragging) return;
    dragging = false;
    if (pointerId !== null) {
      try { handle.releasePointerCapture(pointerId); } catch { /* 已释放 */ }
    }
    pointerId = null;
    app.classList.remove('elastic-dragging');
    speed = 0;
    overE = 0;
    if (cancelled) t = startTarget;
    v = 0;
    if (reduced()) p = t;
    /* 捕获指针在界外松手：不保留虚假 hover */
    if (!focused) { hovering = false; scheduleHide(); }
    announce();
    persist();
    ensureLoop();
  }

  handle.addEventListener('pointerup', (ev) => { if (ev.pointerId === pointerId) endDrag(false); });
  handle.addEventListener('pointercancel', (ev) => { if (ev.pointerId === pointerId) endDrag(true); });
  handle.addEventListener('lostpointercapture', () => { if (dragging) endDrag(false); });

  /* ---------- 键盘 ---------- */
  function setTarget(next, silent) {
    t = clamp(next, minPx(), maxPx());
    if (reduced()) p = t;
    v = 0;
    if (!silent) { announce(); persist(); }
    ensureLoop();
  }

  handle.addEventListener('keydown', (ev) => {
    const step = (ev.shiftKey ? 0.06 : 0.02) * W;
    switch (ev.key) {
      case 'ArrowLeft': ev.preventDefault(); if (!dragging) setTarget(t - step); break;
      case 'ArrowRight': ev.preventDefault(); if (!dragging) setTarget(t + step); break;
      case 'Home': ev.preventDefault(); if (!dragging) setTarget(maxPx()); break;
      case 'End': ev.preventDefault(); if (!dragging) setTarget(minPx()); break;
      case 'Escape':
        ev.preventDefault();
        if (dragging) endDrag(true);
        else setTarget(FRAC_INIT * W);
        break;
    }
  });

  handle.addEventListener('dblclick', () => { if (!dragging) setTarget(FRAC_INIT * W); });

  /* ---------- 尺寸变化：保持比例与拖动状态 ---------- */
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const newW = entry.contentRect.width;
      if (!(newW > 0)) continue;             // 忽略 0 观测，不除以 0
      if (newW === W) continue;
      const ratio = newW / W;
      t *= ratio; p *= ratio; v *= ratio;
      startTarget *= ratio;
      W = newW;
      apply();
      updateAria();
    }
  });
  ro.observe(layout);

  /* ---------- 初始化 ---------- */
  apply();
  updateAria();
  ensureLoop();
})();
