/* 定位 57ms 延迟到底花在哪：分段打点 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const marks = [];
    const mark = (name) => marks.push({ name, t: +performance.now().toFixed(1) });

    const btn = document.querySelector('.tsw');
    const knob = btn.querySelector('.tsw-knob');
    const readX = () => new DOMMatrix(getComputedStyle(knob).transform).m41;

    const t0 = performance.now();
    const before = readX();

    /* 挂探针：主题事件、class 变化、动画开始 */
    const onStart = () => mark('EVT_START');
    const onPrepare = () => mark('EVT_PREPARE');
    window.addEventListener('cv:theme-transition-start', onStart);
    window.addEventListener('cv:theme-transition-prepare', onPrepare);

    /* 探针：什么时候开始有 view-transition 伪元素 */
    let sawPseudo = null;
    const pollPseudo = () => {
      if (sawPseudo === null && document.documentElement.classList.contains('theme-switching')) {
        sawPseudo = performance.now() - t0;
      }
      if (!sawPseudo) requestAnimationFrame(pollPseudo);
    };
    requestAnimationFrame(pollPseudo);

    mark('click');
    const br = btn.getBoundingClientRect();
    const x = br.left + 8, y = br.top + br.height / 2;
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y,
                pointerId: 1, pointerType: 'mouse', button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    btn.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));

    /* 每帧看旋钮动没动 */
    const frameLog = [];
    for (let i = 0; i < 25; i++) {
      await new Promise(r => requestAnimationFrame(r));
      frameLog.push({ t: +(performance.now() - t0).toFixed(1), x: +readX().toFixed(1) });
    }
    window.removeEventListener('cv:theme-transition-start', onStart);
    window.removeEventListener('cv:theme-transition-prepare', onPrepare);

    return {
      marks: marks.map(m => ({ name: m.name, dt: +(m.t - t0).toFixed(1) })),
      sawThemeSwitchingAt: sawPseudo,
      firstKnobMove: frameLog.find(f => Math.abs(f.x - before) > 0.5),
      frames: frameLog.slice(0, 14),
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
