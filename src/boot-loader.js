/* ==========================================================================
   启动加载层（boot-loader）
   普通脚本、紧跟在加载层标记之后执行 —— 不等 app.js 那批 module，
   指针交互在页面解析阶段就已经挂上，冷启动那几秒里鼠标是活的。
   动画本体全在 CSS（合成线程），这里只做三件事：
   1) 生成两层尘埃粒子；2) 鼠标视差/倾斜/涟漪；3) 等 boot 完成信号退场。
   ========================================================================== */
(() => {
  const el = document.getElementById('bootLoader');
  if (!el) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const startedAt = performance.now();

  /* ---------- 1) 尘埃：远近两层，近层大而疏、远层小而密 ---------- */
  const layers = [
    { box: el.querySelector('.boot-motes.far'), n: 9, size: [2, 3.5], depth: 6 },
    { box: el.querySelector('.boot-motes.near'), n: 6, size: [3.5, 5.5], depth: 14 },
  ];
  for (const L of layers) {
    if (!L.box) continue;
    for (let i = 0; i < L.n; i++) {
      const s = document.createElement('span');
      s.className = 'boot-mote';
      const size = L.size[0] + Math.random() * (L.size[1] - L.size[0]);
      s.style.width = s.style.height = `${size.toFixed(1)}px`;
      s.style.left = `${(Math.random() * 96 + 2).toFixed(1)}%`;
      s.style.top = `${(Math.random() * 92 + 4).toFixed(1)}%`;
      s.style.animationDuration = `${(3.2 + Math.random() * 3.4).toFixed(2)}s`;
      s.style.animationDelay = `${(-Math.random() * 4).toFixed(2)}s`;
      L.box.appendChild(s);
    }
  }

  /* ---------- 2) 鼠标交互：光晕惯性跟随 + 中心倾斜 + 尘埃视差 ---------- */
  const glow = el.querySelector('.boot-glow');
  const center = el.querySelector('.boot-center');
  let raf = 0;
  let done = false;
  if (!reduceMotion) {
    let tx = window.innerWidth / 2, ty = window.innerHeight * 0.42; // 目标点
    let gx = tx, gy = ty;                                            // 光晕当前位置（lerp 追目标）
    let tmx = 0, tmy = 0, cmx = 0, cmy = 0;                          // 归一化偏移（倾斜/视差用）
    el.addEventListener('pointermove', (e) => {
      tx = e.clientX;
      ty = e.clientY;
      tmx = (e.clientX / window.innerWidth - 0.5) * 2;
      tmy = (e.clientY / window.innerHeight - 0.5) * 2;
    });
    const loop = () => {
      gx += (tx - gx) * 0.08;
      gy += (ty - gy) * 0.08;
      cmx += (tmx - cmx) * 0.06;
      cmy += (tmy - cmy) * 0.06;
      if (glow) glow.style.transform = `translate(${gx.toFixed(1)}px, ${gy.toFixed(1)}px)`;
      if (center) {
        center.style.transform =
          `rotateY(${(cmx * 7).toFixed(2)}deg) rotateX(${(-cmy * 7).toFixed(2)}deg)`;
      }
      for (const L of layers) {
        if (L.box) L.box.style.transform = `translate(${(cmx * L.depth).toFixed(1)}px, ${(cmy * L.depth).toFixed(1)}px)`;
      }
      if (!done) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    /* 点击涟漪：点哪儿哪儿漾一圈 */
    const rippleBox = el.querySelector('.boot-ripples');
    el.addEventListener('pointerdown', (e) => {
      if (!rippleBox) return;
      const r = document.createElement('span');
      r.className = 'boot-ripple';
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      r.addEventListener('animationend', () => r.remove());
      rippleBox.appendChild(r);
    });
  }

  /* ---------- 3) 退场 ----------
   * boot() 完成会给 body 加 .boot-done。最短展示 550ms 防一闪而过；
   * 9 秒兜底：boot 真卡住时也强制退场，不让加载层变成新的「卡死界面」。 */
  function finish() {
    if (done) return;
    done = true;
    const wait = Math.max(0, 550 - (performance.now() - startedAt));
    setTimeout(() => {
      /* 先撤掉 JS 的倾斜 transform，退场的放大过渡（CSS）才接得上 */
      if (center) center.style.transform = '';
      el.classList.add('is-done');
      cancelAnimationFrame(raf);
      setTimeout(() => el.remove(), 700);
    }, wait);
  }
  if (document.body.classList.contains('boot-done')) {
    finish();
  } else {
    const obs = new MutationObserver(() => {
      if (document.body.classList.contains('boot-done')) {
        obs.disconnect();
        finish();
      }
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  setTimeout(finish, 9000);
})();
