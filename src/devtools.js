/*
 * ============================================================
 * 插件二（仅作者本机）：发布助手 —— 界面
 * ============================================================
 * 与插件一（自动更新内容）联动：更新弹窗展示本次更新时，弹窗底部
 * 多一个「发布助手」按钮，点开是两段独立的 PowerShell 代码，各带
 * 一键复制：
 *   一、上传到 GitHub：git add / commit / push，提交信息由插件一
 *       生成的本批说明简写而来（取每条的第一小句）；
 *   二、打包并发布 Release：build.js 打包到桌面 workspace（打包
 *       脚本会排除插件二本身）→ 压成 zip → gh release create。
 * 本文件只在主进程门禁通过（本机标记存在）时才被 app.js 动态加载；
 * 发布版里既没有标记、打包时也排除本文件，不会留下任何痕迹。
 * ============================================================
 */
(function () {
  'use strict';

  var DEV_DIR = 'C:\\Users\\30894\\Desktop\\workspace\\course-vault';
  var WORK_DIR = 'C:\\Users\\30894\\Desktop\\workspace';
  /* gh 在本机是便携版、不在 PATH 里：生成代码先定位 gh，
   * PATH 里没有时退回这个完整路径（见 releaseCode） */
  var GH_FALLBACK = 'C:\\Users\\30894\\tools\\gh\\bin\\gh.exe';

  var cur = null; // { batch, version }

  /* 取一条说明的「第一小句」：在冒号/句号/分号处收尾，最长 42 字 */
  function lead(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    var cut = t.search(/[：。；;]/);
    if (cut >= 8) t = t.slice(0, cut);
    if (t.length > 42) t = t.slice(0, 42);
    return t;
  }

  /* 进 PowerShell 双引号字符串前的清洗：内容里的反引号去掉、
   * $ 转义、双引号换成单引号，避免粘贴执行时被当成语法 */
  function psq(s) {
    return String(s).replace(/`/g, '').replace(/\$/g, '`$').replace(/"/g, "'");
  }

  function leadsOf(batch) {
    return ((batch && batch.items) || []).map(function (it) { return lead(it.text); }).filter(Boolean);
  }

  /* 第一段：上传 GitHub 的命令 + 由本批说明简写的提交信息 */
  function gitCode(batch) {
    var items = leadsOf(batch);
    var title = items.length > 1 ? items[0] + '（等 ' + items.length + ' 项）' : (items[0] || '更新');
    var extra = items.slice(1, 6).map(function (t) { return ' -m "' + psq(t) + '"'; }).join('');
    return [
      'cd ' + DEV_DIR,
      'git add -A',
      'git status',
      'git commit -m "' + psq(title) + '"' + extra,
      'git push',
    ].join('\n');
  }

  /* 第二段：打包当前项目（不带插件二）到桌面 workspace 并发布 Release。
   * 末尾发布不用裸 gh：便携版不在 PATH 里会报「无法识别命令」，
   * 先用 Get-Command 定位，没有再退回便携版完整路径 */
  function releaseCode(batch, version) {
    var v = version || '1.0.0';
    var items = leadsOf(batch);
    var notes = items.slice(0, 3).join('；') || '更新';
    var folder = '资料库-v' + v;
    return [
      'cd ' + DEV_DIR,
      'node build.js "..\\' + folder + '"',
      'Compress-Archive -Path "..\\' + folder + '" -DestinationPath "' + WORK_DIR + '\\' + folder + '.zip" -Force',
      '$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source',
      'if (-not $gh) { $gh = "' + GH_FALLBACK + '" }',
      '& $gh release create v' + v + ' "' + WORK_DIR + '\\' + folder + '.zip" --title "资料库 v' + v + '" --notes "' + psq(notes) + '"',
    ].join('\n');
  }

  function copyText(text, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* 复制失败不打扰 */ }
      ta.remove();
    }
  }

  /* app.js 在渲染更新内容时调用：传最近一批 batch 挂按钮（更新弹窗
   * 和设置里的历史视图都会传），传 null 时收起按钮和面板 */
  function attach(batch, version) {
    var btn = document.getElementById('btnDevtools');
    var panel = document.getElementById('devtoolsPanel');
    if (!btn || !panel) return;
    if (!batch) {
      cur = null;
      btn.hidden = true;
      panel.hidden = true;
      return;
    }
    cur = { batch: batch, version: version };
    btn.hidden = false;
    panel.hidden = true; // 每次打开弹窗先收起，点按钮才展开
  }

  function bind() {
    var btn = document.getElementById('btnDevtools');
    var panel = document.getElementById('devtoolsPanel');
    if (!btn || !panel) return;
    btn.addEventListener('click', function () {
      if (!cur) return;
      var willShow = panel.hidden;
      if (willShow) {
        document.getElementById('dvCode1').textContent = gitCode(cur.batch);
        document.getElementById('dvCode2').textContent = releaseCode(cur.batch, cur.version);
      }
      panel.hidden = !willShow;
    });
    document.getElementById('btnDvCopy1').addEventListener('click', function () {
      copyText(document.getElementById('dvCode1').textContent, this);
    });
    document.getElementById('btnDvCopy2').addEventListener('click', function () {
      copyText(document.getElementById('dvCode2').textContent, this);
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bind);
    } else {
      bind();
    }
  }

  window.__cvDevtools = { attach: attach, _build: { gitCode: gitCode, releaseCode: releaseCode, lead: lead } };
})();
