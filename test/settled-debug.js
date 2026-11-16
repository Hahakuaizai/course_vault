/* 从外部读开关内部状态：在 theme-switch.js 里临时挂个探针 */
module.exports = async function (cdp) {
  /* 用 CDP 在页面里注入一段，读不到闭包变量 —— 改成观测副作用 */
  const r = await cdp.evaluate(`
    /* 直接把 clip 写成 NaN 之外的值，看 rAF 是否还在跑 */
    let frames = 0;
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 400) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return { framesIn400ms: frames, hidden: document.hidden };
  `);
  console.log('rAF 帧数/400ms:', r.framesIn400ms, 'hidden:', r.hidden);
  console.log(r.framesIn400ms < 5 ? '❌ rAF 被节流 —— 弹簧永远跑不完' : '✅ rAF 正常');
};
