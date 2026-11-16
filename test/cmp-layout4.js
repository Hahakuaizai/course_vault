/* 对比 appD / appL 里各层容器的几何，找出 11px 偏移与 3.5px 宽度差 */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const api = window.__vaultThemeReveal;
    api.prepare('dark');
    const appD = document.querySelector('.app');
    const appL = document.getElementById('appL');
    appL.dataset.theme = appD.dataset.theme;

    const chain = (el) => {
      const out = [];
      let n = el;
      while (n && n !== document.body) {
        const r = n.getBoundingClientRect();
        const s = getComputedStyle(n);
        out.push({
          tag: n.tagName.toLowerCase(),
          cls: (n.className || '').toString().slice(0, 28),
          rect: [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)],
          pad: s.padding, gap: s.gap, disp: s.display,
          bs: s.boxSizing, fs: s.fontSize,
        });
        n = n.parentElement;
      }
      return out;
    };

    const cd = appD.querySelector('.content');
    const cl = appL.querySelector('.content');
    const out = {
      chainD: chain(cd),
      chainL: chain(cl),
      contentScrollD: [cd.scrollTop, cd.scrollHeight, cd.clientHeight],
      contentScrollL: [cl.scrollTop, cl.scrollHeight, cl.clientHeight],
    };
    api.finish(false);
    return out;
  `);
  const fmt = (c) => c.map((x) => `  ${x.tag}.${x.cls.padEnd(20)} ${JSON.stringify(x.rect)} pad=${x.pad} gap=${x.gap} ${x.disp}`).join('\n');
  console.log('=== 原界面 ===\n' + fmt(r.chainD));
  console.log('=== 克隆体 ===\n' + fmt(r.chainL));
  console.log('scroll D', r.contentScrollD, 'L', r.contentScrollL);
};
