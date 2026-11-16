/* 深挖：轨道描边从哪来、光弧为什么看不见 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const track = btn.querySelector('.tsw-track');
    const arcs = [...btn.querySelectorAll('.tsw-arcs path')];
    const cs = getComputedStyle(track);
    const bs = getComputedStyle(btn);
    const arcsSvg = btn.querySelector('.tsw-arcs');
    const acs = getComputedStyle(arcsSvg);
    return {
      btnBorder: bs.border, btnOutline: bs.outline, btnBoxShadow: bs.boxShadow,
      btnBg: bs.backgroundColor, btnOverflow: bs.overflow,
      trackBorder: cs.border, trackBoxShadow: cs.boxShadow,
      trackBg: cs.backgroundImage.slice(0, 90),
      trackRadius: cs.borderRadius,
      svg: { overflow: acs.overflow, zIndex: acs.zIndex, stroke: acs.stroke,
             visible: arcsSvg.getBoundingClientRect().width },
      paths: arcs.map(a => ({
        sw: a.getAttribute('stroke-width'),
        op: a.getAttribute('opacity'),
        dash: a.getAttribute('stroke-dasharray'),
        offset: a.getAttribute('stroke-dashoffset'),
        stroke: getComputedStyle(a).stroke,
        strokeW: getComputedStyle(a).strokeWidth,
        bbox: (() => { const b = a.getBBox(); return [b.x|0, b.y|0, b.width|0, b.height|0]; })(),
      })),
      dockVars: {
        arc: getComputedStyle(btn.querySelector('.tsw-dock')).getPropertyValue('--arc').trim(),
      },
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
