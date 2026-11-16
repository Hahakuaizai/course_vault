/* 截切换动画中间帧。
   先 reload 拿到干净状态（避免上一轮测试遗留的 down/drag 标记），
   再手动推进 rAF 到指定进度，恢复 rAF 后截图。 */
module.exports = async function (cdp) {
  const frac = Number(process.argv[3] || 0.5);

  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.wait(2500);

  const info = await cdp.evaluate(`
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
    /* 往「另一侧」拖 */
    const dir = theme0 === 'light' ? -1 : 1;
    const base = { bubbles: true, cancelable: true, clientY: sy,
                   pointerId: 150, pointerType: 'mouse', button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));

    const dist = 40 * ${frac};
    for (let i = 1; i <= 10; i++) {
      btn.dispatchEvent(new PointerEvent('pointermove', {
        ...base, clientX: sx + dir * dist * i / 10, buttons: 1 }));
      pump(2);
    }
    pump(4);

    const l = document.getElementById('appL');
    const out = {
      theme0,
      clip: l ? l.style.clipPath : null,
      appLTheme: l ? l.dataset.theme : null,
      size: [window.innerWidth, window.innerHeight],
      btnRect: [br.left, br.top, br.width, br.height].map(v => +v.toFixed(1)),
    };
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
    window.__shotPid = 150;
    return out;
  `);
  console.log(`拖到 ${frac * 100}%`, JSON.stringify(info));

  await cdp.wait(120);
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(
    require('path').resolve(__dirname, '.shot-anim.png'),
    Buffer.from(res.data, 'base64'),
  );
  console.log('已存 test/.shot-anim.png');

  /* 收尾：取消拖动 */
  await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const br = btn.getBoundingClientRect();
    btn.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, clientX: br.left + 10, clientY: br.top + 20,
      pointerId: 150, pointerType: 'mouse', button: 0,
    }));
  `);
  await cdp.wait(1500);
};
