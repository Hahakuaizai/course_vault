'use strict';

/**
 * 验证「更新公告只在更新后第一次启动弹一次」的真实启动路径。
 *
 * 前面 verify-changelog-about.js 测的是渲染和按钮，
 * 这个脚本测 boot() 里的 maybeShowChangelog：
 *   1. 假装刚更新（库里的 seenChangelogVersion 是旧版本）→ reload 后弹
 *   2. 看过并关掉（seen 更新成当前版本）→ 再 reload 不弹
 *   3. 同一版本连续启动多次都不弹
 *
 * 用 Page.reload 模拟启动：boot() 会完整重跑一遍，等价于重启应用，
 * 但不用真的重启进程（重启会抢焦点，用户明确禁止）。
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

  const reload = async () => {
    await c.send('Page.enable');
    await c.send('Page.reload', { ignoreCache: true });
    // boot() 里弹窗有 700ms 延迟，等够
    await sleep(3000);
  };

  /* 记下原值，测完还原 */
  const orig = await ev(`(async () => {
    const st = await window.vault.getState();
    return {
      version: st.version,
      seen: st.settings?.seenChangelogVersion ?? null,
    };
  })()`);

  try {
    /* ---------- 1. 假装刚更新 ---------- */
    await ev(`window.vault.settings.set({ seenChangelogVersion: '0.0.1' })`);
    await sleep(300);
    await reload();

    const afterUpdate = await ev(`(async () => {
      const m = document.querySelector('#changelogModal');
      const batches = m.querySelectorAll('.cl-batch');
      return {
        visible: !m.hidden,
        batchCount: batches.length,
        firstIsLatest: !!batches[0]?.querySelector('.cl-latest'),
        itemCount: batches[0]?.querySelectorAll('.cl-item').length || 0,
        ver: window.__vaultDebug.state.version,
      };
    })()`);

    check('刚更新过 → 启动后自动弹公告', afterUpdate.visible === true,
      `当前 ${afterUpdate.ver}`);
    check('自动弹的只显示最新一批（不是全部历史）',
      afterUpdate.batchCount === 1, `${afterUpdate.batchCount} 批`);
    check('自动弹的那批标了「本次更新」', afterUpdate.firstIsLatest === true);
    check('自动弹的有内容', afterUpdate.itemCount > 0, `${afterUpdate.itemCount} 条`);

    /* ---------- 2. 弹出时就已经记账（不点关闭直接退出也不重复弹） ---------- */
    const seenAtPop = await ev(`(async () => {
      const st = await window.vault.getState();
      return st.settings?.seenChangelogVersion;
    })()`);
    check('弹出来的当下就记住了版本（不必等用户点关闭）',
      seenAtPop === afterUpdate.ver, `${seenAtPop} / ${afterUpdate.ver}`);

    /* 模拟「看到公告后直接关软件，没点知道了」：什么都不点，直接重载 */
    await reload();
    const afterKill = await ev(`!document.querySelector('#changelogModal').hidden`);
    check('没点关闭就直接重启 → 不再弹', afterKill === false);

    /* ---------- 3. 正常点关闭 ---------- */
    // 重新造一次「刚更新」的场景
    await ev(`window.vault.settings.set({ seenChangelogVersion: '0.0.1' })`);
    await sleep(300);
    await reload();
    await ev(`document.querySelector('#btnChangelogOk').click()`);
    await sleep(600);
    const seenNow = await ev(`(async () => {
      const st = await window.vault.getState();
      return st.settings?.seenChangelogVersion;
    })()`);
    check('点「知道了」关闭后版本记录仍然正确', seenNow === afterUpdate.ver,
      `${seenNow} / ${afterUpdate.ver}`);

    /* ---------- 3. 再启动 → 不弹 ---------- */
    await reload();
    const secondBoot = await ev(`!document.querySelector('#changelogModal').hidden`);
    check('同一版本再次启动 → 不再弹', secondBoot === false);

    /* ---------- 4. 再启动一次，仍然不弹 ---------- */
    await reload();
    const thirdBoot = await ev(`!document.querySelector('#changelogModal').hidden`);
    check('连续第三次启动 → 仍然不弹', thirdBoot === false);

    /* ---------- 5. 首次安装（没有记录）→ 不弹，只记录 ---------- */
    await ev(`window.vault.settings.set({ seenChangelogVersion: '' })`);
    await sleep(300);
    await reload();
    const firstRun = await ev(`(async () => {
      const st = await window.vault.getState();
      return {
        visible: !document.querySelector('#changelogModal').hidden,
        seen: st.settings?.seenChangelogVersion,
        ver: st.version,
      };
    })()`);
    check('首次安装（无记录）→ 不弹', firstRun.visible === false);
    check('首次安装 → 静默记下当前版本', firstRun.seen === firstRun.ver,
      `${firstRun.seen} / ${firstRun.ver}`);

    /* ---------- 6. 又更新一版 → 再弹 ---------- */
    await ev(`window.vault.settings.set({ seenChangelogVersion: '0.0.2' })`);
    await sleep(300);
    await reload();
    const again = await ev(`!document.querySelector('#changelogModal').hidden`);
    check('下一次更新后又弹', again === true);
    await ev(`document.querySelector('#btnChangelogOk')?.click()`);
    await sleep(500);
  } finally {
    // 还原成测试前的状态，别给用户留下一个「已看过旧版本」的记录
    await ev(`window.vault.settings.set({
      seenChangelogVersion: ${JSON.stringify(orig.seen ?? orig.version)},
    })`).catch(() => {});
    await ev(`(() => {
      ['changelogModal','settingsModal'].forEach(id => {
        const el = document.getElementById(id); if (el) el.hidden = true;
      });
    })()`).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
