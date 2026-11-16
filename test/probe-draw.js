module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const cv = document.querySelector('.tsw-cv');
    const ctx = cv.getContext('2d');
    const count = () => {
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n += 1;
      return n;
    };
    const out = { before: count(), w: cv.width, transform: ctx.getTransform().toString() };
    /* 手动画一个大红块，验证 ctx 能不能画 */
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, cv.width, cv.height);
    out.afterManual = count();
    ctx.restore();
    /* 清掉 */
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.restore();
    out.afterClear = count();
    /* 触发一次 resize（内部会 render） */
    window.dispatchEvent(new Event('resize'));
    out.afterResize = count();
    out.transform2 = ctx.getTransform().toString();
    return out;
  `);
  console.log(JSON.stringify(r, null, 2));
};
