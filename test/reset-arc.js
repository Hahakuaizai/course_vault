/* 恢复被实验改掉的光弧样式 */
module.exports = async function (cdp) {
  const r = await cdp.evaluate(`
    const btn = document.querySelector('.tsw');
    const paths = [...btn.querySelectorAll('.tsw-arcs path')];
    paths.forEach(p => {
      p.style.stroke = '';
      p.style.opacity = '';
    });
    // 强制下一帧重新写 dasharray
    location.reload();
    return 'reloaded';
  `);
  console.log(r);
  await cdp.wait(3000);
};
