/* 测点击和拖动。用 JS 派发 PointerEvent，绕过 CDP 输入层
   （后台窗口时 CDP 输入会被丢弃，rAF 也会停）。 */
module.exports = async function (cdp) {
  /* 先让页面认为自己是活跃的，rAF 才会跑 */
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const init = await cdp.evaluate(`
    const b = document.querySelector('.tsw');
    const r = b.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             theme: document.documentElement.dataset.theme,
             hidden: document.hidden };
  `);
  console.log('初始', JSON.stringify(init));

  /* ---------- 1. 点击轨道（不在旋钮上） ---------- */
  const clickRes = await cdp.evaluate(`
    const b = document.querySelector('.tsw');
    const r = b.getBoundingClientRect();
    /* 点轨道靠左的位置，确保不在旋钮上 */
    const x = r.left + 8, y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y,
                   pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
    b.dispatchEvent(new PointerEvent('pointerdown', opts));
    b.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    await new Promise(r => setTimeout(r, 1200));
    return { theme: document.documentElement.dataset.theme,
             aria: b.getAttribute('aria-checked') };
  `);
  console.log('点轨道后', JSON.stringify(clickRes),
    clickRes.theme !== init.theme ? '✅ 切换成功' : '❌ 没切换');

  /* ---------- 2. 拖动：从旋钮按下，往右拖 ---------- */
  const dragRes = await cdp.evaluate(`
    const b = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const kr = knob.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const sx = kr.left + kr.width / 2, sy = kr.top + kr.height / 2;
    const base = { bubbles: true, cancelable: true, clientY: sy,
                   pointerId: 2, pointerType: 'mouse', button: 0 };
    b.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));
    const seen = [];
    for (let i = 1; i <= 10; i++) {
      const x = sx + (br.width * 0.5 * i) / 10;
      b.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, buttons: 1 }));
      await new Promise(r => setTimeout(r, 16));
      const m = new DOMMatrix(getComputedStyle(knob).transform);
      seen.push(+m.m41.toFixed(1));
    }
    b.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: sx + br.width * 0.5, buttons: 0,
    }));
    await new Promise(r => setTimeout(r, 1200));
    const m = new DOMMatrix(getComputedStyle(knob).transform);
    return {
      knobTrail: seen,
      finalKnobX: +m.m41.toFixed(1),
      theme: document.documentElement.dataset.theme,
      aria: b.getAttribute('aria-checked'),
    };
  `);
  console.log('拖动轨迹', JSON.stringify(dragRes.knobTrail));
  const moved = dragRes.knobTrail.some((v, i) => i > 0 && v !== dragRes.knobTrail[0]);
  console.log('拖动跟手', moved ? '✅' : '❌', '最终 knobX', dragRes.finalKnobX);
  console.log('拖动后', JSON.stringify({ theme: dragRes.theme, aria: dragRes.aria }));

  /* ---------- 3. 尺寸 ---------- */
  console.log('尺寸', JSON.stringify(await cdp.evaluate(`
    const b = document.querySelector('.tsw').getBoundingClientRect();
    const k = document.querySelector('.tsw-knob').getBoundingClientRect();
    const m = new DOMMatrix(getComputedStyle(document.querySelector('.tsw-knob')).transform);
    return { btn: [+b.width.toFixed(1), +b.height.toFixed(1)],
             knob: [+k.width.toFixed(1), +k.height.toFixed(1)],
             travel: +(210 * (b.width / 440)).toFixed(1) };
  `)));
};
