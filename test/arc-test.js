/* 把光弧改成纯红满不透明，看它是否渲染出来 */
module.exports = async function (cdp) {
  const info = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const svg = btn.querySelector('.tsw-arcs');
    const paths = [...svg.querySelectorAll('path')];
    // 备份原样式
    window.__arcBak = paths.map(p => p.getAttribute('style'));
    paths.forEach(p => {
      p.style.stroke = '#ff0000';
      p.style.opacity = '1';
      p.setAttribute('stroke-dasharray', '1000 0');
      p.setAttribute('stroke-dashoffset', '0');
    });
    const r = svg.getBoundingClientRect();
    const p0 = paths[5];
    return {
      svgRect: { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      pathBBox: (() => { const b = p0.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })(),
      totalLen: p0.getTotalLength(),
      svgOuter: svg.outerHTML.slice(0, 200),
    };
  `);
  console.log(JSON.stringify(info, null, 2));

  const b = await cdp.evaluate(`
    const r = document.querySelector('.tsw').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  `);
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: b.x - 6, y: b.y - 6, width: b.w + 12, height: b.h + 12, scale: 8 },
  });
  require('fs').writeFileSync(
    require('path').resolve(__dirname, '.shot-arc-red.png'),
    Buffer.from(res.data, 'base64'),
  );
  console.log('已存 test/.shot-arc-red.png');
};
