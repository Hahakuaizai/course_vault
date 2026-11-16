/* 测量：点击 → 开关开始动 的延迟，以及伪元素动画是否真的在跑 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const knob = btn.querySelector('.tsw-knob');
    const readX = () => new DOMMatrix(getComputedStyle(knob).transform).m41;

    const before = readX();
    const t0 = performance.now();
    /* 真实点击（pointerdown + up），走 toggleTheme */
    const br = btn.getBoundingClientRect();
    const x = br.left + 8, y = br.top + br.height / 2;
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y,
                pointerId: 1, pointerType: 'mouse', button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    btn.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));

    /* 每帧记录旋钮位置，直到稳定 */
    const samples = [];
    let lastX = before;
    for (let i = 0; i < 90; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const nx = readX();
      samples.push({ t: +(performance.now() - t0).toFixed(1), x: +nx.toFixed(1) });
      if (i > 5 && Math.abs(nx - lastX) < 0.01 && Math.abs(nx - before) > 1) break;
      lastX = nx;
    }
    const firstMove = samples.find(s => Math.abs(s.x - before) > 0.5);
    return {
      before: +before.toFixed(1),
      firstMoveAt: firstMove ? firstMove.t : null,
      totalFrames: samples.length,
      lastX: samples[samples.length - 1].x,
      theme: document.documentElement.dataset.theme,
      /* 前 12 帧的轨迹，看是不是被冻住了一段 */
      head: samples.slice(0, 12),
      /* 伪元素动画是否存在于动画列表 */
      anims: document.getAnimations().map(a => ({
        type: a.constructor.name,
        pseudo: a.effect && a.effect.pseudoElement,
        dur: a.effect && a.effect.getTiming().duration,
        state: a.playState,
      })),
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
