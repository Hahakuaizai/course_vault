/** 回归：拖进回收站、拖放范围、编辑高亮、重命名、打开方式 都不该被新改动弄坏 */
const { connect } = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  };

  // 1) 拖放区域是整个 #content 而不是 #grid
  const zones = await c.ev(`(() => {
    const content = document.querySelector('#content');
    const grid = document.querySelector('#grid');
    // 检查 CSS 是否有 .content.drop-root
    const sheet = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
    const hasRule = sheet.some(r => r.selectorText && r.selectorText.includes('.content.drop-root'));
    return { contentW: Math.round(content.getBoundingClientRect().width),
             gridW: Math.round(grid.getBoundingClientRect().width), hasRule };
  })()`);
  check('拖放范围覆盖整个内容区', zones.hasRule && zones.contentW > zones.gridW,
    `content ${zones.contentW}px > grid ${zones.gridW}px`);

  // 2) 回收站导航项有 drop-trash 样式
  const trash = await c.ev(`(() => {
    const nav = document.querySelector('#navTrash');
    const sheet = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
    const hasRule = sheet.some(r => r.selectorText && r.selectorText.includes('.nav-item.drop-trash'));
    return { hasNav: !!nav, hasRule, title: nav?.title || '' };
  })()`);
  check('回收站可拖入', trash.hasNav && trash.hasRule, trash.title);

  // 3) 编辑器高亮双层结构
  const f = await c.ev(`(() => {
    const s = window.__vaultDebug.state;
    const x = s.files.find(v => v.name === 'mama.py');
    return { id: x.id, courseId: x.courseId };
  })()`);
  await c.ev(`(() => { const d = window.__vaultDebug; d.state.view = { type:'course', courseId:${JSON.stringify(f.courseId)} }; d.render(); })()`);
  await sleep(400);
  await c.ev(`window.__vaultDebug.openPreview(${JSON.stringify(f.id)})`);
  await sleep(1000);
  await c.ev(`document.querySelector('#btnEdit')?.click()`);
  await sleep(700);
  const ed = await c.ev(`(() => {
    const w = document.querySelector('.editor-wrap');
    if (!w) return { err: 'no wrap' };
    const ta = w.querySelector('.editor'), pre = w.querySelector('.editor-highlight');
    return { hasTa: !!ta, hasPre: !!pre, spans: pre.querySelectorAll('span').length,
             scrollMatch: ta.scrollHeight === pre.scrollHeight };
  })()`);
  check('编辑时语法高亮', ed.hasTa && ed.hasPre && ed.spans > 0,
    `${ed.spans} 个高亮片段`);
  await c.ev(`document.querySelector('#btnPreviewClose')?.click()`);
  await sleep(300);

  // 4) 打开方式候选随扩展名变化
  const py = await c.ev(`window.vault.files.editorsForFile(${JSON.stringify(f.id)})`);
  const txt = await c.ev(`(async () => {
    const s = await window.vault.getState();
    const t = s.files.find(x => x.name.endsWith('.txt'));
    return t ? window.vault.files.editorsForFile(t.id) : null;
  })()`);
  check('打开方式按扩展名筛选', py.length > 0 && txt.length > 0,
    `py: ${py.length} 个, txt: ${txt ? txt.length : 0} 个`);

  // 5) 文件右键菜单包含重命名
  await c.ev(`(() => { const d = window.__vaultDebug; d.state.view = { type:'course', courseId:${JSON.stringify(f.courseId)} }; d.render(); })()`);
  await sleep(400);
  const menu = await c.ev(`(() => {
    const card = document.querySelector('.card[data-file="${f.id}"]');
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
      clientX: Math.round(r.left+40), clientY: Math.round(r.top+40) }));
    return [...document.querySelector('.ctx-menu').querySelectorAll('.ctx-item')].map(b => b.textContent.trim());
  })()`);
  check('右键有重命名', menu.includes('重命名'), menu.join(' / '));
  await c.ev(`document.body.click()`);

  // 6) 主进程未被卡住
  const t0 = Date.now();
  await c.ev(`1+1`);
  check('界面响应正常', Date.now() - t0 < 2000, `${Date.now() - t0}ms`);

  // 还原视图
  await c.ev(`(() => { const d = window.__vaultDebug; d.state.view = { type:'all', courseId:null }; d.render(); })()`);

  const okCount = results.filter((r) => r.ok).length;
  log(`\n${okCount}/${results.length} 项通过`);
  c.close();
  if (okCount !== results.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
