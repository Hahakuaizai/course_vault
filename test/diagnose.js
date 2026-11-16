/* 诊断：halo / ig / gl 的实际位置与样式，以及 dock 上的全部变量 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const dock = btn.querySelector('.tsw-dock');
    const halo = btn.querySelector('.tsw-halo');
    const ig = btn.querySelector('.tsw-ig');
    const gl = btn.querySelector('.tsw-gl');
    const knob = btn.querySelector('.tsw-knob');
    const vars = {};
    for (const n of ['t1','t2','tsa','tsb','drop','k1','k2','kh','kd','kb','kb2',
                     'kref','kouter','arc','arcw','glow','halo']) {
      vars[n] = dock.style.getPropertyValue('--' + n);
    }
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: +r.left.toFixed(1), y: +r.top.toFixed(1),
               w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    return {
      btn: box(btn), knob: box(knob),
      halo: { ...box(halo), transform: getComputedStyle(halo).transform,
              bg: getComputedStyle(halo).backgroundImage.slice(0, 70) },
      ig: { ...box(ig), transform: getComputedStyle(ig).transform,
            bg: getComputedStyle(ig).backgroundImage.slice(0, 70) },
      gl: { ...box(gl), transform: getComputedStyle(gl).transform,
            opacity: getComputedStyle(gl).opacity },
      knobTransform: getComputedStyle(knob).transform,
      knobBg: getComputedStyle(knob).backgroundImage.slice(0, 120),
      knobShadow: getComputedStyle(knob).boxShadow.slice(0, 200),
      vars,
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
