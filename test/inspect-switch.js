/* 检查 Aurora 开关的 DOM 结构、尺寸、点阵 canvas 是否都到位 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    if (!btn) return { err: '开关不存在' };
    const dock = btn.querySelector('.tsw-dock');
    const knob = btn.querySelector('.tsw-knob');
    const cv = btn.querySelector('.tsw-cv');
    const arcs = btn.querySelectorAll('.tsw-arcs path');
    const br = btn.getBoundingClientRect();
    const kr = knob.getBoundingClientRect();
    const cs = getComputedStyle(dock);
    // canvas 是否真的画了东西
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] > 8) painted += 1;
    return {
      btn: { w: +br.width.toFixed(2), h: +br.height.toFixed(2) },
      knob: { w: +kr.width.toFixed(2), h: +kr.height.toFixed(2) },
      dockTransform: cs.transform,
      canvas: { w: cv.width, h: cv.height, paintedPixels: painted },
      arcCount: arcs.length,
      arcWidths: [...arcs].map(a => a.getAttribute('stroke-width')),
      layers: {
        track: !!btn.querySelector('.tsw-track'),
        halo: !!btn.querySelector('.tsw-halo'),
        gw: !!btn.querySelector('.tsw-gw'),
        ig: !!btn.querySelector('.tsw-ig'),
        gl: !!btn.querySelector('.tsw-gl'),
        sheen: !!btn.querySelector('.tsw-sheen'),
        cor: !!btn.querySelector('.tsw-cor'),
        swp: !!btn.querySelector('.tsw-swp'),
      },
      fullscreen: {
        fx: !!document.querySelector('.tsw-fx'),
        band: !!document.querySelector('.tsw-band'),
      },
      arcColor: getComputedStyle(dock).getPropertyValue('--arc').trim(),
      ariaChecked: btn.getAttribute('aria-checked'),
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
