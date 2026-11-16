/* 测量点阵绘制的实际输入：pos / u / tt，以及粒子分布 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const cv = btn.querySelector('.tsw-cv');
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = img.data;
    // 统计非透明像素的包围盒和质心
    let n = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        if (d[(y * cv.width + x) * 4 + 3] > 20) {
          n++; sx += x; sy += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    // 逐行扫，看是否月牙形（右侧缺一块）
    const rows = [];
    for (let y = 0; y < cv.height; y += Math.max(1, Math.floor(cv.height / 12))) {
      let cnt = 0, first = -1, last = -1;
      for (let x = 0; x < cv.width; x++) {
        if (d[(y * cv.width + x) * 4 + 3] > 20) {
          cnt++; if (first < 0) first = x; last = x;
        }
      }
      rows.push({ y, cnt, first, last });
    }
    return {
      canvas: { w: cv.width, h: cv.height },
      cssSize: cv.getBoundingClientRect().width,
      pixels: n,
      centroid: n ? [+(sx / n).toFixed(1), +(sy / n).toFixed(1)] : null,
      bbox: n ? { minX, maxX, minY, maxY } : null,
      rows,
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
