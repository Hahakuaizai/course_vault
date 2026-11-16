/* 全面对比「真·深色界面」与「深色克隆体」的颜色是否一致。
   测试期间注入 transition/animation: none —— 否则 computed style 读到的是
   0.34s 颜色过渡的起始值，比出来的差异全是假的。 */
module.exports = async function (cdp) {
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.wait(2500);
  const r = await cdp.evaluate(`
    const st = document.createElement('style');
    st.id = '__noanim';
    st.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    document.head.appendChild(st);
    void document.body.offsetWidth;

    const appD = document.querySelector('.app');
    const api = window.__vaultThemeReveal;

    const sels = [
      '.sidebar', '.main', '.content',
      '.grid > *', '.grid > * .card-name', '.grid > * .card-sub',
      '.nav-item', '.toolbar', '.ghost-btn', '.crumb', '.title',
    ];
    const grab = (root) => sels.map((sel) => {
      const el = root.querySelector(sel);
      if (!el) return [sel, null];
      const s = getComputedStyle(el);
      return [sel, { c: s.color, bg: s.backgroundColor }];
    });

    /* 真·深色：模拟真实切换（documentElement + .app 一起改，
       否则 body 的 color 不会重新解析，读到的还是浅色） */
    const oldD = appD.dataset.theme;
    const oldR = document.documentElement.dataset.theme;
    appD.dataset.theme = 'dark';
    document.documentElement.dataset.theme = 'dark';
    void appD.offsetWidth;
    const dark = grab(appD);
    appD.dataset.theme = oldD;
    document.documentElement.dataset.theme = oldR;
    void appD.offsetWidth;

    /* 克隆体（appD 浅色 → 克隆体深色） */
    api.prepare('dark');
    const appL = document.getElementById('appL');
    void appL.offsetWidth;
    const clone = grab(appL);
    api.finish(false);

    st.remove();

    const diff = [];
    for (let i = 0; i < dark.length; i++) {
      const a = dark[i][1], b = clone[i][1];
      if (!a || !b) continue;
      for (const k of ['c', 'bg']) {
        if (a[k] !== b[k]) diff.push([dark[i][0], k, a[k], b[k]]);
      }
    }
    return { checked: dark.filter(d => d[1]).map(d => d[0]), diff };
  `);
  console.log('检查项:', r.checked.join(', '));
  console.log('=== 深色差异 ===');
  if (!r.diff.length) console.log('  ✅ 完全一致');
  r.diff.forEach((d) => console.log(`  ${d[0].padEnd(24)} ${d[1].padEnd(3)} 真=${d[2].padEnd(22)} 克隆=${d[3]}`));
};
