/* 探测：用 setTimeout 而不是 rAF（后台窗口 rAF 会被完全停掉） */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const knob = btn.querySelector('.tsw-knob');
    const br = btn.getBoundingClientRect();
    const m = new DOMMatrix(getComputedStyle(knob).transform);
    const before = getComputedStyle(knob).transform;
    await new Promise(r => setTimeout(r, 300));
    const after = getComputedStyle(knob).transform;
    /* 命中测试：按钮中心的元素是谁 */
    const hitEl = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    return {
      hidden: document.hidden,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      theme: document.documentElement.dataset.theme,
      aria: btn.getAttribute('aria-checked'),
      rect: { x: +br.left.toFixed(1), y: +br.top.toFixed(1),
              w: +br.width.toFixed(1), h: +br.height.toFixed(1) },
      knobTranslateX: +m.m41.toFixed(2),
      u: +((m.m41 - 15) / 210).toFixed(4),
      changedOver300ms: before !== after,
      hitElement: hitEl ? hitEl.className || hitEl.tagName : 'null',
      hitIsInsideBtn: hitEl ? btn.contains(hitEl) : false,
      btnPointerEvents: getComputedStyle(btn).pointerEvents,
      isPopoverOpen: btn.matches(':popover-open'),
      btnDisplay: getComputedStyle(btn).display,
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
