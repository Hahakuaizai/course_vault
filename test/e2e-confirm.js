/** 验证软件风格确认框：无改动不弹、有改动才弹、样式与动画正常 */
const { connect } = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(ok);
    log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  };

  const f = await c.ev(`(() => {
    const s = window.__vaultDebug.state;
    const x = s.files.find(v => v.name === 'mama.py');
    s.view = { type: 'course', courseId: x.courseId };
    window.__vaultDebug.render();
    return { id: x.id, courseId: x.courseId };
  })()`);
  await sleep(500);

  // ---- 1. 打开预览后直接关（没改内容）→ 不该弹任何东西 ----
  await c.ev(`window.__vaultDebug.openPreview(${JSON.stringify(f.id)})`);
  await sleep(1000);
  await c.ev(`document.querySelector('#btnEdit')?.click()`);
  await sleep(700);

  const noChange = await c.ev(`(async () => {
    document.querySelector('#btnPreviewClose').click();
    await new Promise(r => setTimeout(r, 300));
    return {
      confirmShown: !document.querySelector('#confirmModal').hidden,
      overlayClosed: document.querySelector('#overlay').hidden,
    };
  })()`);
  log('① 没改动就关:', JSON.stringify(noChange));
  check('没改动不弹提示', !noChange.confirmShown);
  check('没改动直接关闭', noChange.overlayClosed);

  // ---- 2. 改了内容再关 → 应该弹软件风格确认框 ----
  await c.ev(`window.__vaultDebug.openPreview(${JSON.stringify(f.id)})`);
  await sleep(900);
  await c.ev(`document.querySelector('#btnEdit')?.click()`);
  await sleep(600);

  const withChange = await c.ev(`(async () => {
    const ta = document.querySelector('.editor');
    ta.value = ta.value + '\\n# 临时改动';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('#btnPreviewClose').click();
    await new Promise(r => setTimeout(r, 400));
    const m = document.querySelector('#confirmModal');
    if (!m || m.hidden) return { err: '确认框没出来' };
    const panel = m.querySelector('.modal');
    const cs = getComputedStyle(panel);
    const anim = getComputedStyle(m).animationName;
    const panelAnim = getComputedStyle(panel).animationName;
    return {
      shown: true,
      title: document.querySelector('#confirmTitle').textContent,
      lead: document.querySelector('#confirmLead').textContent,
      okText: document.querySelector('#btnConfirmOk').textContent,
      isDanger: document.querySelector('#btnConfirmOk').classList.contains('danger-btn'),
      bg: cs.backgroundColor,
      radius: cs.borderRadius,
      zIndex: getComputedStyle(m).zIndex,
      backdropAnim: anim,
      panelAnim,
      okFocused: document.activeElement === document.querySelector('#btnConfirmOk'),
      overlayStillOpen: !document.querySelector('#overlay').hidden,
    };
  })()`);
  log('② 有改动再关:', JSON.stringify(withChange, null, 1));
  check('有改动会弹确认框', withChange.shown);
  check('确认框不是白框（用主题底色）', withChange.bg && !withChange.bg.includes('255, 255, 255'),
    withChange.bg);
  check('有淡入动画', withChange.backdropAnim === 'fadeIn', withChange.backdropAnim);
  check('面板有滑入动画', withChange.panelAnim === 'panelIn', withChange.panelAnim);
  check('确定按钮是危险色', withChange.isDanger);
  check('确认框在最上层', withChange.zIndex === '100', withChange.zIndex);
  check('弹框时预览还开着', withChange.overlayStillOpen);

  // ---- 3. 点「取消」→ 预览应该还开着 ----
  const cancelled = await c.ev(`(async () => {
    document.querySelector('#btnConfirmCancel').click();
    await new Promise(r => setTimeout(r, 300));
    return {
      confirmClosed: document.querySelector('#confirmModal').hidden,
      overlayOpen: !document.querySelector('#overlay').hidden,
      stillEditing: !!document.querySelector('.editor'),
    };
  })()`);
  log('③ 点取消:', JSON.stringify(cancelled));
  check('取消后确认框关闭', cancelled.confirmClosed);
  check('取消后预览仍开着', cancelled.overlayOpen);

  // ---- 4. 点「放弃修改」→ 预览应该关闭 ----
  const discarded = await c.ev(`(async () => {
    document.querySelector('#btnPreviewClose').click();
    await new Promise(r => setTimeout(r, 400));
    document.querySelector('#btnConfirmOk').click();
    await new Promise(r => setTimeout(r, 400));
    return {
      confirmClosed: document.querySelector('#confirmModal').hidden,
      overlayClosed: document.querySelector('#overlay').hidden,
    };
  })()`);
  log('④ 点放弃修改:', JSON.stringify(discarded));
  check('确认后关闭预览', discarded.overlayClosed);

  // ---- 5. ESC 关确认框 ----
  await c.ev(`window.__vaultDebug.openPreview(${JSON.stringify(f.id)})`);
  await sleep(900);
  await c.ev(`document.querySelector('#btnEdit')?.click()`);
  await sleep(600);
  const escaped = await c.ev(`(async () => {
    const ta = document.querySelector('.editor');
    ta.value = ta.value + '\\n# x';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    document.querySelector('#btnPreviewClose').click();
    await new Promise(r => setTimeout(r, 350));
    const shown = !document.querySelector('#confirmModal').hidden;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return {
      shownBeforeEsc: shown,
      closedAfterEsc: document.querySelector('#confirmModal').hidden,
      overlayStillOpen: !document.querySelector('#overlay').hidden,
    };
  })()`);
  log('⑤ ESC 关闭:', JSON.stringify(escaped));
  check('ESC 能关掉确认框', escaped.closedAfterEsc);
  check('ESC 关框后预览还在', escaped.overlayStillOpen);

  // 收尾：直接关掉预览（这次点确定）
  await c.ev(`(async () => {
    document.querySelector('#btnPreviewClose')?.click();
    await new Promise(r => setTimeout(r, 350));
    if (!document.querySelector('#confirmModal').hidden) document.querySelector('#btnConfirmOk').click();
    await new Promise(r => setTimeout(r, 300));
    const d = window.__vaultDebug;
    d.state.view = { type: 'all', courseId: null };
    d.render();
  })()`);

  const okCount = results.filter(Boolean).length;
  log(`\n${okCount}/${results.length} 项通过`);
  c.close();
  if (okCount !== results.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
