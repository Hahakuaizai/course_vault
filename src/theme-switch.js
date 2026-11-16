/* ============================================================
   主题开关 · Aurora
   ------------------------------------------------------------
   照抄 aurora-win11-fx.html 的实现。

   ★ 上一版失败的原因
   我在 26px 的旋钮上「按可读性」重新设计了一套参数：9×9 点阵、
   non-scaling-stroke 的 1.2px 光弧、压缩过的轨道阴影、缺掉的
   .gw/.ig/gl/band 图层。结果形状、比例、层次全都不是参考版的样子。
   用户一眼看出「一点不像」。

   这一版的做法：**440×230 坐标系原样搬进来**，外层 CSS 用
   transform: scale() 缩到 60×30。所有内部数字（旋钮 200×200、
   光弧 viewBox 200、点阵 15×15 格、阴影 14px/30px、描边 22/14/8）
   一个字不改。

   ------------------------------------------------------------
   三套互相独立的物理/渲染：

   1. 旋钮位置 pos：弹簧积分（不是 CSS 过渡）。
      拖拽时直接跟手、松手带惯性弹向最近一端、撞到端点时回弹。
      每帧从 pos 算出位移、倾斜角、挤压系数（scaleX/scaleY）。

   2. 光弧 fa：另一个弹簧，fT(v) = 890 - 500*cl(v)（0~1000 单位）。
      它决定光弧沿旋钮轮廓滑到哪个位置，以及光晕/日冕/十字光点的坐标。

   3. 点阵粒子：月亮散成粒子云、再聚成太阳。
      每个点有「起点 / 云中位置 / 终点」三个坐标，按进度插值。

   全屏特效（光屑、碰撞火花、闪光、斜向光带）在开关之外，挂在 body 上。

   性能约定（沿用原文件的思路）：
     · 只在动画期间跑 rAF，静止时完全停下
     · 每帧只写 transform / opacity / canvas / CSS 变量
     · 不动画 blur / box-shadow / filter / width / height

   与页面揭幕的联动靠三个事件（见 app.js）：
     cv:theme-transition-prepare  揭幕拍快照之前
     cv:theme-transition-start    { to, durationMs }  揭幕动画开始
     cv:theme-transition-end      { to }              揭幕动画结束
   ============================================================ */

/* ---------- 回退开关 ----------
 * USE_NEW_THEME_SWITCH = false → 显示原来的主题按钮（旧按钮代码未删） */
export const USE_NEW_THEME_SWITCH = true;

/* 页面揭幕的时长与缓动。
   缓动取 smoothstep 的等价 bezier —— 参考版 waveClip 里套的就是
   `progress*progress*(3-2*progress)`。 */
export const THEME_ANIM_MS = 800;
export const THEME_EASE = 'cubic-bezier(0.5, 0, 0.5, 1)';

const EVT_START = 'cv:theme-transition-start';
const EVT_END = 'cv:theme-transition-end';
const EVT_PREPARE = 'cv:theme-transition-prepare';

/* ---------- 颜色表 ----------
   和参考版的 P 表一一对应。[暗, 亮] 或 [暗, 亮, 中点]。
   数组末位是 alpha。
   arc / arcw / glow / halo 有第三色（冰蓝中点），插值走两段。 */
const P = {
  t1: [[10, 14, 24], [249, 251, 255]],
  t2: [[19, 25, 39], [231, 238, 249]],
  tsa: [[0, 0, 0, 0.72], [112, 132, 166, 0.26]],
  tsb: [[190, 207, 255, 0.12], [255, 255, 255, 0.92]],
  drop: [[0, 0, 0, 0.46], [90, 112, 150, 0.24]],
  k1: [[151, 165, 202], [255, 255, 255]],
  k2: [[54, 65, 91], [225, 234, 247]],
  kh: [[255, 255, 255, 0.34], [255, 255, 255, 1]],
  kd: [[0, 0, 0, 0.55], [110, 95, 75, 0.4]],
  kb: [[228, 221, 255, 0.8], [255, 255, 255, 0.98]],
  kb2: [[190, 176, 255, 0.3], [255, 224, 168, 0.7]],
  kref: [[172, 146, 255, 0.22], [255, 196, 120, 0.52]],
  kouter: [[165, 142, 255, 0.22], [255, 186, 96, 0.58]],
  arc: [[212, 204, 255], [255, 204, 126], [224, 239, 255]],
  arcw: [[246, 244, 255], [255, 246, 225], [255, 255, 255]],
  glow: [[184, 162, 255, 0.52], [255, 190, 100, 0.9], [188, 216, 255, 0.38]],
  halo: [[160, 138, 255, 0.44], [255, 186, 108, 0.78], [176, 207, 255, 0.2]],
  pg: [[255, 255, 255, 0.4], [255, 255, 255, 0]],
};

/* ---------- 小工具 ---------- */
function mx(a, b, t) {
  const r = [];
  for (let i = 0; i < 4; i += 1) {
    const x = a[i] == null ? 1 : a[i];
    const y = b[i] == null ? 1 : b[i];
    r.push(x + (y - x) * t);
  }
  return r;
}
/** 颜色插值：有第三色时走两段（暗→中点→亮） */
function cm(key, t) {
  const p = P[key];
  return p[2]
    ? (t < 0.5 ? mx(p[0], p[2], t * 2) : mx(p[2], p[1], (t - 0.5) * 2))
    : mx(p[0], p[1], t);
}
function rgba(c, a) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${(a == null ? c[3] : a).toFixed(3)})`;
}
const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ss = (a, b, x) => {
  const t = cl((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}

function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || document.documentElement.classList.contains('no-motion');
}

/* ============================================================
   点阵：月亮 ↔ 太阳
   ------------------------------------------------------------
   15×15 格，每格 8 个 viewBox 单位，起始偏移 40（200 - 15×8 = 80，
   两边各 40）。px(i) 是第 i 格的中心，单位是 200 的 viewBox。

   月亮 = 半径 6 的圆（dx²+dy² > 36 跳过），减去偏右上的圆
          （中心 9.5, 5.5，半径 5.2）。剩下的月牙里，靠近挖空边缘
          （3.9 < d ≤ 5.2）隔一格留一个半透明点，形成网格质感。
          再加三个孤立的小点当「月坑」。

   太阳 = 5×5 中心块（x,y ∈ 5..9）+ 16 个射线点（上下左右各两对、
          四个斜角各两对）。
   ============================================================ */
const N = 15;
const S = 8;
const O = (200 - N * S) / 2;
const px = (i) => O + i * S + S / 2;

function buildParticles() {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  const moon = [];
  const sun = [];
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const dx = x - 7;
      const dy = y - 7;
      if (dx * dx + dy * dy > 36) continue;
      const d = Math.hypot(x - 9.5, y - 5.5);
      if (d > 5.2) moon.push([x, y, 1]);
      else if (d > 3.9 && (x + y) % 2 === 0) moon.push([x, y, 0.5]);
    }
  }
  [[11, 3], [13, 5], [12, 1]].forEach((s) => moon.push([s[0], s[1], 0.7]));

  for (let y = 5; y <= 9; y += 1) {
    for (let x = 5; x <= 9; x += 1) sun.push([x, y]);
  }
  [[7, 2], [7, 3], [7, 11], [7, 12], [2, 7], [3, 7], [11, 7], [12, 7],
    [2, 2], [3, 3], [12, 2], [11, 3], [2, 12], [3, 11], [12, 12], [11, 11]]
    .forEach((s) => sun.push(s));

  /* 打乱太阳点的顺序，让粒子飞过去时是交叉的，不是整块平移 */
  for (let i = sun.length - 1; i > 0; i -= 1) {
    const j = (rnd() * (i + 1)) | 0;
    const t = sun[i];
    sun[i] = sun[j];
    sun[j] = t;
  }

  /* 配对：第 i 个月亮点对应第 i 个太阳点。
     多出来的一边没有对应点，就用云中的随机位置 + 透明度 0 收尾。 */
  const parts = [];
  const K = Math.max(moon.length, sun.length);
  for (let i = 0; i < K; i += 1) {
    const ang = rnd() * 6.283;
    const rad = 16 + rnd() * 34;
    const sx = 100 + Math.cos(ang) * rad;
    const sy = 100 + Math.sin(ang) * rad;
    const m = moon[i];
    const s = sun[i];
    parts.push({
      fx: m ? px(m[0]) : sx,
      fy: m ? px(m[1]) : sy,
      fa: m ? m[2] : 0,
      tx: s ? px(s[0]) : sx,
      ty: s ? px(s[1]) : sy,
      ta: s ? 1 : 0,
      sx,
      sy,
      a: 0.1 + rnd() * 0.12,   // 散开的起始进度
      b: 0.5 + rnd() * 0.15,   // 聚拢的起始进度
      w: rnd() * 6.28,         // 抖动相位
    });
  }
  return parts;
}

/* ============================================================
   光弧
   ------------------------------------------------------------
   一条从左边中点出发、顺时针绕整个圆角矩形的 path，
   用 stroke-dasharray 控制显示哪一段 —— 所以光弧是**真的沿边缘滑**。
   六层叠加：外层宽而淡（光晕），内层窄而亮（核心）。
   描边宽度是 viewBox 相对值，不是 non-scaling-stroke。
   ============================================================ */
const ARC_D = 'M0 100V56A56 56 0 0 1 56 0H144A56 56 0 0 1 200 56V144'
  + 'A56 56 0 0 1 144 200H56A56 56 0 0 1 0 144V100';
const ARC_CFG = [
  [300, 22, 0.07],
  [290, 14, 0.1],
  [280, 8, 0.16],
  [260, 2.4, 0.35],
  [190, 3, 0.65],
  [110, 3.4, 1],
];

/* 光弧位置：暗态 890（左下），亮态 390（右侧偏下）。
   单位是 pathLength=1000 的千分比。 */
const fT = (v) => 890 - 500 * cl(v);

/* ============================================================
   挂载
   ============================================================ */

/**
 * 把 Aurora 开关挂到 host 里。返回是否挂载成功
 * （host 不存在时返回 false，调用方据此决定是否退回旧按钮）。
 *
 * @param {HTMLElement} host  放开关的容器（.foot-row 里的挂载点）
 * @param {{ onToggle?: () => void }} opts  onToggle 只调用现有的主题切换函数
 */
export function mountThemeSwitch(host, { onToggle } = {}) {
  if (!host || host.querySelector('.tsw')) return false;

  /* ---------- DOM ---------- */
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tsw';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', 'false');
  btn.setAttribute('aria-label', '深色模式');
  btn.title = '切换深色 / 浅色（可拖动）';
  btn.setAttribute('popover', 'manual');

  btn.innerHTML = `
    <span class="tsw-dock">
      <span class="tsw-track"></span>
      <span class="tsw-halo"></span>
      <span class="tsw-cor"><i></i><b></b></span>
      <span class="tsw-knob">
        <span class="tsw-gw">
          <span class="tsw-ig"></span>
          <span class="tsw-swp"></span>
        </span>
        <span class="tsw-sheen"></span>
        <canvas class="tsw-cv" aria-hidden="true"></canvas>
        <svg class="tsw-arcs" viewBox="0 0 200 200" aria-hidden="true">${
  ARC_CFG.map((c) => `<path pathLength="1000" d="${ARC_D}" stroke-width="${c[1]}" opacity="${c[2]}"/>`).join('')
}</svg>
        <span class="tsw-gl"></span>
      </span>
    </span>`;

  const dock = btn.querySelector('.tsw-dock');
  const knob = btn.querySelector('.tsw-knob');
  const halo = btn.querySelector('.tsw-halo');
  const cor = btn.querySelector('.tsw-cor');
  const swp = btn.querySelector('.tsw-swp');
  const ig = btn.querySelector('.tsw-ig');
  const gl = btn.querySelector('.tsw-gl');
  const canvas = btn.querySelector('.tsw-cv');
  const ctx = canvas.getContext('2d');
  const arcs = Array.from(btn.querySelectorAll('.tsw-arcs path'));
  const arcRef = arcs[1];

  /* ---------- 全屏特效层 ----------
     挂在 body 上而不是按钮里：开关只有 60×30，光屑和光带要铺满窗口。 */
  const fxCanvas = document.createElement('canvas');
  fxCanvas.className = 'tsw-fx';
  const band = document.createElement('div');
  band.className = 'tsw-band';
  document.body.append(fxCanvas, band);
  const fc = fxCanvas.getContext('2d');

  /* ---------- 性能档 ---------- */
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const lowPower = mem <= 4 || cores <= 4;
  const fxLimit = lowPower ? 28 : 96;
  const fxDpr = lowPower ? 1 : 2;

  /* ---------- 物理状态 ---------- */
  const SK = 11.5;   // 旋钮弹簧刚度
  const SC = 5.1;    // 旋钮阻尼
  const KF = 130;    // 光弧弹簧刚度
  const CF = 10.5;   // 光弧阻尼

  let pos = isDark() ? 0 : 1;
  let xv = 0;
  let target = pos;
  let drag = false;
  let down = false;
  let moved = false;
  let onKnob = false;
  let fa = fT(pos);
  let fv = 0;
  let press = 0;
  let pressT = 0;
  let impact = 0;
  let impactV = 0;
  let last = 0;
  let raf = 0;
  /* rAF 被后台节流时的兜底定时器（见 kick 的说明） */
  let fallbackTimer = 0;
  /* 上一次 kick 的时刻：用来发现「raf 标记卡住」的情况 */
  let lastKickAt = 0;
  let sx0 = 0;
  let downPid = null;
  let p0 = 0;
  /* 拖动开始时的旋钮位置：松手时用来判断「拖了多远」 */
  let dragOrigin = 0;
  let lt = 0;
  let moving = false;
  let lastUp = 0;
  let userSet = false;

  /* ---------- 渲染缓存 ---------- */
  let lastTT = -1;
  let lastPE = -1;
  let lastClipK = NaN;
  let lastBandA = -1;
  let lastBandF = NaN;
  let lastDrawU = -1;
  let lastDrawT = -1;
  let lastArcF = NaN;
  let lastF = null;
  let side = null;
  let hitS = 0;
  let hitSide = 0;
  let lastHit = 0;

  /* ---------- 粒子与闪光 ---------- */
  const pts = [];
  const fl = [];
  let rip = null;
  let fxOn = false;

  /* ---------- 尺寸 ----------
     scX / scY：dock 坐标系（440×230）到屏幕像素的缩放。
     dl / dtp ：dock 左上角在屏幕上的位置。
     fxSc     ：全屏特效的尺度。

     为什么 fxSc 不直接用 scX：参考版在桌面上 sc≈0.6（440×0.6=264px
     的开关），特效尺寸是按那个尺度设计的。我们的开关只有 60px，
     scX≈0.136，直接套会让所有特效缩到参考版的 22%，小得看不见。
     取 0.45（≈198px 的开关）做保底 —— 和参考版 max(.4, sc) 的
     保底思路一致，因为用户要的是「开关 60×30，特效照抄」。 */
  let W = window.innerWidth;
  let H = window.innerHeight;
  let scX = 84 / 440;
  let scY = 42 / 230;
  let fxSc = 0.45;
  let dl = 0;
  let dtp = 0;
  let dT = 0.9;
  let canvasSize = 0;
  let dpr = 1;

  /* ---------- 揭幕联动 ---------- */
  let pageLockUntil = 0;
  let pendingLift = false;
  let waitingReveal = false;
  let lifted = false;
  let liftPlaceholder = null;
  let lowerTimer = 0;
  let lowerTicket = 0;

  /* ---------- 绘制：点阵 ---------- */
  let parts = [];

  function draw(u, tt) {
    if (!ctx || !canvasSize) return;
    ctx.clearRect(0, 0, 200, 200);
    /* 点的颜色：tt=0（暗）偏暖橙，tt=1（亮）深蓝。
       两种底色上都有足够对比。 */
    ctx.fillStyle = `rgb(${(9 + 225 * (1 - tt)) | 0},${(17 + 166 * (1 - tt)) | 0},${(48 + 88 * (1 - tt)) | 0})`;
    for (let n = 0; n < parts.length; n += 1) {
      const p = parts[n];
      const e1 = ss(p.a, p.a + 0.3, u);       // 散开进度
      const c1 = ss(p.b, p.b + 0.3, u);       // 聚拢进度
      const w = Math.sin(u * 9 + p.w) * 4 * e1 * (1 - c1);
      const a = lerp(lerp(p.fa, 0.9, e1), p.ta, c1);
      if (a < 0.02) continue;
      const X = lerp(lerp(p.fx, p.sx, e1) + w, p.tx, c1);
      const Y = lerp(lerp(p.fy, p.sy, e1) + w * 0.7, p.ty, c1);
      /* 散开时点变小，聚拢时恢复原尺寸 */
      const z = (S - 1.2) * (1 - 0.5 * e1 * (1 - c1));
      if (tt < 0.97) {
        /* 过渡期间给每个点加一圈淡光晕 */
        ctx.globalAlpha = a * 0.16 * (1 - tt);
        ctx.fillRect(X - z * 0.95, Y - z * 0.95, z * 1.9, z * 1.9);
      }
      ctx.globalAlpha = a;
      ctx.fillRect(X - z / 2, Y - z / 2, z, z);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- 全屏光波 ----------
     和页面揭幕同心同半径的圆形裁剪（参考版直接写在 appL 上，
     我们交给 View Transition 的伪元素，这里只算半径给光屑用）。 */
  function waveRadius(u) {
    const maxR = Math.hypot(W, H) + 120;
    return maxR * u * u * (3 - 2 * u);
  }

  function fxSize() {
    const d = Math.min(window.devicePixelRatio || 1, fxDpr);
    fxCanvas.width = Math.round(W * d);
    fxCanvas.height = Math.round(H * d);
    fc.setTransform(d, 0, 0, d, 0, 0);
  }

  /* 光波前沿：与圆形裁剪同心同半径的亮环（暂未使用，保留给 band 用） */
  function ringCss(c, A, x, y, R) {
    const s = (a) => rgba(c, a * A);
    return `radial-gradient(circle at ${x.toFixed(1)}px ${y.toFixed(1)}px,`
      + `transparent ${Math.max(0, R - 70).toFixed(1)}px,`
      + `${s(0.2)} ${Math.max(0, R - 12).toFixed(1)}px,`
      + `rgba(255,255,255,${(0.85 * A).toFixed(3)}) ${R.toFixed(1)}px,`
      + `${s(0.26)} ${(R + 10).toFixed(1)}px,`
      + `transparent ${(R + 64).toFixed(1)}px)`;
  }

  /* 斜向光带：亮暗交界处扫过的一道白光，跟着 F（-14% → 114%）走 */
  function bandCss(c, A, p) {
    const s = (a) => rgba(c, a * A);
    return `radial-gradient(ellipse 28% 34% at ${p}% ${100 - p}%,`
      + `rgba(190,205,255,${(0.18 * A).toFixed(3)}),transparent 72%),`
      + `linear-gradient(to bottom left,transparent ${p - 3}%,`
      + `rgba(255,255,255,${(0.8 * A).toFixed(3)}) ${p}%,transparent ${p + 0.8}%),`
      + `linear-gradient(to bottom left,transparent ${p - 9}%,`
      + `${s(0.34)} ${p - 1}%,${s(0.3)} ${p + 1.5}%,transparent ${p + 14}%),`
      + `linear-gradient(to bottom left,transparent ${p - 30}%,`
      + `${s(0.1)} ${p}%,transparent ${p + 34}%)`;
  }

  /* 光屑：从滑块边缘沿光波法线发射，随后阻尼消散 */
  function spawnWave(cx, cy, radius, delta, c) {
    if (reduceMotion() || Math.abs(delta) < 0.0001) return;
    let count = Math.min(
      24,
      Math.floor(Math.abs(delta) * Math.max(0.5, Math.min(W, H)) * 0.23 + Math.random()),
    );
    const dir = delta >= 0 ? 1 : -1;
    while (count > 0 && pts.length < fxLimit) {
      count -= 1;
      const a = Math.random() * Math.PI * 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const jitter = (Math.random() - 0.5) * 15;
      const speed = (54 + Math.random() * 92) * dir;
      pts.push({
        x: cx + cs * (radius + jitter),
        y: cy + sn * (radius + jitter),
        px: cx + cs * (radius + jitter),
        py: cy + sn * (radius + jitter),
        vx: cs * speed + (Math.random() - 0.5) * 18,
        vy: sn * speed + (Math.random() - 0.5) * 18,
        l: 0,
        life: 0.48 + Math.random() * 0.62,
        r: 0.55 + Math.random() * 1.35,
        tail: 5 + Math.random() * 13,
        tw: Math.random() * 6.283,
        c,
      });
    }
  }

  function ripple(ix, iy, c) {
    if (!reduceMotion() && !lowPower) rip = { t: performance.now(), x: ix, y: iy, c };
  }

  /* ---------- 绘制：全屏特效 ---------- */
  function drawFx(dt) {
    if (!pts.length && !rip && !fl.length) {
      if (fxOn) { fc.clearRect(0, 0, W, H); fxOn = false; }
      return;
    }
    fxOn = true;
    fc.clearRect(0, 0, W, H);
    const now = performance.now();

    /* 闪光：5 种，各自的时长（毫秒） */
    for (let j = fl.length - 1; j >= 0; j -= 1) {
      const f = fl[j];
      const q = (now - f.t) / [340, 900, 700, 460, 620][f.k];
      if (q < 0) continue;
      if (q >= 1) { fl.splice(j, 1); continue; }

      /* k=3 冲击环、k=4 白闪 */
      if (f.k >= 3) {
        const a3 = (1 - q) * (1 - q);
        if (f.k === 3) {
          /* 竖直拉长的光斑 */
          const hh = (120 + 60 * f.s) * fxSc;
          const ww = (26 + 34 * f.s) * fxSc * (0.6 + 0.8 * q);
          fc.save();
          fc.translate(f.x, f.y);
          fc.scale(ww / hh, 1);
          const g3 = fc.createRadialGradient(0, 0, 0, 0, 0, hh);
          g3.addColorStop(0, `rgba(255,255,255,${(0.8 * a3).toFixed(3)})`);
          g3.addColorStop(0.3, rgba(f.c, 0.42 * a3));
          g3.addColorStop(1, rgba(f.c, 0));
          fc.fillStyle = g3;
          fc.beginPath(); fc.arc(0, 0, hh, 0, 6.283); fc.fill();
          fc.restore();
        } else {
          /* 横向拉扁的冲击环 */
          const rr = (24 + 120 * f.s) * fxSc * (0.25 + q * 1.1);
          fc.save();
          fc.translate(f.x + (f.side ? -1 : 1) * rr * 0.35, f.y);
          fc.scale(0.55, 1);
          fc.lineWidth = Math.max(1, (6 - 5 * q) * fxSc * 1.6);
          fc.strokeStyle = rgba(f.c, 0.55 * a3);
          fc.beginPath(); fc.arc(0, 0, rr, 0, 6.283); fc.stroke();
          fc.restore();
        }
        continue;
      }

      const al = (1 - q) * (1 - q);
      const Rr = f.k === 0
        ? (60 + 110 * f.s) * fxSc * (0.55 + q * 0.9)
        : (70 + 40 * q) * fxSc * 1.8;
      const gr = fc.createRadialGradient(f.x, f.y, 0, f.x, f.y, Rr);
      gr.addColorStop(0, `rgba(255,255,255,${(0.85 * al).toFixed(3)})`);
      gr.addColorStop(0.35, rgba(f.c, 0.3 * al));
      gr.addColorStop(1, rgba(f.c, 0));
      fc.fillStyle = gr;
      fc.beginPath(); fc.arc(f.x, f.y, Rr, 0, 6.283); fc.fill();
      fc.lineCap = 'round';

      if (f.k === 0) {
        /* 碰撞：一道白色竖光 + 一段圆弧 */
        const h = (92 + 30 * f.s) * fxSc;
        const sd = f.side ? Math.PI - 1.35 : -1.35;
        fc.lineWidth = Math.max(1.6, 10 * fxSc * (1 - q));
        fc.strokeStyle = `rgba(255,255,255,${(0.85 * al).toFixed(3)})`;
        fc.beginPath(); fc.moveTo(f.x, f.y - h); fc.lineTo(f.x, f.y + h); fc.stroke();
        fc.lineWidth = 1.5;
        fc.strokeStyle = rgba(f.c, 0.55 * al);
        fc.beginPath();
        fc.arc(f.x, f.y, (14 + 110 * f.s) * fxSc * q + 6 * fxSc, sd, sd + 2.7);
        fc.stroke();
      } else if (f.k === 1) {
        /* 亮到位：12 条放射线 */
        for (let r = 0; r < 12; r += 1) {
          const an = r * 0.5236 + q * 0.5;
          const r0 = Rr * 0.4;
          const r1 = Rr * (0.75 + 0.3 * (r % 2));
          fc.lineWidth = (r % 2 ? 1.2 : 2.2) * Math.max(0.7, fxSc * 2);
          fc.strokeStyle = rgba(f.c, 0.55 * al);
          fc.beginPath();
          fc.moveTo(f.x + Math.cos(an) * r0, f.y + Math.sin(an) * r0);
          fc.lineTo(f.x + Math.cos(an) * r1, f.y + Math.sin(an) * r1);
          fc.stroke();
        }
      } else {
        /* 暗到位：一圈圆环 */
        fc.lineWidth = 1.5;
        fc.strokeStyle = rgba(f.c, 0.45 * al);
        fc.beginPath(); fc.arc(f.x, f.y, Rr * (0.5 + q * 0.7), 0, 6.283); fc.stroke();
      }
    }

    /* 光屑 */
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      p.l += dt;
      if (p.l >= p.life) { pts.splice(i, 1); continue; }
      const f = 1 - p.l / p.life;
      const damp = Math.exp(-1.35 * dt);
      const tw = 0.72 + 0.28 * Math.sin(p.l * 18 + p.tw);
      const a = f * f * ss(0, 0.12, p.l) * tw;
      p.px = p.x; p.py = p.y;
      p.vx *= damp;
      p.vy *= damp;
      if (p.g) p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const dx = p.x - p.px;
      const dy = p.y - p.py;
      const mag = Math.hypot(dx, dy) || 1;
      const tx = p.x - (dx / mag) * p.tail;
      const ty = p.y - (dy / mag) * p.tail;
      fc.lineCap = 'round';
      fc.lineWidth = Math.max(0.45, p.r * 0.9);
      fc.strokeStyle = rgba(p.c, 0.26 * a);
      fc.beginPath(); fc.moveTo(tx, ty); fc.lineTo(p.x, p.y); fc.stroke();
      fc.fillStyle = rgba(p.c, 0.2 * a);
      fc.beginPath(); fc.arc(p.x, p.y, p.r * 3.8, 0, 6.283); fc.fill();
      fc.fillStyle = `rgba(255,255,255,${(0.86 * a).toFixed(3)})`;
      fc.beginPath(); fc.arc(p.x, p.y, p.r * (0.62 + 0.22 * tw), 0, 6.283); fc.fill();
      if (p.star) {
        const L = p.r * (5 + 4 * tw) * (f + 0.3);
        fc.lineWidth = Math.max(0.5, p.r * 0.45);
        fc.strokeStyle = `rgba(255,255,255,${(0.8 * a).toFixed(3)})`;
        fc.beginPath();
        fc.moveTo(p.x - L, p.y); fc.lineTo(p.x + L, p.y);
        fc.moveTo(p.x, p.y - L); fc.lineTo(p.x, p.y + L);
        fc.stroke();
      }
    }

    /* 涟漪：切换过中点时从开关位置扩散一圈 */
    if (rip) {
      const t = (performance.now() - rip.t) / 1100;
      if (t >= 1) rip = null;
      else {
        const R = (1 - (1 - t) ** 3) * Math.min(Math.max(W, H) * 0.4, 480);
        const al = (1 - t) ** 1.6;
        fc.lineWidth = 2 + 10 * (1 - t);
        fc.strokeStyle = rgba(rip.c, 0.4 * al * ss(0, 0.08, t));
        fc.beginPath(); fc.arc(rip.x, rip.y, R, 0, 6.283); fc.stroke();
        fc.lineWidth = 4 + 14 * (1 - t);
        fc.strokeStyle = rgba(rip.c, 0.05 * al * ss(0, 0.08, t));
        fc.beginPath(); fc.arc(rip.x, rip.y, R, 0, 6.283); fc.stroke();
      }
    }
  }

  /* ---------- 光弧坐标查询 ----------
     用 SVG 的 getPointAtLength 拿到弧上某点的位置（viewBox 200×200）。
     这个调用有成本，所以缓存一张「采样表」，按需插值。 */
  let arcSamples = null;

  function buildArcSamples() {
    if (!arcRef || typeof arcRef.getTotalLength !== 'function') return;
    const total = arcRef.getTotalLength();
    if (!total) return;
    const Ns = 96;
    arcSamples = [];
    for (let i = 0; i <= Ns; i += 1) {
      const p = arcRef.getPointAtLength((i / Ns) * total);
      arcSamples.push({ x: p.x, y: p.y });
    }
  }

  function arcPointAt(u) {
    if (!arcSamples || !arcSamples.length) return { x: 100, y: 100 };
    const f = cl(u) * (arcSamples.length - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(arcSamples.length - 1, i0 + 1);
    const t = f - i0;
    return {
      x: lerp(arcSamples[i0].x, arcSamples[i1].x, t),
      y: lerp(arcSamples[i0].y, arcSamples[i1].y, t),
    };
  }

  /* ---------- 渲染一帧 ---------- */
  function render() {
    const u = cl(pos);
    const F = -0.14 + 1.28 * u;
    /* tt：颜色/点阵的归一化进度。dT 是开关中心相对窗口中心的归一化
       位置（开关在左下角时约 0.9），让颜色切换的时机和开关在屏幕上
       的位置相关 —— 参考版的原设计。 */
    const tt = ss(dT - 0.04, dT + 0.04, F);
    const kx = 15 + 210 * u;
    const wcx = kx + 100;
    const wcy = 115;

    /* --- 页面揭幕：每帧写 appL 的 clip-path ---
       ★ 这是整套动画的核心。参考版就是这么做的（见它的 render() 里
       `appL.style.clipPath = clipNow`），所以拖动滑块时页面实时跟随。
       圆心取开关中心的屏幕坐标，半径取「盖住整个窗口」所需的距离。 */
    if (revealActive()) {
      if (revealMoving()) revealStarted = true;
      /* 圆心/半径由 app.js 的 writeThemeReveal 按参考版 waveClip
         统一计算（锚点随 u 在左上区域移动），这里只报开关位置 */
      writeRevealAt(u);
    }

    /* --- 斜向光带 --- */
    const A = ss(-0.1, 0.03, F) * (1 - ss(0.97, 1.12, F));
    const arcC = cm('arc', u);
    if (Math.abs(A - lastBandA) > 0.018 || Math.abs(F * 100 - lastBandF) > 1.25) {
      band.style.background = A > 0.01 ? bandCss(arcC, A, F * 100) : 'none';
      lastBandA = A;
      lastBandF = F * 100;
    }

    /* --- 颜色：整块控件跟着 tt 走 --- */
    if (lastTT < 0 || Math.abs(tt - lastTT) > 0.004
      || ((tt === 0 || tt === 1) && tt !== lastTT)) {
      lastTT = tt;
      for (const q in P) dock.style.setProperty(`--${q}`, rgba(cm(q, tt)));
      const a2 = (tt * tt).toFixed(3);
      cor.style.opacity = a2;
      swp.style.opacity = a2;
      cor.style.visibility = tt < 0.01 ? 'hidden' : 'visible';
    }

    /* --- 旋钮 --- */
    const spd = Math.min(1, Math.abs(xv) / 1.6);
    const hit = cl(impact);
    const pr = 1 - 0.025 * press;
    const sx = (1 + 0.018 * spd) * (1 - 0.085 * hit) * pr;
    const sy = (1 - 0.014 * spd) * (1 + 0.062 * hit) * pr;
    const tilt = Math.max(-1.15, Math.min(1.15, xv * 0.22));
    const atLeft = pos < 0.002;
    const atRight = pos > 0.998;
    const origin = atLeft ? '0% 50%' : atRight ? '100% 50%' : '50% 50%';
    /* 贴在右端时以右边缘为原点缩放，左边缘会向右移 200*(1-sx)，
       补回来，旋钮才是「原地被压扁」而不是「被推离右墙」。 */
    const visualX = kx + (atRight ? 200 * (1 - sx) : 0);
    knob.style.transformOrigin = origin;
    knob.style.transform = `translate3d(${visualX}px,0,0) rotate(${tilt.toFixed(3)}deg) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;

    /* --- 光弧 --- */
    const st = 1 + Math.min(0.6, Math.abs(fv) / 700) + 0.1 * spd;
    const fm = ((fa % 1000) + 1000) % 1000;
    if (!Number.isFinite(lastArcF) || Math.abs(fm - lastArcF) > 0.65) {
      lastArcF = fm;
      for (let n = 0; n < arcs.length; n += 1) {
        const len = Math.min(960, ARC_CFG[n][0] * st);
        arcs[n].setAttribute('stroke-dasharray', `${len} ${1000 - len}`);
        arcs[n].setAttribute('stroke-dashoffset', -(fm - len / 2));
      }
    }

    /* 光弧当前位置 → 光晕 / 内辉光 / 十字光点 / 日冕 */
    const pt = arcPointAt(fm / 1000);
    ig.style.transform = `translate3d(${pt.x.toFixed(1)}px,${pt.y.toFixed(1)}px,0)`;
    gl.style.transform = `translate3d(${pt.x.toFixed(1)}px,${pt.y.toFixed(1)}px,0) scale(${(0.8 + 0.5 * Math.min(1, Math.abs(fv) / 300)).toFixed(3)})`;
    gl.style.opacity = ((0.32 + 0.34 * tt) * (0.7 + 0.3 * Math.min(1, Math.abs(fv) / 300))).toFixed(3);
    halo.style.transform = `translate3d(${(kx + pt.x).toFixed(1)}px,${(15 + pt.y).toFixed(1)}px,0)`;
    cor.style.transform = `translate3d(${(kx + 100).toFixed(1)}px,115px,0)`;

    /* --- 点阵 --- */
    if (Math.abs(u - lastDrawU) > 0.0025 || Math.abs(tt - lastDrawT) > 0.0025) {
      draw(u, tt);
      lastDrawU = u;
      lastDrawT = tt;
    }

    /* 越过「亮/暗」分界时在光弧位置放一圈涟漪 */
    const sd = tt > 0.5;
    if (side !== null && sd !== side) {
      ripple(dl + (kx + pt.x) * scX, dtp + (15 + pt.y) * scY, cm('arc', tt));
    }
    side = sd;

    /* --- 全屏光屑：pos 每变一点就沿波前发射 --- */
    const waveR = waveRadius(u);
    if (lastF !== null && !reduceMotion()) {
      spawnWave(dl + wcx * scX, dtp + wcy * scY, 100 * scX + waveR, u - lastF, arcC);
    }
    lastF = u;

    const dark = u < 0.5;
    btn.setAttribute('aria-checked', dark ? 'true' : 'false');
    btn.setAttribute('aria-label', dark ? '深色模式' : '浅色模式');
  }

  /* ---------- 物理 ---------- */
  function step(dt) {
    if (!drag) {
      xv += (SK * (target - pos) - SC * xv) * dt;
      pos += xv * dt;
      if (pos < 0) {
        if (xv < -0.18) { hitS = Math.min(1, -xv / 2.4); hitSide = 0; }
        pos = 0;
        xv = Math.max(0, -xv * 0.24);
      }
      if (pos > 1) {
        if (xv > 0.18) { hitS = Math.min(1, xv / 2.4); hitSide = 1; }
        pos = 1;
        xv = Math.min(0, -xv * 0.24);
      }
    }
    fv += (KF * (fT(pos) - fa) - CF * fv) * dt;
    fa += fv * dt;
    press += (pressT - press) * Math.min(1, dt * 14);
    impactV += (-105 * impact - 19 * impactV) * dt;
    impact += impactV * dt;
    impact = Math.max(0, Math.min(1, impact));
  }

  function settled() {
    return !drag
      && Math.abs(target - pos) < 5e-4
      && Math.abs(xv) < 2e-3
      && Math.abs(fT(pos) - fa) < 0.15
      && Math.abs(fv) < 0.4
      && Math.abs(pressT - press) < 0.01
      && impact < 0.002
      && Math.abs(impactV) < 0.02;
  }

  /* 旋钮是否已经落到端点。
   *
   * 为什么不直接用 settled() 判断揭幕结束：光弧弹簧（KF=130）追的是
   * fT(pos)，一个 0~1000 量级的值，欠阻尼衰减到 0.15 以内要好几秒，
   * 而这一路上页面早就该切完了。用 settled() 会让 appL 一直挂着、
   * 主题迟迟不提交（实测拖完 3 秒还没切换）。
   * 揭幕只关心「旋钮到没到」，光弧还在收尾无所谓。 */
  function knobArrived() {
    return !drag
      && Math.abs(target - pos) < 0.004
      && Math.abs(xv) < 0.05;
  }

  /* 揭幕是否真的在推进：旋钮离开过原位、或者已经和目标端拉开距离。
   *
   * 为什么需要这一条：pointerdown 只是「按下」，此刻 pos == target
   * （还没决定往哪边去）。如果没有这个判断，knobArrived() 立刻为真，
   * frame() 第一帧就把揭幕层收掉 —— 表现就是「按下瞬间 appL 建了又没了」。
   * 参考版不存在这个问题，因为它压根没有「按下就建层」这一步，
   * 揭幕层是常驻的。 */
  function revealMoving() {
    return Math.abs(pos - target) > 0.01 || Math.abs(xv) > 0.05 || drag;
  }

  function frame(t) {
    const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
    const n = Math.ceil(dt / 0.008) || 1;
    last = t;
    for (let i = 0; i < n; i += 1) step(dt / n);

    if (hitS > 0) { burst(hitSide, hitS); hitS = 0; }

    /* 揭幕收尾：只看旋钮到没到位，不等光弧弹簧收干净。
       先把最后一帧的 clipPath 写满/写空，再提交并销毁克隆体 ——
       顺序不能反，否则克隆体停在中间态、真实界面已经换了主题。 */
    if (revealOn && revealStarted && knobArrived()) {
      pos = target;
      xv = 0;
      render();
      const curDark = isDark();
      const wantDark = target === 0;
      /* 目标主题和当前不同才提交；拖到一半弹回原位就只删层 */
      endReveal(wantDark !== curDark);
    }

    if (settled()) {
      if (moving) { moving = false; arrive(); }
      pos = target;
      xv = 0;
      fa = fT(pos);
      fv = 0;
      press = pressT;
      impact = 0;
      impactV = 0;
    } else {
      moving = true;
    }

    render();
    drawFx(dt);
    raf = (!settled() || pts.length || rip || fl.length) ? requestAnimationFrame(frame) : 0;
  }

  function kick() {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
      lastKickAt = last;
    } else if (performance.now() - lastKickAt > 200) {
      /* raf 非 0 但已经 200ms 没有新帧：说明那一帧的 rAF 回调被浏览器
         丢掉了（窗口切到后台时会这样，rAF 被完全停掉，回调永不执行）。
         此时 raf 这个标记卡在非 0，后续 kick 全部空转 —— 表现就是
         「点了没反应」。这里强制重启循环。 */
      last = performance.now();
      lastKickAt = last;
      raf = requestAnimationFrame(frame);
    }
    /* 兜底：窗口在后台时 rAF 不派发，用 setTimeout 推进。
       后台 setTimeout 也被节流到 1s 一次，但至少能把动画推完 ——
       等窗口回到前台，界面状态是对的。 */
    if (!fallbackTimer) {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = 0;
        if (settled()) return;
        last = performance.now();
        frame(performance.now());
      }, 60);
    }
  }

  /* ---------- 到位：亮色是日冕光芒与暖色光屑上浮，暗色是月晕与冷色星尘 ---------- */
  function arrive() {
    if (reduceMotion()) return;
    const light = target === 1;
    const tc = cm('arc', light ? 1 : 0);
    const n = Math.min(fxLimit - pts.length, light ? (lowPower ? 10 : 24) : (lowPower ? 6 : 14));
    fl.push({
      k: light ? 1 : 2,
      x: dl + (light ? 325 : 115) * scX,
      y: dtp + 115 * scY,
      t: performance.now(),
      s: 1,
      c: tc,
    });
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * 6.283;
      const sp = (30 + Math.random() * 70) * (0.7 + fxSc);
      const x0 = dl + (light ? 325 : 115) * scX + Math.cos(a) * 30 * fxSc;
      const y0 = dtp + 115 * scY + Math.sin(a) * 30 * fxSc;
      pts.push({
        x: x0, y: y0, px: x0, py: y0,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (light ? 26 : 10),
        g: light ? -40 : 0,
        l: 0,
        life: 1 + Math.random() * 0.9,
        r: 0.7 + Math.random() * 1.4,
        tail: 3 + Math.random() * 7,
        tw: Math.random() * 6.283,
        c: tc,
        star: light && Math.random() < 0.4,
      });
    }
  }

  /* ---------- 碰撞：火花沿壁面迸出、闪光、冲击环，并让光弧受撞摆动 ---------- */
  function burst(sideIdx, s) {
    if (reduceMotion()) return;
    const light = lastTT > 0.5;
    const px0 = dl + (sideIdx ? 425 : 15) * scX;
    const py0 = dtp + 115 * scY;
    const tc = cm('arc', cl(lastTT < 0 ? 0 : lastTT));
    const hot = light ? [255, 150, 60] : [225, 235, 255];
    const dir = sideIdx ? -1 : 1;
    const now = performance.now();
    const n = Math.min(
      fxLimit - pts.length,
      Math.round((lowPower ? 10 : 18) + s * (lowPower ? 10 : 26)),
    );
    for (let i = 0; i < n; i += 1) {
      const a = (Math.random() - 0.5) * 2.4;
      const sp = (110 + Math.random() * 300) * (0.5 + s) * (0.7 + fxSc * 0.6);
      const y = py0 + (Math.random() - 0.5) * 110 * fxSc;
      const shard = !light && Math.random() < 0.3;
      pts.push({
        x: px0, y, px: px0, py: y,
        vx: Math.cos(a) * sp * dir,
        vy: Math.sin(a) * sp - 40,
        g: 380,
        l: 0,
        life: 0.5 + Math.random() * 0.6,
        r: 0.9 + Math.random() * 1.5,
        tail: shard ? 26 + Math.random() * 22 : 8 + Math.random() * 16,
        tw: Math.random() * 6.283,
        c: Math.random() < 0.4 ? hot : tc,
        star: light ? Math.random() < 0.4 : Math.random() < 0.15,
      });
    }
    fl.push({ k: 0, x: px0, y: py0, t: now, s, side: sideIdx, c: tc });
    fl.push({ k: 3, x: px0, y: py0, t: now, s, side: sideIdx, c: hot });
    if (s > 0.45) fl.push({ k: 4, x: px0, y: py0, t: now + 70, s, side: sideIdx, c: tc });

    knob.classList.remove('is-hit');
    void knob.offsetWidth;
    knob.classList.add('is-hit');

    fv += (sideIdx ? 1 : -1) * (160 + s * 520);
  }

  /* ---------- 尺寸 ---------- */
  function place() {
    const r = btn.getBoundingClientRect();
    W = window.innerWidth;
    H = window.innerHeight;
    if (r.width) {
      scX = r.width / 440;
      scY = r.height / 230;
      dl = r.left;
      dtp = r.top;
      fxSc = Math.max(0.45, Math.min(scX, scY) * 3.3);
    }
    /* dT：开关中心相对窗口中心的归一化位置。
       参考版用它的平均值来延迟颜色切换 —— 开关在左下角时 dT≈0.9，
       意味着颜色要等光波快扫到开关才变。 */
    if (r.width) {
      dT = ((W - (r.left + r.width / 2)) / W + (r.top + r.height / 2) / H) / 2;
    }
    fxSize();
  }

  function resize() {
    const kr = knob.getBoundingClientRect();
    if (!kr.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvasSize = 200 * Math.max(0.4, scX);
    const cs = Math.round(canvasSize * dpr);
    canvas.width = cs;
    canvas.height = cs;
    ctx.setTransform(cs / 200, 0, 0, cs / 200, 0, 0);
    lastDrawU = -1;
    lastDrawT = -1;
    parts = buildParticles();
    buildArcSamples();
    place();
    render();
  }

  /* ---------- 揭幕期间浮到 top layer ----------
   *
   * View Transition 的快照覆盖层在 top layer 的最上方，实时 DOM 全被它盖住。
   * 揭幕这 800ms 里开关就算在下面一帧帧地画，用户也看不见，只能等揭幕结束
   * 才看到它开始动 —— 那就是「开关比页面慢半拍」的来源。
   *
   * popover 是在覆盖层之后进入 top layer 的，所以能浮在揭幕之上：
   * 从点击那一刻起，开关就和页面揭幕同步演变。
   * 提升后元素脱离文档流，先插一个同尺寸占位，免得底下那一行重排。 */
  const canLift = typeof btn.showPopover === 'function';

  function lower() {
    clearTimeout(lowerTimer);
    if (liftPlaceholder) {
      liftPlaceholder.remove();
      liftPlaceholder = null;
    }
    if (lifted) {
      lifted = false;
      try {
        if (btn.matches(':popover-open')) btn.hidePopover();
      } catch { /* 忽略 */ }
    }
    btn.style.left = '';
    btn.style.top = '';
    btn.style.width = '';
    btn.style.height = '';
  }

  function lift() {
    if (lifted || !canLift || !btn.isConnected) return false;
    const rect = btn.getBoundingClientRect();
    if (!rect.width) return false;

    lowerTicket += 1;
    clearTimeout(lowerTimer);

    liftPlaceholder = document.createElement('span');
    liftPlaceholder.className = 'tsw-placeholder';
    liftPlaceholder.style.width = `${rect.width}px`;
    liftPlaceholder.style.height = `${rect.height}px`;
    btn.parentNode.insertBefore(liftPlaceholder, btn);

    btn.style.left = `${rect.left}px`;
    btn.style.top = `${rect.top}px`;
    btn.style.width = `${rect.width}px`;
    btn.style.height = `${rect.height}px`;
    try {
      btn.showPopover();
      lifted = btn.matches(':popover-open');
    } catch { /* 不支持：退回普通渲染 */ }

    if (!lifted) {
      lower();
      return false;
    }
    /* 兜底：万一某次流程没收尾，别让它一直压在 top layer 上 */
    lowerTimer = setTimeout(() => lower(), 4000);
    return true;
  }

  function scheduleLower() {
    if (!lifted) return;
    const ticket = ++lowerTicket;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (ticket !== lowerTicket || !lifted) return;
      lower();
    }));
  }

  function scheduleLowerIn(ms) {
    if (!lifted) return;
    const ticket = ++lowerTicket;
    clearTimeout(lowerTimer);
    lowerTimer = setTimeout(() => {
      if (ticket !== lowerTicket || !lifted) return;
      lower();
    }, ms);
  }

  /* ---------- 目标设置 ---------- */
  function setTarget(t, sys) {
    if (!sys) userSet = true;
    target = t;
    btn.setAttribute('aria-checked', t === 1 ? 'true' : 'false');
    if (reduceMotion()) {
      pos = t;
      xv = 0;
      fa = fT(pos);
      fv = 0;
    }
    kick();
  }

  /* ---------- 事件：拖拽 ----------
     三种操作都要支持，否则用起来会觉得这是个假开关：
       1. 点一下      → 切换（在 pointerup 里判定）
       2. 按住拖动    → 旋钮跟手，松手按过没过半决定落哪边
       3. 拖到一半松手 → 弹回原位
     另外拖到端点以外会「撞墙」：挤压 + 火花 + 回弹。

     ★ 两处曾把开关做成「点不动、拖不了」，都已修：
     ① 切换判定放在 click 里，还加了 `performance.now() - lastUp < 80` 的
        防抖 —— 但鼠标点击的 detail 恒为 1、pointerup 就在几毫秒前，
        结果每次点击都被这行拦掉。现在照参考版：切换在 pointerup 里做，
        click 只处理键盘（detail === 0）。
     ② 拖动要求 pointerdown 落在旋钮上（onKnob），点轨道拖不动。
        现在整个按钮都能拖，只有「按下时在旋钮上」才做按压变形。 */
  btn.addEventListener('pointerdown', (e) => {
    /* 鼠标/触控按下不要抢焦点：否则开关会带着 :focus-visible 的
       紫色光圈（theme-switch.css / page-motion.css 各有一套），
       要点到别处失焦才消失。键盘 Tab 的焦点不受影响，光圈保留。
       preventDefault 不拦 pointermove 和后续的 click 判定。 */
    e.preventDefault();
    down = true;
    moved = false;
    downPid = e.pointerId;
    onKnob = !!e.target.closest('.tsw-knob');
    sx0 = e.clientX;
    p0 = pos;
    dragOrigin = pos;
    lt = performance.now();
    if (onKnob) pressT = 1;
    /* 无论按在哪都抓指针：手指/鼠标滑出按钮后还要继续跟手 */
    try { btn.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    /* ★ 按下就建好揭幕层：这样用户一开始拖，页面就能跟着动。
       此刻还没决定切到哪边，克隆体按「当前主题的反面」建 ——
       反正 pos 走到哪边，clipPath 就写到哪边，两份 DOM 都是齐的。 */
    const revealOk = beginReveal();
    if (window.__tswDebug) window.__tswDebugDown = { revealOk, appL: !!document.getElementById('appL') };
    if (revealOk) {
      /* ★ 把开关顶到揭幕层之上（lift 的原理见其注释）。
         事件路径（设置面板里切换）靠 onPrepare/onStart 做这件事，
         但开关自己的路径（pointerdown/toggle）不派发那两个事件，
         以前就没人顶 —— 动画期间用户看到的是克隆体里冻住的开关
         副本，真开关在克隆层底下动，观感是「页面切完了滑块才
         开始动」+「拖的时候滑块不跟手、像卡住」。这里补上。 */
      if (!lifted) lift();
      /* 进 top layer 后指针捕获可能被浏览器丢掉，重新抓一次，
         免得拖出按钮范围就跟丢 */
      if (lifted && downPid != null) {
        try { btn.setPointerCapture(downPid); } catch { /* 忽略 */ }
      }
    }
    kick();
  });

  btn.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - sx0;
    if (!moved && Math.abs(dx) > 4) { moved = true; drag = true; }
    if (!drag) return;

    /* 行程 210 是 dock 坐标里旋钮的可移动距离（440 - 2×15 - 200 = 210） */
    const raw = p0 + dx / (210 * scX);
    let np = Math.max(0, Math.min(1, raw));
    const now = performance.now();
    const dtm = Math.max(8, now - lt);

    /* 靠近端点时有一点「磁吸」 */
    if (raw >= 0 && raw < 0.13) {
      const m = 1 - raw / 0.13;
      np = Math.max(0, np - 0.032 * m * m);
    } else if (raw <= 1 && raw > 0.87) {
      const mr = (raw - 0.87) / 0.13;
      np = Math.min(1, np + 0.032 * mr * mr);
    }

    /* 拖出端点：撞墙 */
    if ((raw < 0 && dx < 0) || (raw > 1 && dx > 0)) {
      const strength = Math.max(0, Math.min(1,
        Math.abs(raw - np) * 2.4 + Math.abs(dx / (210 * scX)) * 0.08));
      impactV = Math.max(impactV, 2.2 + strength * 5);
      impact = Math.min(0.85, impact + 0.22 + strength * 0.42);
      if (now - lastHit > 160) {
        lastHit = now;
        hitS = Math.min(1, 0.25 + strength * 0.9);
        hitSide = raw < 0 ? 0 : 1;
      }
    }

    xv = xv * 0.55 + ((np - pos) / dtm * 1000) * 0.45;
    pos = np;
    lt = now;
    kick();
  });

  /* ---------- 揭幕：开关接管整个生命周期 ----------
   *
   * 参考版里开关就是动画的唯一驱动源：它在自己的 rAF 里每帧写
   * `appL.style.clipPath = circle(...)`，页面因此跟着 pos 实时变。
   * 我们也照做 —— 只有开关知道 pos 的当前值。
   *
   * 三个时机：
   *   beginReveal()  pointerdown / 键盘切换那一刻：建双份 DOM
   *   render()       每帧：写 clipPath（见上面 render 里的 revealActive 分支）
   *   endReveal()    弹簧到位那一刻：提交并销毁克隆体
   *
   * 圆心和半径不在这里算：参考版的 waveClip 锚点在窗口左上区域
   * （随 u 在 (115,115)↔(325,115) 之间移动），与开关在屏幕上的
   * 位置无关，由 app.js 的 writeThemeReveal 统一按同式计算。
   */
  let revealOn = false;
  /* 揭幕是否真的开始推进过（旋钮动过）。见 revealMoving 的说明 */
  let revealStarted = false;

  const revealApi = () => window.__vaultThemeReveal || null;
  const revealActive = () => revealOn;

  /** 把开关位置报给 app.js 写 clip-path。
   *  克隆体永远是浅色层（见 app.js prepareThemeReveal），所以 u
   *  本身就是「浅色露出多少」：0 = 全暗，1 = 全亮，不用再换算。 */
  function writeRevealAt(u) {
    const api = revealApi();
    if (!api) return;
    api.write(u);
  }

  function beginReveal() {
    if (revealOn) return true;
    const api = revealApi();
    /* 目标主题不在这里定死：拖到哪边算哪边，prepare 只负责把
       「浅色层 + 底下的目标态」备好（见 app.js）。 */
    const cur = isDark() ? 'dark' : 'light';
    let ok = false;
    try {
      ok = !!(api && api.prepare(cur === 'dark' ? 'light' : 'dark'));
    } catch (err) {
      /* 克隆失败（极端情况：DOM 正处于不一致的中间态）：
         退回瞬时切换，不让开关彻底失灵 */
      console.warn('[theme-switch] 建揭幕层失败：', err);
      return false;
    }
    if (!ok) return false;

    revealOn = true;
    revealStarted = false;
    return true;
  }

  /** 弹簧到位时提交。commit=false 用于用户中途放弃（拖到一半弹回原位） */
  function endReveal(commit) {
    if (!revealOn) return;
    revealOn = false;
    const api = revealApi();
    if (api) api.finish(commit);
    /* 开关自己路径的收尾（事件路径由 onEnd 做）：清掉待提升标志，
       揭掉可能的隐身类，把顶起来的开关降回原位 */
    pendingLift = false;
    btn.classList.remove('is-veiled');
    if (lifted) scheduleLower();
  }

  function up() {
    if (!down) return;
    down = false;
    pressT = 0;
    lastUp = performance.now();
    if (drag) {
      /* 拖动结束：按位置 + 惯性决定落哪边。
         惯性只在前一段行程里起作用 —— 参考版原式 `pos + xv*0.16` 会让
         「只拖了一点点就松手」也甩到对面（拖 10% 时 xv 往往已经很大），
         手感和直觉不符。这里加一条：离原位不足 35% 一律弹回。 */
      drag = false;
      const moved = Math.abs(pos - dragOrigin);
      const goRight = moved < 0.35
        ? pos >= 0.5
        : (pos + xv * 0.16 > 0.5);
      setTarget(goRight ? 1 : 0);
      return;
    }
    /* 没拖动就是点击 */
    if (!moved) toggle();
    else kick();
  }
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);

  /* ---------- 点击切换 ----------
     真正的切换入口。它不调用 onToggle（那条路会再走一遍
     applyThemeWithTransition），而是自己把整个流程走完：
     建层 → 弹簧 → 每帧写 clipPath → 到位提交。 */
  function toggle() {
    if (window.__tswDebug) window.__tswToggleCalled = { lock: performance.now() < pageLockUntil, target, pos };
    if (performance.now() < pageLockUntil) return;
    const nextTarget = target === 1 ? 0 : 1;
    /* 先建层。失败（克隆不出来）就退回老路 */
    if (!beginReveal()) {
      if (typeof onToggle === 'function') onToggle();
      return;
    }
    /* 同 pointerdown：先把开关顶到揭幕层之上再开弹簧，
       不然整段动画里看见的都是克隆体里冻住的副本 */
    if (!lifted) lift();
    setTarget(nextTarget);
  }

  /* 键盘触发的 click 没有 pointerup 配对（detail === 0），单独接住。
     鼠标/触控的 click 前面已经在 pointerup 里切过了，这里必须跳过，
     否则一次点击会切换两次。 */
  btn.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    if (performance.now() - lastUp < 700) return;
    toggle();
  });

  /* 键盘：方向键 / Home / End */
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'End') {
      e.preventDefault();
      if (target !== 1 && onToggle) onToggle();
    } else if (e.key === 'ArrowLeft' || e.key === 'Home') {
      e.preventDefault();
      if (target !== 0 && onToggle) onToggle();
    }
  });

  /* ---------- 与页面揭幕的联动 ---------- */
  const onStart = (e) => {
    const d = e.detail || {};
    if (!d.to) return;
    const t = d.to === 'dark' ? 0 : 1;
    pageLockUntil = performance.now() + (d.durationMs || 0) + 90;
    if (reduceMotion() || !d.durationMs) {
      setTarget(t);
      return;
    }
    /* 和页面揭幕同一个同步调用栈：先把按钮顶到覆盖层之上，再开动画。
       两边从这一帧起一起走，不会再有「页面切完了、开关才慢半拍开始」。 */
    if (pendingLift) {
      pendingLift = false;
      if (!lift() && !lifted) {
        waitingReveal = true;
        return;
      }
    }
    setTarget(t);
  };

  const onEnd = (e) => {
    const d = e.detail || {};
    if (!d.to) return;
    const t = d.to === 'dark' ? 0 : 1;
    btn.classList.remove('is-veiled');
    if (waitingReveal) {
      waitingReveal = false;
      setTarget(t);
      return;
    }
    /* 弹簧还在朝同一个目标走：别打断它，但 1.4s 内一定降回去 */
    if (moving && t === target) {
      scheduleLowerIn(1400);
      return;
    }
    setTarget(t);
    scheduleLower();
  };

  const onPrepare = (e) => {
    const d = e.detail || {};
    if (!d.to) return;
    pendingLift = canLift;
    if (!canLift) {
      /* popover 不支持：退回「隐身到揭幕结束再演」的老办法 */
      btn.classList.add('is-veiled');
    }
  };

  window.addEventListener(EVT_START, onStart);
  window.addEventListener(EVT_END, onEnd);
  window.addEventListener(EVT_PREPARE, onPrepare);

  /* 没有事件的主题变化（启动恢复、跟随系统、设置同步）：直接同步到终态 */
  const mo = new MutationObserver(() => {
    if (document.documentElement.classList.contains('theme-switching')) return;
    const t = isDark() ? 0 : 1;
    if (t !== target) setTarget(t);
    else if (Math.abs(pos - t) > 0.01 && !drag) setTarget(t);
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* 窗口尺寸变了，top layer 里的固定坐标就失效了：先降回原位再重算 */
  window.addEventListener('resize', () => {
    if (lifted) lower();
    resize();
  });

  /* ---------- 挂载收尾 ---------- */
  host.appendChild(btn);

  /* 启动时把开关拉到当前主题对应的位置。
     挂载这一刻主题可能还没定下来（app.js 是在更晚的时候读设置、
     设 data-theme），所以不能只靠构造时的 isDark() 初值。 */
  {
    const t0 = isDark() ? 0 : 1;
    pos = t0;
    target = t0;
    fa = fT(pos);
    fv = 0;
    btn.setAttribute('aria-checked', t0 === 1 ? 'false' : 'true');
  }

  resize();

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => resize()).observe(btn);
  }

  return true;
}
