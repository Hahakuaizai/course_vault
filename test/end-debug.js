/* 查为什么松手后没提交。用 setTimeout 而不是 rAF（脚本里 rAF 可能不跑）。 */
module.exports = async function (cdp) {
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const kr = knob.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const sx = kr.left + kr.width / 2, sy = kr.top + kr.height / 2;
    const theme0 = document.documentElement.dataset.theme;
    const dir = theme0 === 'light' ? -1 : 1;
    const base = { bubbles: true, cancelable: true, clientY: sy,
                   pointerId: 9, pointerType: 'mouse', button: 0 };
    const readX = () => +new DOMMatrix(getComputedStyle(knob).transform).m41.toFixed(1);

    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));
    for (let i = 1; i <= 6; i++) {
      btn.dispatchEvent(new PointerEvent('pointermove', {
        ...base, clientX: sx + dir * (br.width * 0.5 * i) / 6, buttons: 1 }));
      await new Promise(r => setTimeout(r, 25));
    }
    const beforeUp = { x: readX(), aria: btn.getAttribute('aria-checked') };
    btn.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: sx + dir * br.width * 0.5, buttons: 0 }));

    /* 每 100ms 采样一次，最多 3 秒 */
    const samples = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      const appL = document.getElementById('appL');
      samples.push({
        t: (i + 1) * 100,
        x: readX(),
        clip: appL ? +appL.style.clipPath.replace(/circle\\(([0-9.]+)px.*/, '$1') : null,
        aria: btn.getAttribute('aria-checked'),
        theme: document.documentElement.dataset.theme,
      });
      if (!appL) break;
    }
    return { theme0, beforeUp, samples };
  `);

  console.log('起始主题', r.theme0, '松手前', JSON.stringify(r.beforeUp));
  r.samples.forEach((s) => {
    console.log(`  ${String(s.t).padStart(4)}ms x=${String(s.x).padStart(6)} clip=${String(s.clip).padEnd(9)} aria=${s.aria} theme=${s.theme}`);
  });
};
