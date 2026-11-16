/* 测 clone 整个界面的成本，判断能不能照参考版做「双份 DOM」 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const root = document.getElementById('app') || document.body;
    const count = (el) => {
      let n = 1;
      for (const c of el.children) n += count(c);
      return n;
    };
    const nodes = count(root);
    /* 测三次 clone 耗时 */
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const c = root.cloneNode(true);
      c.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
      document.body.appendChild(c);
      void c.offsetHeight;      // 强制一次布局
      times.push(+(performance.now() - t0).toFixed(1));
      c.remove();
    }
    return {
      rootTag: root.tagName + '#' + root.id,
      nodeCount: nodes,
      cloneMs: times,
      hasCanvas: root.querySelectorAll('canvas').length,
      hasVideo: root.querySelectorAll('video').length,
      hasIframe: root.querySelectorAll('iframe').length,
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
