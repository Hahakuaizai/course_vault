module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const br = btn ? btn.getBoundingClientRect() : null;
    const kr = knob ? knob.getBoundingClientRect() : null;
    const out = {
      hasBtn: !!btn,
      hasKnob: !!knob,
      btnRect: br ? [br.left, br.top, br.width, br.height].map(v => +v.toFixed(1)) : null,
      knobRect: kr ? [kr.left, kr.top, kr.width, kr.height].map(v => +v.toFixed(1)) : null,
      theme: document.documentElement.dataset.theme,
      appTheme: document.querySelector('.app').dataset.theme,
      api: !!window.__vaultThemeReveal,
      apiActive: window.__vaultThemeReveal ? window.__vaultThemeReveal.active() : null,
      hasL: !!document.getElementById('appL'),
      debug: window.__tswDebug || null,
      ownsTransition: !!window.__vaultThemeSwitchOwnsTransition,
    };
    /* 直接试 prepare */
    if (window.__vaultThemeReveal) {
      try { out.prepareOk = window.__vaultThemeReveal.prepare('dark'); }
      catch (e) { out.prepareErr = String(e); }
      out.hasLAfter = !!document.getElementById('appL');
      if (window.__vaultThemeReveal.active()) window.__vaultThemeReveal.finish(false);
    }
    return out;
  `);
  console.log(JSON.stringify(r, null, 2));
};
