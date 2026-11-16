module.exports = async function (cdp) {
  await cdp.wait(1000);
  const r = await cdp.evaluate(`
    const queue = [];
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
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
                   pointerId: 160, pointerType: 'mouse', button: 0 };

    window.__tswDebug = true;
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));
    const afterDown = {
      debug: window.__tswDebugDown,
      hasL: !!document.getElementById('appL'),
      apiActive: window.__vaultThemeReveal ? window.__vaultThemeReveal.active() : null,
      queueLen: queue.length,
      error: window.__lastErr || null,
    };

    const steps = [];
    for (let i = 1; i <= 10; i++) {
      btn.dispatchEvent(new PointerEvent('pointermove', {
        ...base, clientX: sx + dir * 20 * i / 10, buttons: 1 }));
      pump(2);
      const l = document.getElementById('appL');
      steps.push({ i, hasL: !!l, clip: l ? l.style.clipPath : null });
    }

    window.requestAnimationFrame = realRaf;
    return { theme0, afterDown, steps };
  `);
  console.log(JSON.stringify(r, null, 2));
};
