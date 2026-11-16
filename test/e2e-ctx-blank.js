/** 验证：空白处右键能弹菜单（这次挂在 #content 上） */
const { connect } = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);

  // 切到有文件的目录，让网格只占一部分高度
  const info = await c.ev(`(() => {
    const d = window.__vaultDebug;
    const s = d.state;
    const f = s.files.find(x => x.name === 'mama.py');
    s.view = { type: 'course', courseId: f.courseId };
    d.render();
    return { courseId: f.courseId };
  })()`);
  await sleep(600);

  // 在卡片下方很远的地方（内容区空白处）右键
  const blank = await c.ev(`(() => {
    const content = document.querySelector('#content');
    const grid = document.querySelector('#grid');
    const cr = content.getBoundingClientRect();
    const gr = grid.getBoundingClientRect();
    // 取网格底部往下 200px 的位置 —— 那里是 .content 的空白
    const x = Math.round(cr.left + 120);
    const y = Math.round(Math.min(gr.bottom + 200, cr.bottom - 40));
    const target = document.elementFromPoint(x, y);
    content.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }));
    const ctx = document.querySelector('.ctx-menu');
    return {
      contentBottom: Math.round(cr.bottom),
      gridBottom: Math.round(gr.bottom),
      clickY: y,
      clickedOn: target?.id || target?.className || target?.tagName,
      menuShown: !!ctx,
      items: [...(ctx?.querySelectorAll('.ctx-item') || [])].map(b => b.textContent.trim()),
    };
  })()`);
  log('【空白处右键】', JSON.stringify(blank, null, 1));

  await c.ev(`document.body.click()`);
  await c.ev(`(() => { const d = window.__vaultDebug; d.state.view = { type:'all', courseId:null }; d.render(); })()`);

  log(blank.menuShown ? '\n✅ 空白处能弹出菜单' : '\n❌ 空白处仍然没反应');
  c.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
