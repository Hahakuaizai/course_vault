/* 测双份 DOM 揭幕：拖动时页面是否实时跟随。
   先读当前主题，决定往哪边拖（往「另一边」拖）。 */
module.exports = async function (cdp) {
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const knob = document.querySelector('.tsw-knob');
    const kr = knob.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const sx = kr.left + kr.width / 2, sy = kr.top + kr.height / 2;
    const theme = document.documentElement.dataset.theme;
    /* 浅色时旋钮在右（pos=1），要往左拖；深色时在左，往右拖 */
    const dir = theme === 'light' ? -1 : 1;
    const base = { bubbles: true, cancelable: true, clientY: sy,
                   pointerId: 7, pointerType: 'mouse', button: 0 };

    btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: sx, buttons: 1 }));
    await new Promise(r => setTimeout(r, 40));

    const trail = [];
    for (let i = 1; i <= 8; i++) {
      const x = sx + dir * (br.width * 0.5 * i) / 8;
      btn.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, buttons: 1 }));
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
      const appL = document.getElementById('appL');
      trail.push({
        i,
        pos: +((new DOMMatrix(getComputedStyle(knob).transform).m41 - 15) / 210).toFixed(3),
        clip: appL ? +appL.style.clipPath.replace(/circle\\(([0-9.]+)px.*/, '$1') : null,
        appLTheme: appL ? appL.dataset.theme : null,
      });
    }
    btn.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: sx + dir * br.width * 0.5, buttons: 0,
    }));
    await new Promise(r => setTimeout(r, 1600));
    return {
      theme,
      trail,
      after: {
        theme: document.documentElement.dataset.theme,
        appTheme: document.querySelector('.app').dataset.theme,
        hasAppL: !!document.getElementById('appL'),
      },
    };
  `);

  console.log('起始主题', r.theme);
  console.log('\n拖动轨迹（pos → 裁剪半径 → 克隆体主题）:');
  r.trail.forEach((t) => {
    console.log(`  pos=${String(t.pos).padEnd(7)} clip=${String(t.clip).padEnd(9)} appL=${t.appLTheme}`);
  });
  const hasLayer = r.trail.some((t) => t.appLTheme);
  const clipChanges = new Set(r.trail.map((t) => t.clip)).size;
  console.log('\n揭幕层建立:', hasLayer ? '✅' : '❌');
  console.log('页面跟随:', clipChanges > 2 ? `✅ 裁剪半径有 ${clipChanges} 个不同值` : '❌ 半径没变');
  console.log('松手后', JSON.stringify(r.after),
    r.after.theme !== r.theme ? '✅ 主题已切换' : '❌ 主题没变');
};
