/* 对比克隆层 appL 与原界面 appD 的布局是否完全一致 */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const out = {};
    const api = window.__vaultThemeReveal;
    const ok = api.prepare('dark');
    if (!ok) return { err: 'prepare failed' };
    const appD = document.querySelector('.app');
    const appL = document.getElementById('appL');

    const grab = (root) => {
      const cards = [...root.querySelectorAll('.card, .file-card, .grid > *')].slice(0, 6);
      return cards.map((c) => {
        const r = c.getBoundingClientRect();
        return {
          t: (c.textContent || '').trim().slice(0, 14).replace(/\\s+/g, ' '),
          x: +r.left.toFixed(1), y: +r.top.toFixed(1),
          w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        };
      });
    };

    const rd = appD.getBoundingClientRect();
    const rl = appL.getBoundingClientRect();
    out.rootD = [rd.left, rd.top, rd.width, rd.height].map(v => +v.toFixed(1));
    out.rootL = [rl.left, rl.top, rl.width, rl.height].map(v => +v.toFixed(1));
    out.styleD = { display: getComputedStyle(appD).display, padding: getComputedStyle(appD).padding };
    out.styleL = { display: getComputedStyle(appL).display, padding: getComputedStyle(appL).padding };
    out.cardsD = grab(appD);
    out.cardsL = grab(appL);
    api.finish(false);
    return out;
  `);
  console.log(JSON.stringify(r, null, 2));
};
