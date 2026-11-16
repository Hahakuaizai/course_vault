/* 截开关本体（深色/浅色两态），放大 6 倍 */
module.exports = async function (cdp) {
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.wait(2500);
  const r = await cdp.evaluate(`
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { } });
    const btn = document.querySelector('.tsw');
    const br = btn.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      rect: { x: br.left - 6, y: br.top - 6, width: br.width + 12, height: br.height + 12 },
    };
  `);
  console.log('当前主题', r.theme, '按钮', JSON.stringify(r.rect));
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...r.rect, scale: 6 },
  });
  require('fs').writeFileSync(
    require('path').resolve(__dirname, `.shot-switch-${r.theme}.png`),
    Buffer.from(res.data, 'base64'),
  );
  console.log(`已存 test/.shot-switch-${r.theme}.png`);
};
