'use strict';

/**
 * 验证「打开方式」的二级菜单。
 *
 * 需求：打开项目里的文件时，编辑器那一项要能展开二级菜单，
 * 让用户自己挑「打开整个项目」还是「单独打开这个文件」。
 *
 * 断言：
 *   1. 项目文件的编辑器条目带子菜单（data-sub + 箭头）
 *   2. 子菜单正好两项：打开整个项目 / 单独打开这个文件
 *   3. 旧文案「（打开整个项目）」后缀不再出现（改由子菜单表达）
 *   4. 不在项目里的文件、普通程序（记事本）没有子菜单
 *
 * 不点任何「打开」项 —— 那会真的拉起编辑器、抢焦点。
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

  /** 打开某个文件的预览并点开「打开方式」，返回根菜单的条目 */
  const openWithMenu = async (id) => {
    await ev(`(async () => {
      await window.__vaultDebug.openPreview(${JSON.stringify(id)});
    })()`);
    await sleep(700);
    await ev(`document.querySelector('#btnRun').click()`);
    // 要等注册表 / 编辑器列表的 IPC，600ms 起步
    await sleep(1400);
    return ev(`(() => {
      const root = document.querySelector('.ctx-menu');
      if (!root) return { none: true };
      return {
        items: [...root.querySelectorAll('.ctx-item')].map((b) => ({
          text: b.textContent.trim(),
          sub: b.dataset.sub === '1',
          arrow: !!b.querySelector('.ctx-arrow'),
        })),
      };
    })()`);
  };

  try {
    /* ---------- 1. 找一个在项目里的文件 ---------- */
    const proj = await ev(`(async () => {
      const st = await window.vault.getState();
      const cands = st.files.filter(
        (f) => ['.py', '.js', '.md', '.txt', '.json', '.css', '.html'].includes(f.ext),
      );
      for (const f of cands) {
        let p = null;
        try { p = await window.vault.files.project(f.id); } catch { /* 读不到就跳过 */ }
        if (p && !p.isRoot) return { id: f.id, name: f.name, root: p.root || p.dir || null };
      }
      return { none: true, checked: cands.length };
    })()`);

    if (proj.none) {
      check('库里找到「位于项目中」的文件', false, `检查了 ${proj.checked} 个候选`);
      throw new Error('没有可用于测试的项目文件');
    }
    check('库里找到「位于项目中」的文件', true, `${proj.name}`);

    const menu = await openWithMenu(proj.id);
    if (menu.none) {
      check('文件右键 / 打开方式菜单能弹出', false);
      throw new Error('菜单没出来');
    }
    check('菜单能弹出', menu.items.length > 0, `${menu.items.length} 项`);

    const subbed = menu.items.filter((it) => it.sub);
    check('项目文件的编辑器条目带二级菜单', subbed.length > 0,
      subbed.map((s) => s.text).join(' / ') || '没有');
    check('带子菜单的条目右边有箭头', subbed.every((s) => s.arrow));

    const oldSuffix = menu.items.filter((it) => it.text.includes('（打开整个项目）'));
    check('不再用「（打开整个项目）」后缀标在名字上', oldSuffix.length === 0,
      oldSuffix.map((s) => s.text).join(' / ') || '干净');

    // 展开第一个带子菜单的条目
    const sub = await ev(`(async () => {
      const root = document.querySelector('.ctx-menu');
      const btn = [...root.querySelectorAll('.ctx-item')].find((b) => b.dataset.sub === '1');
      if (!btn) return { none: true };
      btn.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: btn.getBoundingClientRect().left + 20,
        clientY: btn.getBoundingClientRect().top + 8,
      }));
      await new Promise((r) => setTimeout(r, 500));
      const menus = [...document.querySelectorAll('.ctx-menu')];
      const sub = menus[1];
      return {
        menuCount: menus.length,
        items: sub ? [...sub.querySelectorAll('.ctx-item')].map((b) => b.textContent.trim()) : [],
        anchoredRight: sub
          ? (sub.getBoundingClientRect().left >= menus[0].getBoundingClientRect().right - 6
             || sub.getBoundingClientRect().right <= menus[0].getBoundingClientRect().left + 6)
          : false,
        subRect: sub ? { l: Math.round(sub.getBoundingClientRect().left), t: Math.round(sub.getBoundingClientRect().top) } : null,
      };
    })()`);

    check('悬停编辑器条目会展开子菜单', sub.menuCount >= 2, `${sub.menuCount} 层`);
    check('子菜单里有「打开整个项目」', sub.items.includes('打开整个项目'),
      sub.items.join(' / ') || '空');
    check('子菜单里有「单独打开这个文件」', sub.items.includes('单独打开这个文件'));
    check('子菜单正好两项', sub.items.length === 2, `${sub.items.length} 项`);
    check('子菜单贴着父菜单、且不重叠', sub.anchoredRight === true,
      JSON.stringify(sub.subRect));

    /* ---------- 2. 文件正好在项目根这一层 ---------- *
     * 这是最容易踩的情况：项目根就是一个目录（edu-warning/），
     * 里面每个文件 isRoot = true。以前这里被排除掉，导致「项目里的
     * 文件全都没有二级菜单」。 */
    await ev(`(() => {
      document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
      document.querySelector('#overlay').hidden = true;
    })()`);
    const rootFile = await ev(`(async () => {
      const st = await window.vault.getState();
      for (const f of st.files) {
        if (!['.py', '.js', '.md', '.json', '.txt'].includes(f.ext)) continue;
        let p = null;
        try { p = await window.vault.files.project(f.id); } catch { /* 忽略 */ }
        if (p && p.isRoot) return { id: f.id, name: f.name, root: p.root };
      }
      return { none: true };
    })()`);

    if (rootFile.none) {
      check('找到一个「就在项目根」的文件', false, '库里没有这种文件');
    } else {
      const menu2 = await openWithMenu(rootFile.id);
      const subbed2 = (menu2.items || []).filter((it) => it.sub);
      check('文件就在项目根时也有二级菜单', subbed2.length > 0,
        `${rootFile.name}：${subbed2.map((s) => s.text).join(' / ') || '无'}`);
      check('项目根的文件：二级菜单带「打开整个项目」', subbed2.length > 0);
    }

    /* ---------- 3. 项目里的文件夹（子目录） ---------- */
    await ev(`(() => {
      document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
      document.querySelector('#overlay').hidden = true;
    })()`);
    const dirTarget = await ev(`(async () => {
      const st = await window.vault.getState();
      for (const d of st.courses) {
        let p = null;
        try { p = await window.vault.courses.project(d.id); } catch { /* 忽略 */ }
        if (!p) continue;
        // 得能在父目录视图里看到卡片；最上层目录进「全部文件」也能看到
        return {
          id: d.id, name: d.name, parentId: d.parentId, root: p.root,
          hasParent: !!d.parentId,
        };
      }
      return { none: true };
    })()`);

    if (dirTarget.none) {
      check('找到一个「在项目里」的文件夹', false, '库里没有这种目录');
    } else {
      const dirMenu = await ev(`(async () => {
        const d = window.__vaultDebug;
        d.state.view = ${JSON.stringify(dirTarget.parentId)
    ? `{ type: 'course', courseId: ${JSON.stringify(dirTarget.parentId)} }`
    : `{ type: 'all', courseId: null }`};
        d.render();
        await new Promise((r) => setTimeout(r, 600));
        document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
        const card = document.querySelector('[data-dir="${dirTarget.id}"]');
        if (!card) return { err: '目录卡片没出现' };
        const r = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 30),
        }));
        await new Promise((x) => setTimeout(x, 900));
        const root = document.querySelector('.ctx-menu');
        const btn = [...(root?.querySelectorAll('.ctx-item') || [])]
          .find((b) => b.textContent.includes('用其他软件打开'));
        if (!btn) return { err: '没有「用其他软件打开」' };
        btn.click();
        // 这一步要探测磁盘位置再弹新菜单，得等
        let subBtn = null;
        for (let i = 0; i < 25; i += 1) {
          await new Promise((x) => setTimeout(x, 120));
          const m = document.querySelector('.ctx-menu');
          subBtn = [...(m?.querySelectorAll('.ctx-item') || [])]
            .find((b) => b.dataset.sub === '1');
          if (subBtn) break;
        }
        if (!subBtn) return { err: '打开方式里没有二级菜单' };
        subBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise((x) => setTimeout(x, 500));
        const menus = document.querySelectorAll('.ctx-menu');
        return {
          ok: true,
          sub: menus[1] ? [...menus[1].querySelectorAll('.ctx-item')].map((b) => b.textContent.trim()) : [],
        };
      })()`);

      if (dirMenu.err) {
        check('项目里的文件夹有二级菜单', false, `${dirTarget.name}：${dirMenu.err}`);
      } else {
        check('项目里的文件夹有二级菜单', dirMenu.ok === true, dirTarget.name);
        check('文件夹的子菜单措辞是「只打开这个文件夹」',
          dirMenu.sub.includes('只打开这个文件夹'), dirMenu.sub.join(' / ') || '空');
        check('文件夹的子菜单也有「打开整个项目」',
          dirMenu.sub.includes('打开整个项目'));
      }
    }

    /* ---------- 4. 重新加载清场，测不在项目里的文件 ---------- */
    await c.send('Page.enable');
    await c.send('Page.reload', { ignoreCache: true });
    await sleep(3000);

    const lone = await ev(`(async () => {
      const st = await window.vault.getState();
      for (const f of st.files) {
        let p = null;
        try { p = await window.vault.files.project(f.id); } catch { /* 忽略 */ }
        if (!p) return { id: f.id, name: f.name };
      }
      return { none: true };
    })()`);

    if (lone.none) {
      check('找到一个「不在项目里」的文件', false, '库里全是项目文件');
    } else {
      const menu2 = await openWithMenu(lone.id);
      const subbed2 = (menu2.items || []).filter((it) => it.sub);
      check('不在项目里的文件 → 没有二级菜单', subbed2.length === 0,
        `${lone.name}：${subbed2.map((s) => s.text).join(',') || '无子菜单'}`);
      // 记事本这类非编辑器程序本来就不该有子菜单
      const notepad = (menu2.items || []).find((it) => it.text.startsWith('记事本'));
      check('记事本这类普通程序没有子菜单',
        !notepad || notepad.sub === false, notepad ? notepad.text : '（没列出记事本）');
    }
  } finally {
    await ev(`(() => {
      document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
      ['overlay', 'settingsModal', 'confirmModal', 'dupeModal'].forEach((id) => {
        const el = document.getElementById(id); if (el) el.hidden = true;
      });
    })()`).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
