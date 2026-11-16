/* 强制切到深色后截开关本体，放大 6 倍。
   后台窗口 rAF 冻结 → 接管 rAF 手动推进弹簧到终态，再恢复截图。 */
module.exports = async function (cdp) {
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.wait(2500);
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

    document.getAnimations().forEach((a) => { try { a.finish(); } catch { } });
    /* 真实切换：documentElement + app 一起改，MutationObserver 会同步开关。
       回调是微任务，必须等它跑完再推进 rAF，否则 target 还是旧值。 */
    document.documentElement.dataset.theme = 'dark';
    document.querySelector('.app').dataset.theme = 'dark';
    await new Promise((ok) => setTimeout(ok, 20));
    pump(300);
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { } });

    const btn = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const br = btn.getBoundingClientRect();
    const out = {
      theme: document.documentElement.dataset.theme,
      rect: { x: br.left - 6, y: br.top - 6, width: br.width + 12, height: br.height + 12 },
      knobX: +new DOMMatrix(getComputedStyle(knob).transform).m41.toFixed(1),
      aria: btn.getAttribute('aria-checked'),
    };
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
    return out;
  `);
  console.log('主题', r.theme, '旋钮X', r.knobX, 'aria', r.aria, JSON.stringify(r.rect));
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...r.rect, scale: 6 },
  });
  require('fs').writeFileSync(
    require('path').resolve(__dirname, `.shot-switch-${r.theme}.png`),
    Buffer.from(res.data, 'base64'),
  );
  console.log(`已存 test/.shot-switch-${r.theme}.png`);
};
