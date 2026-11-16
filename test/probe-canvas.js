module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const cv = document.querySelector('.tsw-cv');
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n += 1;
    return {
      w: cv.width, h: cv.height,
      painted: n,
      total: cv.width * cv.height,
      theme: document.documentElement.dataset.theme,
      btnAria: document.querySelector('.tsw').getAttribute('aria-checked'),
      knobX: +new DOMMatrix(getComputedStyle(document.querySelector('.tsw-knob')).transform).m41.toFixed(1),
      cvStyleW: +cv.getBoundingClientRect().width.toFixed(2),
    };
  `);
  console.log(JSON.stringify(r, null, 2));
};
