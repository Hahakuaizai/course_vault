/* 查开关内部状态：pos / tt / 颜色变量 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const dock = btn.querySelector('.tsw-dock');
    const cs = getComputedStyle(dock);
    return {
      theme: document.documentElement.dataset.theme,
      aria: btn.getAttribute('aria-checked'),
      t1: cs.getPropertyValue('--t1').trim(),
      t2: cs.getPropertyValue('--t2').trim(),
      k1: cs.getPropertyValue('--k1').trim(),
      arc: cs.getPropertyValue('--arc').trim(),
      trackBg: getComputedStyle(btn.querySelector('.tsw-track')).backgroundImage.slice(0, 80),
      knobX: getComputedStyle(btn.querySelector('.tsw-knob')).transform,
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
