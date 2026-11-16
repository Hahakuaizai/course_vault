/** 验证「用其他软件打开」：注册表候选 + 内置编辑器合并去重，且不卡主进程 */
const { connect } = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);

  // 用 .py 和 .txt 各测一次，看候选是否随扩展名变化
  const targets = await c.ev(`(async () => {
    const s = await window.vault.getState();
    const pick = (re) => { const f = s.files.find(x => re.test(x.name)); return f ? { id: f.id, name: f.name } : null; };
    return { py: pick(/\\.py$/), txt: pick(/\\.txt$/), pdf: pick(/\\.pdf$/), html: pick(/\\.html$/) };
  })()`);
  log('测试文件:', JSON.stringify(targets));

  for (const [kind, f] of Object.entries(targets)) {
    if (!f) continue;
    const t0 = Date.now();
    const apps = await c.ev(`window.vault.files.editorsForFile(${JSON.stringify(f.id)})`);
    const cost = Date.now() - t0;
    log(`【${kind} ${f.name}】耗时 ${cost}ms →`,
      (apps || []).map((a) => `${a.label}${a.isDefault ? '(默认)' : ''}`).join(' / ') || '（无）');
  }

  // 确认界面此刻仍然响应（异步化后主进程不该被卡住）
  const t1 = Date.now();
  const alive = await c.ev(`(() => ({ t: performance.now(), cards: document.querySelectorAll('.card').length }))()`);
  log(`\n界面仍响应: ${Date.now() - t1}ms,`, JSON.stringify(alive));

  // 模拟菜单：完整走一遍右键 → 用其他软件打开
  const menu = await c.ev(`(async () => {
    const s = window.__vaultDebug.state;
    const f = s.files.find(x => x.name === ${JSON.stringify((targets.py || targets.txt || {}).name || '')});
    if (!f) return { err: '找不到文件' };
    // apply({...state, view}) 不生效：applyState 不读 next.view，得先改再 render
    window.__vaultDebug.state.view = { type: 'course', courseId: f.courseId };
    window.__vaultDebug.render();
    await new Promise(r => setTimeout(r, 400));
    const card = document.querySelector('.card[data-file="' + f.id + '"]');
    if (!card) return { err: '卡片没出来' };
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 40) }));
    const ctx = document.querySelector('.ctx-menu');
    const btn = [...ctx.querySelectorAll('.ctx-item')].find(b => b.textContent.trim() === '用其他软件打开');
    if (!btn) return { err: '没有该项', items: [...ctx.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()) };
    const t0 = performance.now();
    btn.click();
    // 等二级菜单出现
    for (let i = 0; i < 40; i += 1) {
      await new Promise(r => setTimeout(r, 100));
      const m = document.querySelector('.ctx-menu');
      const items = [...(m?.querySelectorAll('.ctx-item') || [])].map(b => b.textContent.trim());
      if (items.length && !items.includes('用其他软件打开')) {
        return { cost: Math.round(performance.now() - t0), items };
      }
    }
    return { err: '二级菜单超时' };
  })()`);
  log('\n【打开方式二级菜单】', JSON.stringify(menu, null, 1));

  await c.ev(`document.body.click()`);
  c.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
