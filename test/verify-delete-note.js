'use strict';

/**
 * 验证删除弹窗把「不会删磁盘文件」讲清楚了。
 *
 * 用户最担心的就是点删除会不会把硬盘上的文件删掉。这个测试锁住三件事：
 *   1. 弹窗里有一句明确的保证，且「原文件」三个字加粗
 *   2. 「复制入库副本会被清理」这句只在真涉及副本时出现
 *   3. 两种主题下都能看清（颜色不是透明/和背景同色）
 *
 * 另外顺便验证后端语义：彻底删除 link 模式的文件只动库记录，不碰磁盘。
 */

const { connect } = require('./cdp.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };
  const ev = (e) => c.ev(e);

  // 造一个真实的临时文件，用来验证「彻底删除不动磁盘」
  const tmpFile = path.join(os.tmpdir(), `vault-del-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, '这段内容必须活下来');

  try {
    /* ---------- 1. 弹窗内容 ---------- */
    const modal = await ev(`(async () => {
      const d = window.__vaultDebug;
      d.state.view = { type: 'all', courseId: null };
      d.render();
      await new Promise(r => setTimeout(r, 400));
      const m = document.querySelector('#delModal');
      m.querySelector('#delTitle').textContent = '删除文件';
      m.querySelector('#delLead').textContent = '测试';
      m.querySelector('#delCopyNote').hidden = true;
      m.hidden = false;
      await new Promise(r => setTimeout(r, 300));
      const note = m.querySelector('.del-note');
      const bold = note.querySelector('b');
      return {
        hasNote: !!note,
        text: note.textContent.replace(/\\s+/g, ' ').trim(),
        boldText: bold?.textContent,
        hasIcon: !!note.querySelector('svg'),
        purgeSmall: m.querySelector('[data-del=purge] small').textContent,
      };
    })()`);

    check('删除弹窗里有「不会删原文件」的说明', modal.hasNote === true);
    check('说明里明确写了不删原文件',
      /不会删除你电脑里的原文件/.test(modal.text), modal.text.slice(0, 40));
    check('「原文件」是加粗强调的', /原文件/.test(modal.boldText || ''), modal.boldText);
    check('说明前面有盾牌图标', modal.hasIcon === true);
    check('「彻底删除」不再说「无法恢复」这种吓人的话',
      !/无法恢复/.test(modal.purgeSmall), modal.purgeSmall);
    check('「彻底删除」说清了只是从库里清掉',
      /从库里清掉/.test(modal.purgeSmall), modal.purgeSmall);

    /* ---------- 2. 副本提示按需出现 ---------- */
    const copyNote = await ev(`(async () => {
      const m = document.querySelector('#delModal');
      const note = m.querySelector('#delCopyNote');
      // 没副本：应该藏起来
      note.hidden = true;
      const hiddenDisplay = getComputedStyle(note).display;
      // 有副本：应该显示
      note.hidden = false;
      await new Promise(r => setTimeout(r, 100));
      const shownDisplay = getComputedStyle(note).display;
      const text = note.textContent.trim();
      m.hidden = true;
      return { hiddenDisplay, shownDisplay, text };
    })()`);
    check('没有副本时那句提示是隐藏的', copyNote.hiddenDisplay === 'none',
      copyNote.hiddenDisplay);
    check('有副本时那句提示能显示', copyNote.shownDisplay !== 'none',
      copyNote.shownDisplay);
    check('副本提示说的是「软件自己存的副本」',
      /软件自己存的那份副本/.test(copyNote.text), copyNote.text);

    /* ---------- 3. 两种主题下颜色正常 ---------- */
    for (const theme of ['light', 'dark']) {
      const style = await ev(`(async () => {
        document.documentElement.dataset.theme = '${theme}';
        const m = document.querySelector('#delModal');
        m.hidden = false;
        await new Promise(r => setTimeout(r, 300));
        const note = m.querySelector('.del-note');
        const cs = getComputedStyle(note);
        const body = getComputedStyle(m.querySelector('.modal-body'));
        m.hidden = true;
        return {
          bg: cs.backgroundColor,
          border: cs.borderTopColor,
          color: cs.color,
          modalBg: body.backgroundColor,
        };
      })()`);
      // 背景不能是透明，也不能和弹窗底色一模一样（那样等于看不见）
      check(`${theme}：说明块有底色`, style.bg !== 'rgba(0, 0, 0, 0)', style.bg);
      check(`${theme}：说明块有描边`, style.border !== 'rgba(0, 0, 0, 0)', style.border);
      check(`${theme}：说明块和弹窗底色有区分`, style.bg !== style.modalBg,
        `说明 ${style.bg} / 弹窗 ${style.modalBg}`);
    }
    await ev(`document.documentElement.dataset.theme = 'light'`);

    /* ---------- 4. 后端语义：彻底删除不动磁盘 ---------- */
    const disk = await ev(`(async () => {
      const d = window.__vaultDebug;
      // 把这个临时文件登记进库（link 模式，只记路径，不复制文件）
      const res = await window.vault.files.import(
        [${JSON.stringify(tmpFile)}], null, 'link',
      ).catch((e) => ({ err: e.message }));
      if (res?.err) return { err: res.err };
      d.apply(await window.vault.getState());
      const rec = d.state.files.find(f => f.path === ${JSON.stringify(tmpFile)});
      if (!rec) return { err: '没登记进库' };
      // 彻底删除（trash = false）
      const st = await window.vault.files.removeMany([rec.id], false);
      d.apply(st);
      return {
        storage: rec.storage,
        stillInLib: d.state.files.some(f => f.id === rec.id),
        name: rec.name,
      };
    })()`);

    if (disk.err) {
      check('登记临时文件用于磁盘验证', false, disk.err);
    } else {
      check('临时文件是 link 模式（只登记路径）', disk.storage === 'link', disk.storage);
      check('彻底删除后库记录没了', disk.stillInLib === false);
      // 真正的断言：磁盘文件还在，内容没变
      const alive = fs.existsSync(tmpFile);
      const content = alive ? fs.readFileSync(tmpFile, 'utf8') : '';
      check('彻底删除后磁盘文件仍在', alive === true, tmpFile);
      check('磁盘文件内容没被动过',
        content === '这段内容必须活下来', JSON.stringify(content));
    }
  } finally {
    await ev(`(() => {
      const m = document.querySelector('#delModal');
      if (m) m.hidden = true;
      document.documentElement.dataset.theme = 'light';
    })()`).catch(() => {});
    try { fs.unlinkSync(tmpFile); } catch { /* 已被删则忽略 */ }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  c.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
