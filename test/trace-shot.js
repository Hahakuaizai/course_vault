module.exports = async function (cdp) {
  await cdp.wait(1000);
  const r = await cdp.evaluate(`
    const queue = [];
    const realRaf = window.requestAnimationFrame;
    const realCaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
    window.cancelAnimationFrame = () => {};
    let vnow = performance.now();
    const pump = (n) => {
      for (let i = 0; i < n; i++) {
        vnow += 16;
        const batch = queue.splice(0, queue.length);
        if (!batch.length) return i;
        for (const cb of batch) cb(vnow);
      }
      return n;
    };

    const btn = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const br = btn.getBoundingClientRect();
    const kr = knob.getBoundingClientRect();
    const sx = kr.left + kr.width / 2, sy = kr.top + kr.height / 2;
    const theme0 = document.documentElement.dataset.theme;
    const dir = theme0 === 'light' ? -1 : 1;
    const base = { bubbles: true, cancelable: true, clientY: sy,
                   pointerId: 170, pointerType: 'mouse', button: 0 };

    window.__tswDebug = true;
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));
    const s0 = {
      debug: window.__tswDebugDown,
      hasL: !!document.getElementById('appL'),
      active: window.__vaultThemeReveal.active(),
      queue: queue.length,
      clip: (document.getElementById('appL') || {}).style?.clipPath || null,
    };

    const log = [];
    for (let i = 1; i <= 10; i++) {
      btn.dispatchEvent(new PointerEvent('pointermove', {
        ...base, clientX: sx + dir * 20 * i / 10, buttons: 1 }));
      const ran = pump(2);
      const l = document.getElementById('appL');
      log.push({ i, ran, hasL: !!l, clip: l ? l.style.clipPath : null });
    }
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
    return { theme0, s0, log };
  `);
  console.log(JSON.stringify(r.s0, null, 2));
  r.log.forEach((x) => console.log(`  ${x.i} ran=${x.ran} hasL=${x.hasL} ${x.clip}`));
};
