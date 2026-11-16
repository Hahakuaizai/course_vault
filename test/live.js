/* 让后台页面真正活跃（rAF 才会跑），然后测动画 */
module.exports = async function (cdp) {
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const r = await cdp.evaluate(`
    /* 用 setTimeout 测 rAF 是否在跑 */
    let frames = 0;
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 300) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return {
      hidden: document.hidden,
      visibility: document.visibilityState,
      framesIn300ms: frames,
      rafWorks: frames > 5,
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
