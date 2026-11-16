/* 单击后逐帧追踪 */
module.exports = async function (cdp) {
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const br = btn.getBoundingClientRect();
    const readX = () => +new DOMMatrix(getComputedStyle(knob).transform).m41.toFixed(1);
    const theme0 = document.documentElement.dataset.theme;
    const x = br.left + 10, y = br.top + br.height / 2;
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y,
                   pointerId: 75, pointerType: 'mouse', button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
    await new Promise(r => setTimeout(r, 20));
    btn.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));

    const samples = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      const l = document.getElementById('appL');
      samples.push({
        t: (i + 1) * 100,
        x: readX(),
        clip: l ? +l.style.clipPath.replace(/circle\\(([0-9.]+)px.*/, '$1') : null,
        theme: document.documentElement.dataset.theme,
      });
    }
    return { theme0, samples };
  `);
  console.log('起始', r.theme0);
  r.samples.forEach((s) => {
    console.log(`${String(s.t).padStart(4)}ms x=${String(s.x).padStart(6)} clip=${String(s.clip).padEnd(9)} theme=${s.theme}`);
  });
};
