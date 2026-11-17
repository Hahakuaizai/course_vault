/* ==========================================================================
   启动主题预落定（theme-init）
   普通脚本、放在 <head> 里样式表之前同步执行 —— 页面解析、首帧绘制
   之前就把 <html data-theme> 定下来。
   为什么需要：主题选择存在数据库里，要等主进程 bootstrap 才拿得到，
   之后 boot() 才 applyTheme。在那之前页面按默认浅色绘制，深色用户
   每次启动（尤其冷启动那几秒）都会先看到一片浅色，加载层盖满全屏
   时格外明显。这里读 app.js 镜像在 localStorage 的选择提前落定；
   boot() 完成后仍以数据库里的设置为准，本文件只管「第一帧」。
   ========================================================================== */
(() => {
  try {
    const choice = localStorage.getItem('cv:themeChoice');
    const dark = choice === 'dark'
      || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch {
    /* 读不到镜像就保持默认浅色，boot() 之后会纠正 */
  }
})();
