/* 直接调 prepare 看失败原因 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const api = window.__vaultThemeReveal;
    const appD = document.querySelector('.app');
    const out = { hasApi: !!api, hasAppD: !!appD,
                  parentIsBody: appD ? appD.parentNode === document.body : null };
    if (api) {
      try {
        out.prepared = api.prepare('dark');
        out.hasAppL = !!document.getElementById('appL');
        const l = document.getElementById('appL');
        if (l) {
          out.appLTheme = l.dataset.theme;
          out.appDTheme = appD.dataset.theme;
          out.clip = l.style.clipPath;
          out.bg = getComputedStyle(l).backgroundColor;
        }
      } catch (e) {
        out.error = e.message;
        out.stack = (e.stack || '').split('\\n').slice(0, 4).join(' | ');
      }
    }
    return out;
  `);
  console.log(JSON.stringify(r, null, 2));
};
