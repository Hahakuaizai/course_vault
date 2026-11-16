/* 截切换动画中间帧：手动推进到指定进度，然后恢复 rAF 再截图
   （接管 rAF 期间合成器不出新帧，captureScreenshot 会卡住）。 */
module.exports = async function (cdp) {
  await cdp.wait(1200);
  const frac = Number(process.argv[3] || 0.5);

  const info = await cdp.evaluate(`
    const queue = [];
    const realRaf = window.requestAnimationFrame;
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
                   pointerId: 150, pointerType: 'mouse', button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));

    /* 行程约 40px */
    const dist = 40 * ${frac};
    for (let i = 1; i <= 10; i++) {
      btn.dispatchEvent(new PointerEvent('pointermove', {
        ...base, clientX: sx + dir * dist * i / 10, buttons: 1 }));
      pump(2);
    }
    pump(4);

    const l = document.getElementById('appL');
    const clip = l ? l.style.clipPath : null;
    /* 恢复 rAF，让合成器能出新帧 */
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realRaf === window.requestAnimationFrame ? window.cancelAnimationFrame : window.cancelAnimationFrame;
    return {
      theme0,
      clip,
      appLTheme: l ? l.dataset.theme : null,
      size: [window.innerWidth, window.innerHeight],
      btnRect: [br.left, br.top, br.width, br.height].map(v => +v.toFixed(1)),
    };
  `);
  console.log(`拖到 ${frac * 100}%`, JSON.stringify(info));

  await cdp.wait(150);
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(
    require('path').resolve(__dirname, '.shot-anim.png'),
    Buffer.from(res.data, 'base64'),
  );
  console.log('已存 test/.shot-anim.png');

  /* 收尾：取消拖动，让它弹回 */
  await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const br = btn.getBoundingClientRect();
    btn.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, clientX: br.left + 10, clientY: br.top + 20,
      pointerId: 150, pointerType: 'mouse', button: 0,
    }));
  `);
  await cdp.wait(1200);
};
