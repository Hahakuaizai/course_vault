/* 回归：点击切换主题时，侧栏底栏（备份/快捷键/设置/开关）不能错位。
   根因（已修）：pointerdown 先建揭幕层 → lift() 写 inline 定位 + 插隐形占位
   → pointerup 里 toggle() 又销毁重建，把痕迹一起克隆进揭幕层。
   表现：开关消失、左边三个按钮左移 27px、底栏行高从 47 变 92。 */
const { connect } = require('./cdp');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`); }
}

(async () => {
  const c = await connect();
  const ev = c.evaluate;
  await c.wait(2500);

  const geo = `(() => {
    const L = document.getElementById('appL');
    const D = document.querySelector('.app:not(#appL)');
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const q = (root, s) => (root ? root.querySelector(s) : null);
    return {
      hasL: !!L,
      realRow: r(q(D, '.foot-row')),
      cloneRow: L ? r(q(L, '.foot-row')) : null,
      realTsw: r(q(D, '.tsw')),
      cloneTsw: L ? r(q(L, '.tsw')) : null,
      clonePh: L ? L.querySelectorAll('.tsw-placeholder').length : null,
      clonePopover: L ? [...L.querySelectorAll('.tsw')].map((n) => n.hasAttribute('popover')) : null,
      cloneInline: L ? [...L.querySelectorAll('.tsw')].map((n) => n.getAttribute('style')) : null,
      realBtns: D ? [...D.querySelectorAll('.foot-row > .ghost-btn')].map((e) => Math.round(e.getBoundingClientRect().x)) : null,
      cloneBtns: L ? [...L.querySelectorAll('.foot-row > .ghost-btn')].map((e) => Math.round(e.getBoundingClientRect().x)) : null,
      nApp: document.querySelectorAll('.app').length,
      theme: document.documentElement.dataset.theme,
    };
  })()`;

  /* ---------- 1. 真实鼠标点击（走 pointerdown → lift → pointerup → toggle） ---------- */
  const base = await ev(`return ${geo}`);
  console.log('点前', JSON.stringify(base));
  check('点前只有一个 .app', base.nApp === 1, base.nApp);

  const box = await ev(`
    const b = document.querySelector('#themeSwitchHost .tsw').getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  `);

  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });

  /* 揭幕期间密集采样：只要有一帧错位就算失败 */
  let worstRow = null;
  let worstTsw = null;
  let sawClone = false;
  for (let i = 0; i < 26; i += 1) {
    await c.wait(90);
    const g = await ev(`return ${geo}`);
    if (!g.hasL) continue;
    sawClone = true;
    if (!worstRow || Math.abs(g.cloneRow[3] - g.realRow[3]) > Math.abs(worstRow.cloneRow[3] - worstRow.realRow[3])) worstRow = g;
    if (!worstTsw || Math.abs(g.cloneTsw[0] - g.realTsw[0]) > 2) worstTsw = g;
  }
  await c.wait(2500);
  const end = await ev(`return ${geo}`);

  check('揭幕期间确实建过克隆层（测试前提）', sawClone === true, sawClone);
  if (worstRow) {
    check('揭幕期间克隆层底栏行高与真实界面一致（没有多出的隐形占位）',
      Math.abs(worstRow.cloneRow[3] - worstRow.realRow[3]) <= 1,
      { clone: worstRow.cloneRow, real: worstRow.realRow });
    check('揭幕期间克隆层里没有 .tsw-placeholder',
      worstRow.clonePh === 0, worstRow.clonePh);
    check('揭幕期间克隆层里的开关副本摘掉了 popover',
      worstRow.clonePopover.every((v) => v === false), worstRow.clonePopover);
    check('揭幕期间克隆层里的开关副本没有 inline 定位',
      worstRow.cloneInline.every((s) => !s || (!s.includes('left:') && !s.includes('top:'))),
      worstRow.cloneInline);
    /* 容差 3px：lift() 会给真实按钮写 inline width（弹簧缩放中，实测
       81.9px vs 基础 84px），flex-end 对齐下克隆层副本会差 2px 左右。
       这不是错位 —— 旧 bug 是整整 27px，且行高从 47 涨到 92。 */
    const btnDx = worstRow.cloneBtns.map((x, i) => Math.abs(x - worstRow.realBtns[i]));
    check('揭幕期间克隆层里三个按钮的 x 与真实界面对齐（旧 bug 左移 27px）',
      btnDx.every((d) => d <= 3),
      { clone: worstRow.cloneBtns, real: worstRow.realBtns, dx: btnDx });
    check('揭幕期间克隆层里的开关没有掉出屏幕',
      Math.abs(worstRow.cloneTsw[1] - worstRow.realTsw[1]) <= 2,
      { clone: worstRow.cloneTsw, real: worstRow.realTsw });
  }
  check('切换结束只剩一个 .app', end.nApp === 1, end.nApp);
  check('主题确实切了', end.theme !== base.theme, { before: base.theme, after: end.theme });
  check('切换结束后底栏位置复原', JSON.stringify(end.realRow) === JSON.stringify(base.realRow),
    { before: base.realRow, after: end.realRow });

  /* ---------- 2. 连点三次（回归旧 bug） ---------- */
  await c.wait(2000);
  const t2 = await ev(`return document.documentElement.dataset.theme`);
  for (let i = 0; i < 3; i += 1) {
    const bb = await ev(`
      const b = document.querySelector('#themeSwitchHost .tsw').getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    `);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bb.x, y: bb.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bb.x, y: bb.y, button: 'left', clickCount: 1 });
    await c.wait(700);
  }
  await c.wait(6000);
  const burst = await ev(`return ${geo}`);
  check('连点三次后只剩一个 .app', burst.nApp === 1, burst);
  check('连点三次后底栏位置正常', JSON.stringify(burst.realRow) === JSON.stringify(base.realRow),
    { base: base.realRow, burst: burst.realRow });
  const cardBg = await ev(`
    const card = document.querySelector('.app:not(#appL) .card');
    return card ? getComputedStyle(card).backgroundColor : null;
  `);
  const htmlTheme = await ev(`return document.documentElement.dataset.theme`);
  if (cardBg) {
    const dark = +cardBg.match(/\d+/)[0] < 100;
    check('连点后卡片底色与主题一致', (htmlTheme === 'dark') === dark, { theme: htmlTheme, cardBg });
  }

  /* ---------- 3. 拖动路径不受影响 ---------- */
  await c.wait(2000);
  const t3 = await ev(`return document.documentElement.dataset.theme`);
  const b3 = await ev(`
    const b = document.querySelector('#themeSwitchHost .tsw').getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  `);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b3.x, y: b3.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i += 1) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b3.x + i * 14, y: b3.y, button: 'left', buttons: 1 });
    await c.wait(40);
  }
  const midDrag = await ev(`return ${geo}`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b3.x + 84, y: b3.y, button: 'left', clickCount: 1 });
  await c.wait(4000);
  const afterDrag = await ev(`return ${geo}`);
  if (midDrag.hasL) {
    check('拖动中克隆层底栏不错位',
      Math.abs(midDrag.cloneRow[3] - midDrag.realRow[3]) <= 1,
      { clone: midDrag.cloneRow, real: midDrag.realRow });
  }
  check('拖动结束后只剩一个 .app', afterDrag.nApp === 1, afterDrag.nApp);
  check('拖动结束后底栏位置正常', JSON.stringify(afterDrag.realRow) === JSON.stringify(base.realRow),
    { base: base.realRow, after: afterDrag.realRow });

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  c.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('致命：', e.message); process.exit(2); });
