/* 把开关和揭幕层恢复到干净状态 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const out = {};
    const btn = document.querySelector('.tsw');
    if (btn) {
      const br = btn.getBoundingClientRect();
      const base = { bubbles: true, cancelable: true, clientX: br.left + 10,
                     clientY: br.top + br.height / 2, pointerId: 140,
                     pointerType: 'mouse', button: 0 };
      btn.dispatchEvent(new PointerEvent('pointercancel', { ...base }));
      btn.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
    }
    const l = document.getElementById('appL');
    if (l) l.remove();
    if (window.__vaultThemeReveal) window.__vaultThemeReveal.finish(false);
    const app = document.querySelector('.app');
    out.theme = document.documentElement.dataset.theme;
    out.appTheme = app ? app.dataset.theme : null;
    out.hasL = !!document.getElementById('appL');
    return out;
  `);
  console.log('重置后', JSON.stringify(r));
};
