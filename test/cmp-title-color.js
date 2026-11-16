/* 对比深色克隆体里卡片标题的颜色是否与「真·深色界面」一致 */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const res = {};
    const card = document.querySelector('.grid > *');
    const title = card.querySelector('.card-title, .title, h3, .name') || card.querySelector('*');
    res.curTheme = document.documentElement.dataset.theme;
    res.titleCls = title.className;
    res.titleText = title.textContent.trim().slice(0, 12);
    res.titleColorCur = getComputedStyle(title).color;

    /* 临时把 appD 切成深色，看真正的深色下标题色 */
    const appD = document.querySelector('.app');
    const oldD = appD.dataset.theme;
    appD.dataset.theme = 'dark';
    void appD.offsetWidth;
    const t2 = appD.querySelector('.grid > * .card-title, .grid > * .title, .grid > * h3, .grid > * .name') || appD.querySelector('.grid > * *');
    res.titleColorDark = getComputedStyle(t2).color;

    /* 克隆体深色 */
    const api = window.__vaultThemeReveal;
    api.prepare('dark');
    const appL = document.getElementById('appL');
    void appL.offsetWidth;
    const t3 = appL.querySelector('.grid > * .card-title, .grid > * .title, .grid > * h3, .grid > * .name') || appL.querySelector('.grid > * *');
    res.titleColorClone = getComputedStyle(t3).color;
    res.cardBgDark = getComputedStyle(t2.closest('.card') || t2).backgroundColor;
    res.cardBgClone = getComputedStyle(t3.closest('.card') || t3).backgroundColor;

    /* 卡片本体的背景 */
    const cd = appD.querySelector('.grid > *'), cl = appL.querySelector('.grid > *');
    res.cardBgDark2 = getComputedStyle(cd).backgroundColor;
    res.cardBgClone2 = getComputedStyle(cl).backgroundColor;

    api.finish(false);
    appD.dataset.theme = oldD;
    return res;
  `);
  console.log(JSON.stringify(r, null, 2));
};
