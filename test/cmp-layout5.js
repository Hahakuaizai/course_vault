/* 对比 .content 的直接子元素序列与几何 */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const api = window.__vaultThemeReveal;
    api.prepare('dark');
    const appD = document.querySelector('.app');
    const appL = document.getElementById('appL');
    appL.dataset.theme = appD.dataset.theme;

    const kids = (root) => {
      const c = root.querySelector('.content');
      return [...c.children].map((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          cls: (el.className || el.tagName).toString().slice(0, 30),
          rect: [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)],
          mt: s.marginTop, mb: s.marginBottom, disp: s.display, fs: s.fontSize, lh: s.lineHeight,
        };
      });
    };
    const out = { D: kids(appD), L: kids(appL) };
    api.finish(false);
    return out;
  `);
  const fmt = (c) => c.map((x) => `  ${x.cls.padEnd(22)} ${JSON.stringify(x.rect)} mt=${x.mt} mb=${x.mb} ${x.disp} fs=${x.fs} lh=${x.lh}`).join('\n');
  console.log('=== 原界面 .content 子元素 ===\n' + fmt(r.D));
  console.log('=== 克隆体 .content 子元素 ===\n' + fmt(r.L));
};
