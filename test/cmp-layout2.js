/* 深挖布局差异来源：滚动容器 / 滚动条 / 主题 */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const out = {};
    const api = window.__vaultThemeReveal;
    api.prepare('dark');
    const appD = document.querySelector('.app');
    const appL = document.getElementById('appL');

    /* 找所有可滚动元素 */
    const scrollables = (root) => [...root.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el);
      return /auto|scroll/.test(s.overflowY) || /auto|scroll/.test(s.overflowX);
    }).map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        cls: el.className.toString().slice(0, 40),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        sh: el.scrollHeight, ch: el.clientHeight,
        st: el.scrollTop,
        sbw: +(el.offsetWidth - el.clientWidth).toFixed(1),
        ov: s.overflowY,
      };
    });

    out.scrollD = scrollables(appD);
    out.scrollL = scrollables(appL);
    out.cardsD = appD.querySelector('.grid, .cards')?.getBoundingClientRect().toJSON?.() || null;

    /* 把克隆体主题改回与 appD 相同，看布局是否就一致 */
    appL.dataset.theme = appD.dataset.theme || 'light';
    const g = (root) => {
      const el = root.querySelector('.card, .file-card');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1)];
    };
    out.sameThemeD = g(appD);
    out.sameThemeL = g(appL);

    api.finish(false);
    return out;
  `);
  console.log(JSON.stringify(r, null, 2));
};
