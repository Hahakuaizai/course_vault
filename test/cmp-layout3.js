/* 逐个排除 appL 上的内联样式，找出导致布局偏移的那一条 */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const api = window.__vaultThemeReveal;
    const appD = document.querySelector('.app');
    const g = (root) => {
      const el = root.querySelector('.card, .file-card');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1)];
    };
    const base = g(appD);
    const out = { base, cases: [] };

    api.prepare('dark');
    const appL = document.getElementById('appL');
    appL.dataset.theme = appD.dataset.theme;   // 排除主题影响

    const cases = [
      ['全开（当前）', () => {}],
      ['去掉 contain', () => { appL.style.contain = ''; }],
      ['去掉 willChange', () => { appL.style.willChange = ''; }],
      ['去掉 background', () => { appL.style.background = ''; }],
      ['position 改回 static', () => { appL.style.position = ''; appL.style.inset = ''; }],
      ['去掉 clipPath', () => { appL.style.clipPath = ''; }],
      ['去掉 aria-hidden', () => { appL.removeAttribute('aria-hidden'); }],
    ];
    for (const [name, fn] of cases) {
      fn();
      /* 强制回流 */
      void appL.offsetWidth;
      out.cases.push([name, g(appL)]);
    }
    api.finish(false);
    return out;
  `);
  console.log('原界面卡片', JSON.stringify(r.base));
  r.cases.forEach(([n, v]) => console.log(`  ${n.padEnd(22)} ${JSON.stringify(v)}`));
};
