/* 导出点阵 canvas 的原始内容，并列出每个点的坐标（按 200 viewBox 还原） */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const cv = document.querySelector('.tsw-cv');
    const url = cv.toDataURL('image/png');
    /* 顺便按 15×15 网格还原出哪些格点是亮的 */
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const k = cv.width / 200;          // 物理像素 / viewBox 单位
    const grid = [];
    for (let gy = 0; gy < 15; gy++) {
      let row = '';
      for (let gx = 0; gx < 15; gx++) {
        const cx = Math.round((40 + gx * 8 + 4) * k);
        const cy = Math.round((40 + gy * 8 + 4) * k);
        let hit = false;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          for (let dx = -2; dx <= 2 && !hit; dx++) {
            const px = cx + dx, py = cy + dy;
            if (px >= 0 && py >= 0 && px < cv.width && py < cv.height) {
              if (d[(py * cv.width + px) * 4 + 3] > 30) hit = true;
            }
          }
        }
        row += hit ? '#' : '.';
      }
      grid.push(row);
    }
    return { url, grid, size: cv.width };
  `);
  console.log('canvas', r.size + '×' + r.size);
  r.grid.forEach((row, i) => console.log(String(i).padStart(2, ' ') + ' ' + row));
  const b64 = r.url.split(',')[1];
  require('fs').writeFileSync(
    require('path').resolve(__dirname, '.canvas-dump.png'),
    Buffer.from(b64, 'base64'),
  );
  console.log('已存 test/.canvas-dump.png');
};
