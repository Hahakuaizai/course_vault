/* 验证全屏粒子/火花是否真的画出来了 */
module.exports = async function (cdp) {
  await cdp.wait(1000);
  const r = await cdp.evaluate(`
    /* 接管 rAF 手动推进 */
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
    const br = btn.getBoundingClientRect();
    const fx = document.querySelector('.tsw-fx');
    const fc = fx.getContext('2d');
    const band = document.querySelector('.tsw-band');

    /* 统计 fx canvas 上有多少非透明像素 */
    const painted = () => {
      if (!fx.width) return 0;
      const d = fc.getImageData(0, 0, fx.width, fx.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 6) n += 1;
      return n;
    };

    const x = br.left + 10, y = br.top + br.height / 2;
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y,
                   pointerId: 130, pointerType: 'mouse', button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
    btn.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));

    /* 推进并采样 */
    const samples = [];
    for (let step = 0; step < 12; step++) {
      pump(4);
      samples.push({
        step,
        painted: painted(),
        bandBg: band.style.background ? band.style.background.slice(0, 40) : '',
      });
    }
    pump(120);

    window.requestAnimationFrame = realRaf;
    return {
      fxSize: [fx.width, fx.height],
      samples,
      maxPainted: Math.max(...samples.map(s => s.painted)),
      bandFrames: samples.filter(s => s.bandBg).length,
      theme: document.documentElement.dataset.theme,
    };
  `);

  console.log('fx canvas 尺寸', r.fxSize.join('×'));
  r.samples.forEach((s) => {
    console.log(`  步${String(s.step).padStart(2)} 粒子像素=${String(s.painted).padStart(6)}  光带=${s.bandBg ? '有' : '无'}`);
  });
  console.log('\n最大粒子像素数:', r.maxPainted);
  console.log('粒子效果:', r.maxPainted > 100 ? '✅ 在画' : '❌ 没画');
  console.log('斜向光带:', r.bandFrames > 0 ? `✅ ${r.bandFrames} 帧有` : '❌ 没出现');
  console.log('最终主题:', r.theme);
};
