module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const out = { theme: document.documentElement.dataset.theme, layers: {} };
    const names = ['tsw-dock', 'tsw-track', 'tsw-halo', 'tsw-cor', 'tsw-knob',
                   'tsw-gw', 'tsw-ig', 'tsw-cv', 'tsw-arcs', 'tsw-gl', 'tsw-fx', 'tsw-band'];
    for (const n of names) {
      const el = btn.querySelector('.' + n) || document.querySelector('.' + n);
      if (!el) { out.layers[n] = 'missing'; continue; }
      const s = getComputedStyle(el);
      out.layers[n] = {
        op: s.opacity, vis: s.visibility, filter: s.filter,
        bg: s.backgroundColor, tr: s.transform.slice(0, 40),
        z: s.zIndex, mix: s.mixBlendMode,
      };
    }
    out.btnFilter = getComputedStyle(btn).filter;
    out.btnOpacity = getComputedStyle(btn).opacity;
    out.anims = document.getAnimations().length;
    out.pending = document.getAnimations().map(a => (a.animationName || a.transitionProperty || '?') + ':' + a.playState).slice(0, 12);
    return out;
  `);
  console.log(JSON.stringify(r, null, 2));
};
