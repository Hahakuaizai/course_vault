/* 看 grid 和 card 的 computed 样式差异 + CSS 变量 */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const api = window.__vaultThemeReveal;
    api.prepare('dark');
    const appD = document.querySelector('.app');
    const appL = document.getElementById('appL');
    appL.dataset.theme = appD.dataset.theme;

    const probe = (root) => {
      const g = root.querySelector('.grid');
      const c = root.querySelector('.grid > *');
      const gs = getComputedStyle(g), cs = getComputedStyle(c);
      return {
        grid: {
          cols: gs.gridTemplateColumns, gap: gs.gap, pad: gs.padding,
          w: +g.getBoundingClientRect().width.toFixed(1),
          clientW: g.clientWidth, offsetW: g.offsetWidth,
          scrollbar: g.offsetWidth - g.clientWidth,
        },
        card: {
          w: +c.getBoundingClientRect().width.toFixed(1),
          pad: cs.padding, border: cs.borderWidth, bs: cs.boxSizing,
          minW: cs.minWidth, fs: cs.fontSize,
        },
        vars: ['--bg-1', '--card-bg', '--radius-lg', '--gap'].map((k) => [k, gs.getPropertyValue(k).trim()]),
      };
    };
    const out = { D: probe(appD), L: probe(appL) };
    api.finish(false);
    return out;
  `);
  console.log('原界面', JSON.stringify(r.D, null, 2));
  console.log('克隆体', JSON.stringify(r.L, null, 2));
};
