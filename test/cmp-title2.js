/* 精确找卡片标题元素，对比浅色/深色下的颜色 */
module.exports = async function (cdp) {
  await cdp.wait(800);
  const r = await cdp.evaluate(`
    const appD = document.querySelector('.app');
    const card = appD.querySelector('.grid > *');
    /* 打印卡片结构，找文字节点 */
    const walk = (el, depth) => {
      if (depth > 3) return [];
      return [...el.children].map((c) => {
        const s = getComputedStyle(c);
        return {
          d: depth, cls: (c.className || '').toString().slice(0, 30),
          txt: (c.textContent || '').trim().slice(0, 10),
          color: s.color, fs: s.fontSize,
          kids: walk(c, depth + 1),
        };
      });
    };
    const old = appD.dataset.theme;
    appD.dataset.theme = 'light'; void appD.offsetWidth;
    const light = walk(card, 0);
    appD.dataset.theme = 'dark'; void appD.offsetWidth;
    const dark = walk(card, 0);
    appD.dataset.theme = old;
    return { cardCls: card.className, light, dark };
  `);
  const flat = (arr, out = []) => { for (const x of arr) { out.push(x); flat(x.kids, out); } return out; };
  const L = flat(r.light), D = flat(r.dark);
  console.log('卡片类名:', r.cardCls);
  for (let i = 0; i < L.length; i++) {
    const t = L[i].txt || D[i].txt;
    if (!t) continue;
    console.log(`  ${' '.repeat(L[i].d * 2)}${L[i].cls.padEnd(24)} "${t}"  light=${L[i].color}  dark=${D[i].color}`);
  }
};
