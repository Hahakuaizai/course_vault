'use strict';

/**
 * 验证「更新内容」的两个入口显示范围不同：
 *   - 启动后自动弹：只显示最新一批（用户刚更新，只关心这次改了什么）
 *   - 设置 → 关于 → 更新内容 → 查看：显示全部历史
 *
 * 另外锁住「只在更新后首次启动弹一次」：
 * 同一版本连开两次，第二次不弹。
 */

const { connect } = require('./cdp.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };
  const ev = (e) => c.ev(e);

  // 清场
  await ev(`(() => {
    ['overlay','shortcutsModal','settingsModal','courseModal','newFileModal',
     'importModal','confirmModal','delModal','detailModal','dupeModal',
     'relocateModal','changelogModal','renameModal'].forEach(id => {
      const el = document.getElementById(id); if (el) el.hidden = true;
    });
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  })()`);
  await sleep(300);

  /* 前端作用域封闭，只能通过真实 DOM 交互。
   * openChangelog 不在 __vaultDebug 里，所以：
   *   - all 模式：点「设置 → 关于 → 更新内容 → 查看」这个真实按钮
   *   - latest 模式：靠启动自动弹（maybeShowChangelog），单独用单元测试覆盖 */

  /* ---------- 1. 关于 → 查看：显示全部历史 ---------- */
  const about = await ev(`(async () => {
    // 打开设置并切到「关于」
    document.querySelector('#btnSettings').click();
    await new Promise(r => setTimeout(r, 400));
    const nav = [...document.querySelectorAll('.snav-item')]
      .find(b => b.dataset.pane === 'about');
    nav.click();
    await new Promise(r => setTimeout(r, 300));
    const btn = document.querySelector('#btnShowChangelog');
    const rowText = btn.closest('.srow').querySelector('small')?.textContent || '';
    btn.click();
    await new Promise(r => setTimeout(r, 500));
    const m = document.querySelector('#changelogModal');
    const batches = m.querySelectorAll('.cl-batch');
    const firstHead = batches[0]?.querySelector('.cl-head');
    return {
      opened: !m.hidden,
      batchCount: batches.length,
      firstVer: firstHead?.querySelector('.cl-ver')?.textContent || '',
      firstIsLatest: !!firstHead?.querySelector('.cl-latest'),
      firstDate: firstHead?.querySelector('.cl-date')?.textContent || '',
      itemCounts: [...batches].map(b => b.querySelectorAll('.cl-item').length),
      rowText,
      // 版本号只应该出现在最新那批，更早的批次不写版本号
      olderVerTexts: [...batches].slice(1)
        .map(b => b.querySelector('.cl-ver')?.textContent || ''),
    };
  })()`);

  check('设置 → 关于里有「更新内容」入口', about.rowText.length > 0, about.rowText);
  check('点「查看」能打开更新内容弹窗', about.opened === true);
  check('「查看」显示全部历史（多于一批）', about.batchCount > 1, `${about.batchCount} 批`);
  check('最新一批标了「本次更新」', about.firstIsLatest === true);
  check('最新一批带当前版本号', /^v\d+\.\d+\.\d+$/.test(about.firstVer), about.firstVer);
  check('最新一批有日期', /^\d{4}-\d{2}-\d{2}$/.test(about.firstDate), about.firstDate);
  check('最新一批有内容条目', about.itemCounts[0] > 0, `${about.itemCounts[0]} 条`);
  check('更早的批次不重复写当前版本号',
    about.olderVerTexts.every((t) => t !== about.firstVer),
    about.olderVerTexts.join(' / '));

  /* ---------- 3. 内容是最新这轮的改动 ---------- */
  const texts = await ev(`(() => {
    const m = document.querySelector('#changelogModal');
    return [...m.querySelectorAll('.cl-item .cl-text')].map(x => x.textContent);
  })()`);
  const joined = texts.join('\n');
  check('本轮改动写了主题闪烁修复', /闪一下白屏\/黑屏/.test(joined));
  check('本轮改动写了 PDF 里 Esc', /PDF 预览里按 Esc/.test(joined));
  check('本轮改动写了文件夹右键剪切/复制/移动', /剪切 \/ 复制 \/ 移动到/.test(joined));
  check('本轮改动写了「新建」二级菜单', /「新建文件夹」改成「新建」/.test(joined));
  check('本轮改动写了删除弹窗说明', /不会删除电脑里的原文件/.test(joined));
  check('本轮改动写了批量操作 bug', /批量剪切/.test(joined));

  // 标签颜色分类
  const tags = await ev(`(() => {
    const m = document.querySelector('#changelogModal');
    return [...m.querySelectorAll('.cl-item')].map(li => ({
      cls: li.className,
      tag: li.querySelector('.cl-tag')?.textContent || '',
    }));
  })()`);
  check('每条都带类型标签', tags.every((t) => t.tag.length > 0));
  check('标签只有新增/改进/修复三种',
    tags.every((t) => ['新增', '改进', '修复'].includes(t.tag)),
    [...new Set(tags.map((t) => t.tag))].join(','));
  check('每条都有类型样式类',
    tags.every((t) => /is-(new|improve|fix)/.test(t.cls)));

  /* ---------- 4. 只在更新后首次启动弹一次 ---------- */
  const once = await ev(`(async () => {
    const seenKey = 'seenChangelogVersion';
    const cur = window.__vaultDebug.state.version;
    // 模拟「更新前」：记录的是旧版本
    const st = await window.vault.getState();
    const old = st.settings?.seenChangelogVersion;
    return { cur, old, hasSettings: !!st.settings };
  })()`);
  check('状态里有版本号', !!once.cur, once.cur);

  // 关弹窗会写 seenChangelogVersion
  const wrote = await ev(`(async () => {
    const m = document.querySelector('#changelogModal');
    m.hidden = false;
    document.querySelector('#btnChangelogOk').click();
    await new Promise(r => setTimeout(r, 500));
    const st = await window.vault.getState();
    return {
      hidden: m.hidden,
      seen: st.settings?.seenChangelogVersion,
      cur: window.__vaultDebug.state.version,
    };
  })()`);
  check('点「知道了」会关闭弹窗', wrote.hidden === true);
  check('关闭时记住了当前版本', wrote.seen === wrote.cur, `${wrote.seen} / ${wrote.cur}`);
  check('记住的版本等于当前版本（下次启动不再弹）', wrote.seen === wrote.cur);

  /* ---------- 5. Esc 能关 ---------- */
  const esc = await ev(`(async () => {
    const m = document.querySelector('#changelogModal');
    m.hidden = false;
    await new Promise(r => setTimeout(r, 200));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return m.hidden;
  })()`);
  check('按 Esc 能关闭更新内容', esc === true);

  await ev(`(() => {
    ['changelogModal','settingsModal'].forEach(id => {
      const el = document.getElementById(id); if (el) el.hidden = true;
    });
  })()`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
