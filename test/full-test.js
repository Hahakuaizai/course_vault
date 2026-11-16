/* 完整测试。因为窗口在后台时 rAF 被完全冻结，这里接管 rAF 手动推进 ——
   验证的是逻辑正确性；真实前台 60fps 跑的是同一套代码。 */
module.exports = async function (cdp) {
  await cdp.wait(1200);   // 等开关内部 raf 标记归零

  const r = await cdp.evaluate(`
    /* ---- 接管 rAF ---- */
    const queue = [];
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
    window.cancelAnimationFrame = () => {};
    /* 推进 n 帧，每帧 16ms */
    let vnow = performance.now();
    const pump = (frames) => {
      for (let i = 0; i < frames; i++) {
        vnow += 16;
        const batch = queue.splice(0, queue.length);
        if (!batch.length) return i;
        for (const cb of batch) cb(vnow);
      }
      return frames;
    };

    const btn = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const br = btn.getBoundingClientRect();
    const readX = () => +new DOMMatrix(getComputedStyle(knob).transform).m41.toFixed(1);
    const themeOf = () => document.documentElement.dataset.theme;
    const hasL = () => !!document.getElementById('appL');

    const results = {};

    /* ---- 1. 单击两次 ---- */
    const clicks = [];
    for (let n = 0; n < 2; n++) {
      const t0 = themeOf();
      const x = br.left + 10, y = br.top + br.height / 2;
      const base = { bubbles: true, cancelable: true, clientX: x, clientY: y,
                     pointerId: 100 + n, pointerType: 'mouse', button: 0 };
      btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
      btn.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
      const midL = hasL();
      pump(200);
      clicks.push({ from: t0, to: themeOf(), midL, leftL: hasL(),
                    appTheme: document.querySelector('.app').dataset.theme });
    }
    results.clicks = clicks;

    /* ---- 2. 拖动后弹回（只拖 10%） ---- */
    {
      const t0 = themeOf();
      const kr = knob.getBoundingClientRect();
      const sx = kr.left + kr.width / 2, sy = kr.top + kr.height / 2;
      const dir = t0 === 'light' ? -1 : 1;
      const base = { bubbles: true, cancelable: true, clientY: sy,
                     pointerId: 110, pointerType: 'mouse', button: 0 };
      btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));
      for (let i = 1; i <= 4; i++) {
        btn.dispatchEvent(new PointerEvent('pointermove', {
          ...base, clientX: sx + dir * (br.width * 0.1 * i) / 4, buttons: 1 }));
        pump(2);
      }
      btn.dispatchEvent(new PointerEvent('pointerup', {
        ...base, clientX: sx + dir * br.width * 0.1, buttons: 0 }));
      pump(200);
      results.bounce = { from: t0, to: themeOf(), leftL: hasL() };
    }

    /* ---- 3. 拖动过半（切换） ---- */
    {
      const t0 = themeOf();
      const kr = knob.getBoundingClientRect();
      const sx = kr.left + kr.width / 2, sy = kr.top + kr.height / 2;
      const dir = t0 === 'light' ? -1 : 1;
      const base = { bubbles: true, cancelable: true, clientY: sy,
                     pointerId: 120, pointerType: 'mouse', button: 0 };
      btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));
      const trail = [];
      for (let i = 1; i <= 8; i++) {
        btn.dispatchEvent(new PointerEvent('pointermove', {
          ...base, clientX: sx + dir * (br.width * 0.55 * i) / 8, buttons: 1 }));
        pump(2);
        const l = document.getElementById('appL');
        trail.push(l ? +l.style.clipPath.replace(/circle\\(([0-9.]+)px.*/, '$1') : null);
      }
      btn.dispatchEvent(new PointerEvent('pointerup', {
        ...base, clientX: sx + dir * br.width * 0.55, buttons: 0 }));
      pump(200);
      results.drag = { from: t0, to: themeOf(), trail, leftL: hasL() };
    }

    /* ---- 4. 最终状态 ---- */
    results.final = {
      theme: themeOf(),
      appTheme: document.querySelector('.app').dataset.theme,
      hasL: hasL(),
      knobX: readX(),
      size: [br.width, br.height],
    };

    window.requestAnimationFrame = realRaf;
    return results;
  `);

  const ok = (b) => (b ? '✅' : '❌');
  console.log('=== 1. 单击切换 ===');
  r.clicks.forEach((c, i) => {
    const good = c.from !== c.to && !c.leftL && c.appTheme === c.to;
    console.log(`  ${i + 1}: ${c.from} → ${c.to} ${ok(good)}  建层=${c.midL} 残留=${c.leftL}`);
  });

  console.log('\n=== 2. 拖 10% 弹回 ===');
  const b = r.bounce;
  console.log(`  ${b.from} → ${b.to} ${ok(b.from === b.to && !b.leftL)}  残留=${b.leftL}`);

  console.log('\n=== 3. 拖 55% 切换 ===');
  const d = r.drag;
  console.log(`  ${d.from} → ${d.to} ${ok(d.from !== d.to && !d.leftL)}`);
  console.log('  裁剪半径轨迹:', d.trail.join(' → '));
  const growing = d.trail.filter((v) => v !== null).length;
  console.log(`  页面跟随: ${ok(growing >= 6)} ${growing}/8 步有裁剪`);

  console.log('\n=== 4. 最终状态 ===');
  console.log(' ', JSON.stringify(r.final));
  console.log('  一致性:', ok(r.final.theme === r.final.appTheme && !r.final.hasL));
};
