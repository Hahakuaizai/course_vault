/* 卡片为什么被缩了 1.5%：查 animation / transform */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const api = window.__vaultThemeReveal;
    api.prepare('dark');
    const appD = document.querySelector('.app');
    const appL = document.getElementById('appL');

    const probe = (root) => {
      const c = root.querySelector('.grid > *');
      const s = getComputedStyle(c);
      return {
        transform: s.transform,
        animName: s.animationName,
        animDur: s.animationDuration,
        animFill: s.animationFillMode,
        animPlay: s.animationPlayState,
        opacity: s.opacity,
        anims: c.getAnimations().map((a) => ({
          name: a.animationName || (a.transitionProperty || 'transition'),
          t: a.currentTime, dur: a.effect && a.effect.getTiming().duration,
          state: a.playState,
        })),
        cls: c.className,
      };
    };
    const out = { D: probe(appD), L: probe(appL) };
    api.finish(false);
    return out;
  `);
  console.log('原界面', JSON.stringify(r.D, null, 2));
  console.log('克隆体', JSON.stringify(r.L, null, 2));
};
