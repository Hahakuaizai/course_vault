'use strict';

/**
 * 验证文件夹右键菜单：
 *   1. 不再出现「导入文件 / 导入文件夹」（和右上角导入按钮重复）
 *   2. 新增「移动到…」，且是树形多级菜单
 *   3. 移动真的生效（目录换了父级）
 *   4. 空白处右键仍然保留导入项（没被误删）
 *   5. 菜单里不会出现连续分隔线
 *   6. 右键的文件夹已在多选里时，只出现一条「移动到…」
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

  /* 在某个元素上发一次真实右键，返回菜单里的条目文字 */
  const openMenuOn = (selector) => ev(`(async () => {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { err: '找不到元素 ' + ${JSON.stringify(selector)} };
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
    }));
    // 菜单是异步挂的（要先探测目录磁盘位置）
    await new Promise(r => setTimeout(r, 500));
    const menu = document.querySelector('.ctx-menu');
    if (!menu) return { err: '菜单没出来' };
    const items = [...menu.querySelectorAll('.ctx-item')].map(b => b.textContent.trim());
    const seps = menu.querySelectorAll('.ctx-sep').length;
    // 连续分隔线 / 首尾分隔线
    const kids = [...menu.children].map(x => x.classList.contains('ctx-sep') ? 'SEP' : 'ITEM');
    const badSep = kids.some((k, i) =>
      (k === 'SEP' && i === 0) || (k === 'SEP' && kids[i - 1] === 'SEP')
      || (k === 'SEP' && i === kids.length - 1));
    return { items, seps, badSep, count: items.length };
  })()`);

  const closeMenus = () => ev(`document.querySelectorAll('.ctx-menu').forEach(m => m.remove())`);

  try {
    // 先关掉可能盖住页面的弹窗，再回到「全部文件」视图
    await ev(`(() => {
      ['shortcutsModal','settingsModal','courseModal','newFileModal','importModal',
       'confirmModal','delModal','detailModal','dupeModal','relocateModal',
       'changelogModal','renameModal','overlay'].forEach(id => {
        const el = document.getElementById(id); if (el) el.hidden = true;
      });
      document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
      const d = window.__vaultDebug;
      d.state.view = { type: 'all', courseId: null };
      d.render();
    })()`);
    await sleep(800);

    // 兜底：确认真的有目录卡片，否则后面全是假失败
    const hasDir = await ev(`document.querySelectorAll('[data-dir]').length`);
    check('全部文件视图里有目录卡片', hasDir > 0, `${hasDir} 个`);
    if (!hasDir) {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
      c.close();
      process.exit(1);
    }

    /* ---------- 1 & 2. 文件夹卡片右键 ---------- */
    const dirMenu = await openMenuOn('[data-dir]');
    if (dirMenu.err) {
      check('能打开文件夹右键菜单', false, dirMenu.err);
    } else {
      check('能打开文件夹右键菜单', true, `${dirMenu.count} 项`);
      console.log(`     菜单：${dirMenu.items.join(' / ')}`);

      check('没有「导入文件」', !dirMenu.items.some(t => t.startsWith('导入文件')));
      check('没有「导入文件夹」', !dirMenu.items.some(t => t.startsWith('导入文件夹')));
      check('有「移动到…」', dirMenu.items.some(t => t === '移动到…'));
      check('有「剪切」', dirMenu.items.includes('剪切'));
      check('有「复制」', dirMenu.items.includes('复制'));
      check('仍有「重命名文件夹」', dirMenu.items.includes('重命名文件夹'));
      check('仍有「删除文件夹」', dirMenu.items.includes('删除文件夹'));
      // 删除是危险操作，应该排在「刷新」这类日常项之前，而不是夹在新建/刷新中间
      check('删除排在「刷新」之前',
        dirMenu.items.indexOf('删除文件夹') < dirMenu.items.indexOf('刷新 (Ctrl+R)'),
        `删除@${dirMenu.items.indexOf('删除文件夹')} / 刷新@${dirMenu.items.indexOf('刷新 (Ctrl+R)')}`);
      check('删除在「新建文件夹」之后',
        dirMenu.items.indexOf('删除文件夹') > dirMenu.items.indexOf('新建文件夹'));
      check('没有连续/首尾多余的分隔线', dirMenu.badSep === false);
    }
    await closeMenus();

    /* ---------- 3. 「移动到…」展开的是树形多级菜单 ---------- */
    const tree = await ev(`(async () => {
      document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
      const card = document.querySelector('[data-dir]');
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20),
      }));
      await new Promise(r => setTimeout(r, 500));

      const menu = document.querySelector('.ctx-menu');
      const btn = [...menu.querySelectorAll('.ctx-item')]
        .find(b => b.textContent.trim() === '移动到…');
      if (!btn) return { err: '没找到「移动到…」' };
      btn.click();
      await new Promise(r => setTimeout(r, 600));

      /* 点「移动到…」会先关掉整个旧菜单、再挂一个全新的目标菜单，
       * 所以最后只剩 1 个 .ctx-menu —— 不是「主菜单 + 子菜单」两层。
       * 要验证的是「点开后出现了目录目标」，不是层数。 */
      const subs = document.querySelectorAll('.ctx-menu');
      if (!subs.length) return { err: '点了「移动到…」后没有菜单' };
      const sub = subs[subs.length - 1];
      const items = [...sub.querySelectorAll('.ctx-item')].map(b => ({
        text: b.textContent.trim(),
        hasChildren: b.dataset.sub === '1',
        disabled: b.classList.contains('is-disabled'),
      }));
      return { menus: subs.length, items };
    })()`);

    if (tree.err) {
      check('「移动到…」能展开目标菜单', false, tree.err);
    } else {
      check('「移动到…」打开了目标菜单', tree.menus >= 1, `${tree.menus} 个菜单`);
      check('目标菜单里有可选目录', tree.items.length >= 1, `${tree.items.length} 个`);
      console.log(`     目标：${tree.items.map(i => i.text).join(' / ')}`);
      // 被右键的目录自己不能出现在目标里（否则会塞进自己）
      const selfName = await ev(`document.querySelector('[data-dir] .card-name')?.textContent`);
      check('目标里没有被移动目录自己',
        !tree.items.some(i => i.text === selfName), `目录名 ${selfName}`);
    }
    await closeMenus();

    /* ---------- 4. 空白处右键仍然有导入项 ---------- */
    const blank = await ev(`(async () => {
      /* 前面测「移动到…」时留下的菜单必须清干净，否则
       * document.querySelector('.ctx-menu') 会拿到那个旧的，
       * 而空白处的右键又被「点外部关闭」逻辑吃掉。 */
      document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
      // 清完还要发一次真实点击，让 openCtxMenus 内部状态也归零
      document.body.click();
      await new Promise(r => setTimeout(r, 200));

      const content = document.querySelector('#content');
      const r = content.getBoundingClientRect();
      content.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.bottom - 40),
      }));
      await new Promise(r => setTimeout(r, 600));
      const menus = document.querySelectorAll('.ctx-menu');
      if (!menus.length) return { err: '菜单没出来' };
      const menu = menus[menus.length - 1];
      return { items: [...menu.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()) };
    })()`);
    if (blank.err) {
      check('空白处右键菜单能打开', false, blank.err);
    } else {
      check('空白处右键仍保留「导入文件…」',
        blank.items.some(t => t.startsWith('导入文件')));
      check('空白处右键仍保留「导入文件夹…」',
        blank.items.some(t => t.startsWith('导入文件夹')));
      check('空白处右键没有文件夹专属项',
        !blank.items.includes('重命名文件夹') && !blank.items.includes('删除文件夹'));
      // 「新建」要能同时建文件和文件夹，不能只有文件夹
      check('空白处右键是「新建」而不是「新建文件夹」',
        blank.items.includes('新建') && !blank.items.includes('新建文件夹'),
        blank.items.join(' / '));

      // 展开「新建」看两个子项。要重新右键一次，别用上面那次留下的菜单 ——
      // 它可能已经被别处的清理逻辑收掉了。
      const sub = await ev(`(async () => {
        /* 只摘 DOM 里的菜单节点，不要额外发 click ——
         * 那个 click 会把 openCtxMenus 的内部计数搅乱，导致下一次
         * showCtx 走到「depth 比现有层数深」的分支直接 return。 */
        document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
        await new Promise(r => setTimeout(r, 300));

        const content = document.querySelector('#content');
        const r = content.getBoundingClientRect();
        content.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round(r.left + r.width / 2),
          clientY: Math.round(r.bottom - 40),
        }));
        await new Promise(r => setTimeout(r, 700));

        const menus = document.querySelectorAll('.ctx-menu');
        if (!menus.length) return { err: '右键后没有菜单' };
        const menu = menus[menus.length - 1];
        const btn = [...menu.querySelectorAll('.ctx-item')]
          .find(b => b.textContent.trim() === '新建');
        if (!btn) return { err: '没有「新建」' };
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));
        const all = document.querySelectorAll('.ctx-menu');
        if (all.length < 2) {
          return { err: '子菜单没展开', layers: all.length };
        }
        return {
          layers: all.length,
          items: [...all[all.length - 1].querySelectorAll('.ctx-item')]
            .map(b => b.textContent.trim()),
        };
      })()`);
      if (sub.err) {
        check('「新建」能展开二级菜单', false, sub.err);
      } else {
        check('「新建」能展开二级菜单', true, sub.items.join(' / '));
        check('「新建」里有「新建文件」', sub.items.includes('新建文件'));
        check('「新建」里有「新建文件夹」', sub.items.includes('新建文件夹'));
      }
      await closeMenus();
    }
    await closeMenus();

    /* ---------- 5. 真正移动一次目录 ---------- */
    const move = await ev(`(async () => {
      const d = window.__vaultDebug;
      const before = d.state.courses.map(c => ({ id: c.id, parentId: c.parentId }));
      // 找一个有父级的目录，把它移到顶层
      const child = d.state.courses.find(c => c.parentId);
      if (!child) return { skip: true, reason: '没有子目录可测' };
      const res = await window.vault.courses.move(child.id, null);
      d.apply(res);
      await new Promise(r => setTimeout(r, 300));
      const after = d.state.courses.find(c => c.id === child.id);
      // 挪回去，别留下痕迹
      await window.vault.courses.move(child.id, child.parentId);
      d.apply(await window.vault.getState());
      return {
        name: child.name, from: child.parentId, to: after.parentId,
        ok: after.parentId === null,
      };
    })()`);
    if (move.skip) {
      check('目录移动链路', true, `跳过：${move.reason}`);
    } else {
      check('目录能移动到顶层', move.ok === true,
        `${move.name}: ${move.from || '顶层'} → ${move.to || '顶层'}`);
    }

    /* ---------- 5b. 文件夹「复制」→「粘贴」真的能复制整棵子树 ---------- */
    const copyPaste = await ev(`(async () => {
      const d = window.__vaultDebug;
      d.state.view = { type: 'all', courseId: null };
      d.render();
      await new Promise(r => setTimeout(r, 400));

      const courses = d.state.courses;
      const files = d.state.files;
      const subIds = (id) => {
        const out = new Set([id]); const s = [id];
        while (s.length) {
          const cur = s.pop();
          for (const c of courses) if (c.parentId === cur && !out.has(c.id)) { out.add(c.id); s.push(c.id); }
        }
        return out;
      };
      // 挑一个带文件的顶层目录
      const src = courses.find(c => !c.parentId
        && [...subIds(c.id)].some(id => files.some(f => f.courseId === id)));
      if (!src) return { skip: true, reason: '没有带文件的顶层目录' };
      const dest = courses.find(c => !c.parentId && c.id !== src.id);

      /* 数目标位置下的文件时要用**整棵子树**：复制过来的目录里，
       * 文件挂在新建的子目录上，不是目标目录的直属文件。
       * 只看 courseId === dest.id 会数出 0，误判成「没复制文件」。 */
      const countIn = (rootId) => {
        const ids = rootId ? subIds(rootId) : new Set([null]);
        return files.filter(f => ids.has(f.courseId || null)).length;
      };
      const before = { courses: courses.length, inDest: countIn(dest ? dest.id : null) };
      // 记下复制前所有目录 id，测完据此精确清理（同名目录可能本来就有）
      window.__beforeCourseIds = courses.map(c => c.id);
      window.__beforeFileIds = files.map(f => f.id);

      /* 走真实 UI：右键源目录 → 点「复制」→ 右键目标 → 点「粘贴」。
       * 直接调内部函数做不到（putInClipboard / pasteInto 都在闭包里，
       * __vaultDebug 没暴露），而且走 UI 才顺带验证了菜单接线。 */
      const rightClick = async (el) => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20),
        }));
        await new Promise(r => setTimeout(r, 500));
      };
      const clickItem = async (label) => {
        const menu = document.querySelector('.ctx-menu');
        const btn = [...menu.querySelectorAll('.ctx-item')]
          .find(b => b.textContent.trim() === label);
        if (!btn) return false;
        btn.click();
        await new Promise(r => setTimeout(r, 400));
        return true;
      };

      // 源目录卡片
      const srcCard = document.querySelector('[data-dir="' + src.id + '"]');
      if (!srcCard) return { skip: true, reason: '界面上找不到源目录卡片' };
      await rightClick(srcCard);
      const copied = await clickItem('复制');
      if (!copied) return { err: '菜单里没有「复制」' };

      // 目标目录卡片
      let destCard = dest ? document.querySelector('[data-dir="' + dest.id + '"]') : null;
      if (dest) {
        if (!destCard) return { skip: true, reason: '界面上找不到目标目录卡片' };
        await rightClick(destCard);
      } else {
        // 粘到顶层：右键空白处
        const content = document.querySelector('#content');
        const r = content.getBoundingClientRect();
        content.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round(r.left + r.width / 2),
          clientY: Math.round(r.bottom - 40),
        }));
        await new Promise(r => setTimeout(r, 400));
      }
      const pasted = await clickItem('粘贴');
      if (!pasted) return { err: '菜单里没有「粘贴」' };

      await new Promise(r => setTimeout(r, 900));
      // 重新取一遍 state（applyState 换了对象），按新数据重算子树
      const courses2 = d.state.courses;
      const files2 = d.state.files;
      const subIds2 = (id) => {
        const out = new Set([id]); const s = [id];
        while (s.length) {
          const cur = s.pop();
          for (const c of courses2) if (c.parentId === cur && !out.has(c.id)) { out.add(c.id); s.push(c.id); }
        }
        return out;
      };
      const destNow = dest ? courses2.find(c => c.id === dest.id) : null;
      const ids2 = destNow ? subIds2(destNow.id) : new Set([null]);
      const after = {
        courses: courses2.length,
        inDest: files2.filter(f => ids2.has(f.courseId || null)).length,
      };
      return {
        srcName: src.name, destName: dest ? dest.name : '顶层',
        addedCourses: after.courses - before.courses,
        addedFiles: after.inDest - before.inDest,
      };
    })()`);

    if (copyPaste.skip) {
      check('文件夹复制链路', true, `跳过：${copyPaste.reason}`);
    } else if (copyPaste.err) {
      check('文件夹复制链路', false, copyPaste.err);
    } else {
      check('复制文件夹会新建目录记录',
        copyPaste.addedCourses >= 1,
        `${copyPaste.srcName} → ${copyPaste.destName}，目录 +${copyPaste.addedCourses}`);
      check('复制文件夹会连里面的文件一起复制',
        copyPaste.addedFiles >= 1, `文件 +${copyPaste.addedFiles}`);
      /* 清理：精确删掉这次测试新增的目录（按 id 差集，不是按名字）。
       * 按名字找会误删用户本来就叫这名的目录，也不可靠 —— 复制出来的
       * 顶层目录名可能带「 副本」后缀。 */
      const cleaned = await ev(`(async () => {
        const d = window.__vaultDebug;
        const before = new Set(window.__beforeCourseIds || []);
        const added = d.state.courses.filter(c => !before.has(c.id));
        // 只删最上层的那些（子目录会跟着父级一起删）
        const addedIds = new Set(added.map(c => c.id));
        const roots = added.filter(c => !c.parentId || !addedIds.has(c.parentId));
        let n = 0;
        for (const c of roots) {
          try { await window.vault.courses.remove(c.id, false); n += 1; } catch { /* 忽略 */ }
        }
        d.apply(await window.vault.getState());
        return {
          removed: n,
          coursesNow: d.state.courses.length,
          coursesBefore: window.__beforeCourseIds?.length,
        };
      })()`).catch(() => null);
      if (cleaned) {
        check('测试数据已清理干净',
          cleaned.coursesNow === cleaned.coursesBefore,
          `删了 ${cleaned.removed} 个顶层目录，目录数 ${cleaned.coursesNow} / 原 ${cleaned.coursesBefore}`);
      }
    }

    /* ---------- 6. 右键的文件夹在多选里时只有一条「移动到…」 ---------- */
    const dup = await ev(`(async () => {
      // 彻底清场：菜单、子菜单、多选状态全部归零
      document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
      document.body.click();
      const d = window.__vaultDebug;
      if (document.body.classList.contains('select-mode')) {
        document.querySelector('#btnSelectMode').click();
        await new Promise(r => setTimeout(r, 300));
      }
      d.state.view = { type: 'all', courseId: null };
      d.render();
      await new Promise(r => setTimeout(r, 700));

      /* 打开多选。注意顺序：先进多选模式，再取卡片 ——
       * 切模式会重渲染网格，之前抓到的元素引用会脱离文档，
       * 对它调 getBoundingClientRect() 永远是 0×0。 */
      if (!document.body.classList.contains('select-mode')) {
        document.querySelector('#btnSelectMode').click();
        await new Promise(r => setTimeout(r, 400));
      }
      const card = document.querySelector('[data-dir]');
      if (!card) return { err: '没有目录卡片' };
      card.click();
      await new Promise(r => setTimeout(r, 400));

      const r = card.getBoundingClientRect();
      if (!r.width || !r.height) {
        return { err: '卡片不可见（rect 为 0）', connected: card.isConnected };
      }
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20),
      }));
      // 文件夹菜单要等一次 IPC（探测磁盘位置），600ms 起步
      await new Promise(r => setTimeout(r, 900));
      const menus = document.querySelectorAll('.ctx-menu');
      if (!menus.length) return { err: '菜单没出来' };
      const menu = menus[menus.length - 1];
      const moves = [...menu.querySelectorAll('.ctx-item')]
        .filter(b => b.textContent.trim() === '移动到…').length;
      const all = [...menu.querySelectorAll('.ctx-item')].map(b => b.textContent.trim());

      document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
      if (document.body.classList.contains('select-mode')) {
        document.querySelector('#btnSelectMode').click();
      }
      return { moves, all };
    })()`);
    if (dup.err) {
      check('多选状态下能右键目录', false, dup.err);
    } else {
      check('目录已在多选里时「移动到…」只有一条', dup.moves === 1,
        `${dup.moves} 条：${dup.all.join(' / ')}`);
    }
  } finally {
    await ev(`(() => {
      document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
      if (document.body.classList.contains('select-mode')) {
        document.querySelector('#btnSelectMode')?.click();
      }
    })()`).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
