/* 放大截取主题开关。用法：node test/cdp.js shot-switch.js [倍数] */
module.exports = async function (cdp) {
  const scale = Number(process.argv[3] || 6);
  const r = await cdp.evaluate(`
    const b = document.querySelector('.tsw');
    const r = b.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             theme: document.documentElement.dataset.theme };
  `);
  console.log('开关', JSON.stringify(r), '倍数', scale);
  const pad = 6;
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: Math.max(0, r.x - pad),
      y: Math.max(0, r.y - pad),
      width: r.w + pad * 2,
      height: r.h + pad * 2,
      scale,
    },
  });
  require('fs').writeFileSync(
    require('path').resolve(__dirname, '.shot-tsw.png'),
    Buffer.from(res.data, 'base64'),
  );
  console.log('已存 test/.shot-tsw.png');
};
