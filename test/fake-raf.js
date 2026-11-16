/* 验证单击逻辑：接管 rAF，手动按 16ms 步长推进弹簧。 */
module.exports = async function (cdp) {
  /* 先让窗口静一下，确保开关内部的 raf 标记回到 0 */
  await cdp.wait(1200);

  const r = await cdp.evaluate(`
    /* 接管 rAF（必须在触发点击之前） */
    const queue = [];
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
    window.cancelAnimationFrame = () => {};

    const theme0 = document.documentElement.dataset.theme;
    const btn = document.querySelector('.tsw');
    const br = btn.getBoundingClientRect();
    const x = br.left + 10, y = br.top + br.height / 2;
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y,
                   pointerId: 99, pointerType: 'mouse', button: 0 };

    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
    btn.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));

    /* 手动推进 3 秒 */
    let now = performance.now();
    const snaps = [];
    for (let i = 0; i < 200; i++) {
      now += 16;
      const batch = queue.splice(0, queue.length);
      if (!batch.length) break;
      for (const cb of batch) cb(now);
      if (i % 15 === 0) {
        const l = document.getElementById('appL');
        snaps.push({
          i,
          clip: l ? +l.style.clipPath.replace(/circle\\(([0-9.]+)px.*/, '$1') : null,
          theme: document.documentElement.dataset.theme,
        });
      }
      /* 已经收尾就停 */
      if (!document.getElementById('appL') && i > 3) break;
    }

    window.requestAnimationFrame = realRaf;
    return {
      theme0,
      framesRun: 200,
      snaps,
      final: {
        theme: document.documentElement.dataset.theme,
        appTheme: document.querySelector('.app').dataset.theme,
        appL: !!document.getElementById('appL'),
        knobX: +new DOMMatrix(getComputedStyle(document.querySelector('.tsw-knob')).transform).m41.toFixed(1),
      },
    };
  `);
  console.log('起始', r.theme0);
  r.snaps.forEach((s) => {
    console.log(`  帧${String(s.i).padStart(3)} clip=${String(s.clip).padEnd(9)} theme=${s.theme}`);
  });
  console.log('最终', JSON.stringify(r.final));
  console.log(r.final.theme !== r.theme0 && !r.final.appL ? '✅ 单击切换成功' : '❌ 失败');
};
