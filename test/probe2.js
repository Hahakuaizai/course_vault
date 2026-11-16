/* 打开调试探针，拖一次，读 settled 各项余量 */
module.exports = async function (cdp) {
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const r = await cdp.evaluate(`
    window.__tswDebug = true;
    const btn = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const kr = knob.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const sx = kr.left + kr.width / 2, sy = kr.top + kr.height / 2;
    const theme0 = document.documentElement.dataset.theme;
    const dir = theme0 === 'light' ? -1 : 1;
    const base = { bubbles: true, cancelable: true, clientY: sy,
                   pointerId: 11, pointerType: 'mouse', button: 0 };

    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));
    for (let i = 1; i <= 6; i++) {
      btn.dispatchEvent(new PointerEvent('pointermove', {
        ...base, clientX: sx + dir * (br.width * 0.5 * i) / 6, buttons: 1 }));
      await new Promise(r => setTimeout(r, 25));
    }
    btn.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: sx + dir * br.width * 0.5, buttons: 0 }));

    await new Promise(r => setTimeout(r, 1500));
    return { theme0, state: window.__tswDebugState || null,
             appL: !!document.getElementById('appL') };
  `);
  console.log(JSON.stringify(r, null, 2));
};
