/* 对比：调 startViewTransition 期间 rAF 是否被冻结 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const measure = async (fn) => {
      const t0 = performance.now();
      const gaps = [];
      let last = t0;
      let stop = false;
      const tick = () => {
        const now = performance.now();
        gaps.push(+(now - last).toFixed(1));
        last = now;
        if (!stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise(r => setTimeout(r, 50));
      const before = gaps.length;
      fn();
      await new Promise(r => setTimeout(r, 400));
      stop = true;
      await new Promise(r => setTimeout(r, 50));
      /* 找最大的帧间隔（冻结时间） */
      const maxGap = Math.max(...gaps);
      const maxIdx = gaps.indexOf(maxGap);
      return { maxGap, maxIdx, framesBefore: before, total: gaps.length,
               gaps: gaps.slice(Math.max(0, maxIdx - 3), maxIdx + 6) };
    };

    /* A: 什么都不做（基线） */
    const a = await measure(() => {});

    /* B: 只调 startViewTransition，不做任何事 */
    const b = await measure(() => {
      document.startViewTransition(() => {});
    });
    await new Promise(r => setTimeout(r, 500));

    return { baseline: a, viewTransition: b };
  `);
  console.log(JSON.stringify(r, null, 2));
};
