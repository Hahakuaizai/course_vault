'use strict';

/**
 * 验证悬停信息浮层：
 *   1. 文件夹卡片悬停显示 归属 / 内容 / 位置
 *   2. 文件卡片悬停显示 归属 / 大小 / 完整磁盘路径
 *   3. 右上角徽章不再显示文件夹大小
 *   4. 浮层不挡住鼠标（pointer-events: none）
 *   5. 移开鼠标后浮层消失
 *   6. sourcePath 能持久化（重启后仍在）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function launch(userData) {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await getJSON('/json/list');
      const page = list.find((t) => t.type === 'page');
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 等 */ }
    await sleep(500);
  }
  if (!wsUrl) throw new Error('CDP 连不上');

  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    const t = setTimeout(() => { pending.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, 20000);
    pending.set(mid, {
      resolve: (v) => { clearTimeout(t); res(v); },
      reject: (e) => { clearTimeout(t); rej(e); },
    });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, ev, send, close: () => { try { ws.close(); } catch { /* 忽略 */ } } };
}

async function main() {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tip-'));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-src-'));
  fs.mkdirSync(path.join(tree, '子目录'), { recursive: true });
  fs.writeFileSync(path.join(tree, '说明.md'), '# hi');
  fs.writeFileSync(path.join(tree, '子目录', '深文件.txt'), 'deep');

  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };

  let app = null;
  try {
    app = await launch(tmpData);
    await sleep(2500);

    /* 导入测试目录 */
    const imp = await app.ev(`(async () => {
      const res = await window.vault.files.import(
        ${JSON.stringify([tree])}, null, 'link', 'skip', true
      );
      window.__vaultDebug.apply(res.state);
      await new Promise(r => setTimeout(r, 400));
      return { count: res.count, dirs: res.state.courses.length };
    })()`);
    check('导入成功', imp.count === 2, `${imp.count} 个文件`);

    /* 1. 文件夹卡片不再有右上角徽章（图标已说明是文件夹，信息重复） */
    const badges = await app.ev(`(() => {
      const cards = [...document.querySelectorAll('.dir-card')];
      return cards.map(c => ({
        name: c.querySelector('.card-name')?.textContent,
        badge: c.querySelector('.card-badge')?.textContent?.trim() || null,
        sub: c.querySelector('.card-sub')?.textContent?.replace(/\\s+/g, ' ').trim() || null,
      }));
    })()`);
    const rootCard = badges.find((b) => b.name === path.basename(tree));
    check('文件夹卡片没有右上角徽章', !!rootCard && rootCard.badge === null, rootCard?.badge || '无');
    check('副标题仍显示文件数', !!rootCard && rootCard.sub?.includes('2'), rootCard?.sub);

    /* 2. 文件夹悬停浮层 */
    const dirTip = await app.ev(`(async () => {
      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === ${JSON.stringify(path.basename(tree))});
      if (!card) return { error: '没找到文件夹卡片' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: r.left + 20, clientY: r.top + 20,
      }));
      // 等过 420ms 的延迟
      await new Promise(r2 => setTimeout(r2, 700));
      const tip = document.querySelector('#hoverTip');
      const style = getComputedStyle(tip);
      return {
        hidden: tip.hidden,
        text: tip.textContent.replace(/\\s+/g, ' ').trim(),
        html: tip.innerHTML,
        pointerEvents: style.pointerEvents,
        hasPath: tip.innerHTML.includes('vault-src-'),
      };
    })()`);
    check('文件夹悬停浮层出现', dirTip.hidden === false, dirTip.error || '');
    check('浮层含「归属」', dirTip.text?.includes('归属'));
    check('浮层含「内容」', dirTip.text?.includes('内容'));
    check('浮层含「位置」', dirTip.text?.includes('位置'));
    check('浮层显示磁盘路径', dirTip.hasPath, dirTip.hasPath ? '含 vault-src-' : '没有路径');
    check('浮层不挡鼠标', dirTip.pointerEvents === 'none', dirTip.pointerEvents);

    /* 3. 移开后消失 */
    const afterOut = await app.ev(`(async () => {
      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === ${JSON.stringify(path.basename(tree))});
      card.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true, relatedTarget: document.body,
      }));
      await new Promise(r => setTimeout(r, 150));
      return { hidden: document.querySelector('#hoverTip').hidden };
    })()`);
    check('移开鼠标后浮层消失', afterOut.hidden === true);

    /* 4. 文件悬停浮层 */
    // 先进到文件夹里面，才能看到文件卡片
    const fileTip = await app.ev(`(async () => {
      const st = window.__vaultDebug.state;
      const dir = st.courses.find(c => c.name === ${JSON.stringify(path.basename(tree))});
      // 切换到该目录视图
      window.__vaultDebug.state.view = { type: 'course', courseId: dir.id };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 300));

      const card = document.querySelector('.card[data-file]');
      if (!card) return { error: '没找到文件卡片' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: r.left + 20, clientY: r.top + 20,
      }));
      await new Promise(r2 => setTimeout(r2, 700));
      const tip = document.querySelector('#hoverTip');
      return {
        hidden: tip.hidden,
        text: tip.textContent.replace(/\\s+/g, ' ').trim(),
        hasFullPath: /说明\\.md|深文件\\.txt/.test(tip.textContent),
      };
    })()`);
    check('文件悬停浮层出现', fileTip.hidden === false, fileTip.error || '');
    check('浮层含「大小」', fileTip.text?.includes('大小'), fileTip.text?.slice(0, 80));
    check('浮层显示完整文件路径', fileTip.hasFullPath);

    /* 5. 归属显示完整层级（课程文件 / 计组），不是只有最后一级 */
    const trailTest = await app.ev(`(async () => {
      // 建两级目录：课程文件 → 计组，文件放进去
      const a = await window.vault.courses.create('课程文件', '#5b8def', null);
      const st1 = await window.vault.getState();
      const rootA = st1.courses.find(c => c.name === '课程文件');
      await window.vault.courses.create('计组', '#5b8def', rootA.id);
      const st2 = await window.vault.getState();
      const b = st2.courses.find(c => c.name === '计组' && c.parentId === rootA.id);

      // 把一个已有文件挪进「计组」
      const st3 = await window.vault.getState();
      const f = st3.files[0];
      await window.vault.files.moveMany([f.id], b.id);
      const st4 = await window.vault.getState();
      window.__vaultDebug.apply(st4);
      window.__vaultDebug.state.view = { type: 'course', courseId: b.id };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));

      const card = document.querySelector('.card[data-file]');
      if (!card) return { error: '没找到文件卡片' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: r.left + 20, clientY: r.top + 20,
      }));
      await new Promise(r2 => setTimeout(r2, 700));
      const tip = document.querySelector('#hoverTip');
      const text = tip.textContent.replace(/\\s+/g, ' ').trim();
      return { text, hasTrail: text.includes('课程文件 / 计组') };
    })()`);
    check('文件归属显示完整层级「课程文件 / 计组」',
      trailTest.hasTrail, trailTest.error || trailTest.text?.slice(0, 90));

    /* 6. 目录卡片的归属也显示完整层级 */
    const dirTrailTest = await app.ev(`(async () => {
      const st = window.__vaultDebug.state;
      const rootA = st.courses.find(c => c.name === '课程文件');
      window.__vaultDebug.state.view = { type: 'course', courseId: rootA.id };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));

      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === '计组');
      if (!card) return { error: '没找到计组卡片' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: r.left + 20, clientY: r.top + 20,
      }));
      await new Promise(r2 => setTimeout(r2, 700));
      const tip = document.querySelector('#hoverTip');
      const text = tip.textContent.replace(/\\s+/g, ' ').trim();
      return { text, hasTrail: text.includes('课程文件') };
    })()`);
    check('目录归属显示父级层级',
      dirTrailTest.hasTrail, dirTrailTest.error || dirTrailTest.text?.slice(0, 90));

    app.close();
    app = null;
    await sleep(1200);

    /* 5. sourcePath 持久化：重启后还在 */
    const app2 = await launch(tmpData);
    await sleep(2500);
    const persisted = await app2.ev(`(() => {
      const st = window.__vaultDebug.state;
      const dir = st.courses.find(c => c.name === ${JSON.stringify(path.basename(tree))});
      return { sourcePath: dir?.sourcePath || null };
    })()`);
    check('重启后 sourcePath 仍保留',
      !!persisted.sourcePath && persisted.sourcePath.includes('vault-src-'),
      persisted.sourcePath || '丢失了');

    app2.close();
  } finally {
    if (app) app.close();
    await sleep(800);
    for (const d of [tmpData, tree]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
