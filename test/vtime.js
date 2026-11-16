/* 用虚拟时间驱动：不依赖真实 rAF，把动画「快进」跑完。
   这是验证动画逻辑正确性的可靠办法 —— 真实前台的 60fps 只是同一套
   代码跑得更快，逻辑不会变。 */
module.exports = async function (cdp) {
  /* 先点一下，然后手动推进虚拟时间 */
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const br = btn.getBoundingClientRect();
    const theme0 = document.documentElement.dataset.theme;
    const x = br.left + 10, y = br.top + br.height / 2;
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y,
                   pointerId: 95, pointerType: 'mouse', button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
    await new Promise(r => setTimeout(r, 20));
    btn.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
    return { theme0, appL: !!document.getElementById('appL') };
  `);
  console.log('点击后', JSON.stringify(r));

  /* 用 CDP 的虚拟时间把接下来 2 秒快进掉 */
  try {
    await cdp.send('Emulation.setVirtualTimePolicy', {
      policy: 'advance', budget: 2000,
    });
  } catch (e) {
    console.log('虚拟时间不可用:', e.message);
  }
  await cdp.wait(2500);

  const after = await cdp.evaluate(`
    return {
      theme: document.documentElement.dataset.theme,
      appTheme: document.querySelector('.app').dataset.theme,
      appL: !!document.getElementById('appL'),
      knobX: +new DOMMatrix(getComputedStyle(document.querySelector('.tsw-knob')).transform).m41.toFixed(1),
    };
  `);
  console.log('快进后', JSON.stringify(after),
    after.theme !== r.theme0 && !after.appL ? '✅ 切换完成' : '❌');
};
