/* 对比克隆体与真实界面布局。
   后台窗口里原界面自己的入场动画（cardIn）也被冻结在 0%，
   所以先把所有动画推到终态再比 —— 真实前台运行时它早就播完了。 */
module.exports = async function (cdp) {
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.wait(2500);
  const r = await cdp.evaluate(`
    /* 把真实界面所有动画推到终态 */
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { } });
    void document.body.offsetWidth;

    const api = window.__vaultThemeReveal;
    const appD = document.querySelector('.app');
    const g = (root) => {
      const el = root.querySelector('.grid > *');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { rect: [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)],
               transform: s.transform, opacity: s.opacity };
    };
    const out = { D: g(appD) };
    api.prepare('dark');
    const appL = document.getElementById('appL');
    appL.dataset.theme = appD.dataset.theme;
    void appL.offsetWidth;
    out.L = g(appL);

    /* 多取几个元素对齐检查 */
    const sels = ['.content', '.grid', '.sidebar', '.topbar'];
    out.align = sels.map((sel) => {
      const a = appD.querySelector(sel), b = appL.querySelector(sel);
      if (!a || !b) return [sel, 'missing'];
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const A = [ra.left, ra.top, ra.width, ra.height].map(v => +v.toFixed(1));
      const B = [rb.left, rb.top, rb.width, rb.height].map(v => +v.toFixed(1));
      return [sel, A.join(), B.join(), A.join() === B.join() ? 'ok' : 'diff'];
    });
    api.finish(false);
    return out;
  `);
  console.log('原界面', JSON.stringify(r.D));
  console.log('克隆体', JSON.stringify(r.L));
  r.align.forEach((a) => console.log(`  ${a[0].padEnd(12)} ${a[3]}  D=${a[1]}  L=${a[2]}`));
  console.log(r.D.rect.join() === r.L.rect.join() ? '✅ 卡片完全对齐' : '❌ 仍有偏差');
};
