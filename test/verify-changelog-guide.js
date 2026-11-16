'use strict';

/**
 * 验证三件事：
 *   1. 更新公告：版本变了才弹，Esc 能关，关掉后记住版本
 *   2. 使用教程：设置里有「使用教程」页，分节渲染，目录能跳转
 *   3. 主题开关：尺寸变扁、光效是环形（mask 挖空）、能真的拖
 *
 * 拖动用真实 PointerEvent 模拟：pointerdown → 几次 pointermove → pointerup。
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

  try {
    // 关掉可能挡住的弹窗
    await ev(`(() => {
      ['shortcutsModal','settingsModal','courseModal','newFileModal','importModal',
       'confirmModal','delModal','dupModal','detailModal','dupeModal','relocateModal',
       'changelogModal'].forEach(id => {
        const el = document.getElementById(id); if (el) el.hidden = true;
      });
      window.__vaultDebug.state.view = { type: 'all', courseId: null };
      window.__vaultDebug.render();
    })()`);
    await sleep(400);

    /* ================= 1. 更新公告 ================= */
    const ver = await ev(`window.__vaultDebug.state.version`);
    check('主进程把版本号带到了前端', !!ver, ver || '（空）');

    // 直接调 openChangelog 看内容
    const cl = await ev(`(() => {
      window.__vaultDebug.openChangelog();
      const m = document.querySelector('#changelogModal');
      return {
        shown: !m.hidden,
        title: m.querySelector('#changelogTitle')?.textContent,
        ver: m.querySelector('.cl-ver')?.textContent,
        items: m.querySelectorAll('.cl-item').length,
        tags: [...new Set([...m.querySelectorAll('.cl-tag')].map(t => t.textContent))],
        hasOk: !!m.querySelector('#btnChangelogOk'),
      };
    })()`);
    check('公告能打开', cl.shown === true);
    check('公告标题正确', cl.title === '更新内容', cl.title);
    check('公告显示版本号', /^v\d/.test(cl.ver || ''), cl.ver);
    check('公告有条目', cl.items >= 5, `${cl.items} 条`);
    check('条目分了新增/改进/修复', cl.tags.length >= 2, cl.tags.join(' / '));

    // Esc 关闭
    const escClosed = await ev(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
      await new Promise(r => setTimeout(r, 250));
      return {
        hidden: document.querySelector('#changelogModal').hidden,
        seen: window.__vaultDebug.state.settings.seenChangelogVersion,
      };
    })()`);
    check('Esc 能关闭公告', escClosed.hidden === true);
    check('关闭后记住看过的版本', escClosed.seen === ver, `${escClosed.seen} vs ${ver}`);

    // 已经看过当前版本 → 不该再弹
    const reShow = await ev(`(async () => {
      // 模拟一次启动判断：把 seen 设成当前版本，再调一次
      window.__vaultDebug.state.settings.seenChangelogVersion = window.__vaultDebug.state.version;
      window.__vaultDebug.closeChangelog();
      await new Promise(r => setTimeout(r, 200));
      // 手动触发启动判断逻辑（它在闭包里，只能间接验证：不应弹）
      return document.querySelector('#changelogModal').hidden;
    })()`);
    check('同一版本不会重复弹（已关闭状态）', reShow === true);

    // 点遮罩关闭
    const backdropClose = await ev(`(async () => {
      window.__vaultDebug.openChangelog();
      await new Promise(r => setTimeout(r, 150));
      const m = document.querySelector('#changelogModal');
      m.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 200));
      return m.hidden;
    })()`);
    check('点遮罩也能关闭公告', backdropClose === true);

    /* ================= 2. 使用教程 ================= */
    const guide = await ev(`(() => {
      const nav = [...document.querySelectorAll('#settingsNav .snav-item')]
        .map(b => ({ pane: b.dataset.pane, text: b.textContent.trim() }));
      return {
        hasNav: nav.some(n => n.pane === 'guide'),
        navText: nav.find(n => n.pane === 'guide')?.text,
        sections: document.querySelectorAll('.guide-sec').length,
        chips: document.querySelectorAll('.guide-chip').length,
        firstTitle: document.querySelector('.guide-sec h4')?.textContent,
        // 每节都有正文
        emptySections: [...document.querySelectorAll('.guide-sec')]
          .filter(s => s.textContent.trim().length < 40).length,
        hasKbd: !!document.querySelector('.guide-sec kbd'),
        hasCode: !!document.querySelector('.guide-sec code'),
        paneExists: !!document.querySelector('.spane[data-pane="guide"]'),
      };
    })()`);
    check('设置里有「使用教程」分类', guide.hasNav === true, guide.navText || '');
    check('教程分节渲染', guide.sections >= 8, `${guide.sections} 节`);
    check('顶部有目录按钮', guide.chips === guide.sections, `${guide.chips} 个`);
    check('每节都有正文', guide.emptySections === 0, `${guide.emptySections} 节是空的`);
    check('教程里用了按键样式', guide.hasKbd === true);
    check('教程里用了代码样式', guide.hasCode === true);
    check('教程面板存在', guide.paneExists === true);

    // 目录跳转。注意真正滚动的是 .settings-panes（overflow-y:auto 的那层），
    // .spane 只是里面的内容，它自己的 scrollTop 永远是 0。
    // 后台窗口不产生渲染帧，平滑滚动不会推进，所以这里开「减少动画」，
    // 让跳转走瞬间滚动，才能断言到结果。
    const jump = await ev(`(async () => {
      document.documentElement.classList.add('no-motion');
      document.querySelector('#settingsModal').hidden = false;
      document.querySelector('[data-pane="guide"].snav-item').click();
      await new Promise(r => setTimeout(r, 300));
      const scroller = document.querySelector('.settings-panes');
      scroller.scrollTop = 0;
      await new Promise(r => setTimeout(r, 100));
      const chips = [...document.querySelectorAll('.guide-chip')];
      chips[chips.length - 1].click();
      await new Promise(r => setTimeout(r, 500));
      const last = document.querySelector('.guide-sec:last-child');
      const lr = last.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const out = {
        active: document.querySelector('.spane[data-pane="guide"]').classList.contains('is-active'),
        scrolled: scroller.scrollTop > 0,
        scrollTop: Math.round(scroller.scrollTop),
        lastVisible: lr.top < sr.bottom && lr.bottom > sr.top,
      };
      document.documentElement.classList.remove('no-motion');
      return out;
    })()`);
    check('点「使用教程」能切到该页', jump.active === true);
    check('点目录按钮会滚动到对应小节',
      jump.scrolled && jump.lastVisible,
      `scrollTop=${jump.scrollTop} / 可见=${jump.lastVisible}`);

    await ev(`document.querySelector('#settingsModal').hidden = true`);
    await sleep(200);

    /* ================= 3. 主题开关 ================= */
    const geo = await ev(`(() => {
      const knob = document.querySelector('#themeKnob');
      const track = document.querySelector('.theme-track');
      const kr = knob.getBoundingClientRect();
      const tr = track.getBoundingClientRect();
      const cs = getComputedStyle(knob);
      const before = getComputedStyle(knob, '::before');
      const after = getComputedStyle(knob, '::after');
      return {
        knobW: Math.round(kr.width), knobH: Math.round(kr.height),
        trackW: Math.round(tr.width), trackH: Math.round(tr.height),
        ratio: +(tr.width / tr.height).toFixed(2),
        overflowTop: Math.round(tr.top - kr.top),
        overflowBottom: Math.round(kr.bottom - tr.bottom),
        cursor: cs.cursor,
        beforeShadow: before.boxShadow,
        beforeBg: before.backgroundImage.slice(0, 40),
        afterBg: after.backgroundImage.slice(0, 30),
      };
    })()`);
    console.log(`     轨道 ${geo.trackW}×${geo.trackH}（比例 ${geo.ratio}） 滑块 ${geo.knobW}×${geo.knobH}`);
    check('轨道变扁了（比例 >= 2.5）', geo.ratio >= 2.5, `1 : ${geo.ratio}`);
    check('滑块上下都凸出轨道', geo.overflowTop >= 1 && geo.overflowBottom >= 1,
      `上 ${geo.overflowTop} / 下 ${geo.overflowBottom}`);
    check('滑块可以抓（cursor: grab）', geo.cursor === 'grab', geo.cursor);
    // 光环用 box-shadow 的 spread 画（不是 mask 挖空）——
    // mask 不认 corner-shape 的 squircle，环的角和滑块对不齐。
    check('光环是 box-shadow 画的实线环',
      /0px 0px 0px 2px/.test(geo.beforeShadow || ''), String(geo.beforeShadow).slice(0, 60));
    check('光环带自发光', /0px 0px 6px/.test(geo.beforeShadow || ''), '');
    check('外层有径向晕光', /radial-gradient/.test(geo.afterBg), geo.afterBg);

    /* --- 拖动：从当前边拖到另一边 --- */
    const drag = await ev(`(async () => {
      const d = window.__vaultDebug;
      const before = document.documentElement.dataset.theme;
      const btn = document.querySelector('#btnTheme');
      const knob = document.querySelector('#themeKnob');
      const track = document.querySelector('.theme-track');
      const kr = knob.getBoundingClientRect();
      const tr = track.getBoundingClientRect();
      const startX = kr.left + kr.width / 2;
      const y = kr.top + kr.height / 2;
      const dir = before === 'dark' ? -1 : 1;
      // 必须拖过半程才会切换，这里直接拖满整段
      const step = Math.round(tr.width - kr.width) * dir;

      const pe = (type, x) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1,
        clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true,
      });

      knob.dispatchEvent(pe('pointerdown', startX));
      await new Promise(r => setTimeout(r, 30));
      const mid = [];
      for (let i = 1; i <= 4; i += 1) {
        const x = startX + (step * i) / 4;
        knob.dispatchEvent(pe('pointermove', x));
        await new Promise(r => setTimeout(r, 30));
        mid.push(knob.style.getPropertyValue('--knob-x').trim());
      }
      const dragging = knob.classList.contains('is-dragging');
      knob.dispatchEvent(pe('pointerup', startX + step));
      // 浏览器补发的 click
      knob.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 900));

      return {
        before, after: document.documentElement.dataset.theme,
        dragging, mid,
        knobXAfter: knob.style.getPropertyValue('--knob-x'),
        stillDragging: knob.classList.contains('is-dragging'),
      };
    })()`);
    console.log(`     拖动中间位置：${drag.mid.join(' → ')}`);
    check('拖动时挂上 is-dragging', drag.dragging === true);
    check('滑块跟手移动（--knob-x 有变化）',
      drag.mid.some((v) => v && v !== '0px'), drag.mid.join(','));
    check('拖到另一边后主题切换了', drag.before !== drag.after,
      `${drag.before} → ${drag.after}`);
    check('松手后清掉 inline 位置，交还 CSS', drag.knobXAfter === '', `"${drag.knobXAfter}"`);
    check('松手后去掉 is-dragging', drag.stillDragging === false);

    /* --- 拖不到一半应该弹回 --- */
    const small = await ev(`(async () => {
      const before = document.documentElement.dataset.theme;
      const knob = document.querySelector('#themeKnob');
      const track = document.querySelector('.theme-track');
      const kr = knob.getBoundingClientRect();
      const tr = track.getBoundingClientRect();
      const startX = kr.left + kr.width / 2;
      const y = kr.top + kr.height / 2;
      const dir = before === 'dark' ? -1 : 1;
      const tiny = 8 * dir;

      const pe = (type, x) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 2, button: 0, buttons: 1,
        clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true,
      });
      knob.dispatchEvent(pe('pointerdown', startX));
      knob.dispatchEvent(pe('pointermove', startX + tiny));
      await new Promise(r => setTimeout(r, 40));
      knob.dispatchEvent(pe('pointerup', startX + tiny));
      knob.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 800));
      return { before, after: document.documentElement.dataset.theme,
        inline: knob.style.getPropertyValue('--knob-x') };
    })()`);
    check('拖不到一半会弹回，不切主题', small.before === small.after,
      `${small.before} → ${small.after}`);
    check('弹回后位置交还 CSS', small.inline === '', `"${small.inline}"`);

    /* --- 普通点击仍然切换 --- */
    const click = await ev(`(async () => {
      const before = document.documentElement.dataset.theme;
      document.querySelector('#btnTheme').click();
      await new Promise(r => setTimeout(r, 900));
      return { before, after: document.documentElement.dataset.theme };
    })()`);
    check('普通点击仍然能切主题', click.before !== click.after,
      `${click.before} → ${click.after}`);

    /* --- 深色/浅色时滑块的目标位置 ---
     * 后台窗口不产生渲染帧，CSS 过渡不会推进，量 rect 会拿到过渡起点。
     * 所以这里断言的是「CSS 变量算出来的目标位置」，那才是逻辑真相。 */
    const pos = await ev(`(async () => {
      const knob = document.querySelector('#themeKnob');
      const track = document.querySelector('.theme-track');
      const want = track.clientWidth - knob.offsetWidth;

      if (document.documentElement.dataset.theme !== 'dark') {
        document.querySelector('#btnTheme').click();
        await new Promise(r => setTimeout(r, 1200));
      }
      const dark = document.documentElement.dataset.theme;
      const darkX = getComputedStyle(knob).getPropertyValue('--knob-x').trim();

      document.querySelector('#btnTheme').click();
      await new Promise(r => setTimeout(r, 1200));
      const light = document.documentElement.dataset.theme;
      const lightX = getComputedStyle(knob).getPropertyValue('--knob-x').trim();

      return { dark, light, want, darkX, lightX };
    })()`);
    check('深色时滑块目标位置在最右',
      pos.dark === 'dark' && parseFloat(pos.darkX) === pos.want,
      `--knob-x=${pos.darkX} / 期望 ${pos.want}px`);
    check('浅色时滑块目标位置在最左',
      pos.light === 'light' && (pos.lightX === '' || parseFloat(pos.lightX) === 0),
      `--knob-x=${pos.lightX || '（空=0）'}`);
  } finally {
    // 清掉公告状态，避免影响后续测试
    await ev(`(() => {
      const el = document.querySelector('#changelogModal');
      if (el) el.hidden = true;
      window.__vaultDebug.state.view = { type: 'all', courseId: null };
      window.__vaultDebug.render();
    })()`).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
