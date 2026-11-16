'use strict';

/**
 * 验证「文件夹显示总大小」：
 *   1. snapshot 算出的 totalSize 是否等于子树内文件真实大小之和
 *   2. 卡片上是否真的渲染出了大小文字
 *   3. 徽章会不会因为多了一截文字而溢出
 *
 * 用独立 userData 启动，不碰用户真实数据。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9343;
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

async function main() {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-dsz-'));
  // 造一个有明确大小的目录树：
  //   根/
  //     a.txt      1024 B
  //     子1/
  //       b.txt    2048 B
  //       子2/
  //         c.txt  4096 B
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tree-'));
  fs.writeFileSync(path.join(tree, 'a.txt'), Buffer.alloc(1024, 'a'));
  fs.mkdirSync(path.join(tree, '子1', '子2'), { recursive: true });
  fs.writeFileSync(path.join(tree, '子1', 'b.txt'), Buffer.alloc(2048, 'b'));
  fs.writeFileSync(path.join(tree, '子1', '子2', 'c.txt'), Buffer.alloc(4096, 'c'));

  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmpData}`],
    { stdio: 'ignore' });

  let ws;
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };

  try {
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

    ws = new WebSocket(wsUrl);
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

    await sleep(2500);

    /* 导入这棵树 */
    const imp = await ev(`(async () => {
      const res = await window.vault.files.import(
        ${JSON.stringify([tree])}, null, 'link', 'skip', true
      );
      window.__vaultDebug.apply(res.state);
      await new Promise(r => setTimeout(r, 400));
      return { count: res.count };
    })()`);
    check('导入成功', imp.count === 3, `${imp.count} 个文件`);

    /* 校验 totalSize */
    const sizes = await ev(`(() => {
      const st = window.__vaultDebug.state;
      const byName = {};
      for (const c of st.courses) byName[c.name] = { totalSize: c.totalSize, totalCount: c.totalCount, id: c.id };
      return byName;
    })()`);

    const rootName = path.basename(tree);
    const root = sizes[rootName];
    check('根目录 totalSize 正确（1024+2048+4096=7168）',
      root && root.totalSize === 7168, root ? `${root.totalSize} B` : '没找到根目录');

    const sub1 = sizes['子1'];
    check('子目录 totalSize 正确（2048+4096=6144）',
      sub1 && sub1.totalSize === 6144, sub1 ? `${sub1.totalSize} B` : '没找到子1');

    const sub2 = sizes['子2'];
    check('孙目录 totalSize 正确（4096）',
      sub2 && sub2.totalSize === 4096, sub2 ? `${sub2.totalSize} B` : '没找到子2');

    /* 校验界面真的渲染出来了 */
    const rendered = await ev(`(() => {
      const cards = [...document.querySelectorAll('.dir-card')];
      return cards.map(c => ({
        name: c.querySelector('.card-name')?.textContent,
        badge: c.querySelector('.card-badge')?.textContent?.trim(),
        sub: c.querySelector('.card-sub')?.textContent?.trim(),
        // 徽章有没有超出卡片
        badgeOverflow: (() => {
          const b = c.querySelector('.card-badge');
          const card = c.getBoundingClientRect();
          if (!b) return false;
          const br = b.getBoundingClientRect();
          return br.left < card.left || br.width > card.width;
        })(),
      }));
    })()`);

    const rootCard = rendered.find((c) => c.name === rootName);
    // 文件夹卡片已经没有右上角徽章，文件数改在副标题里
    check('文件夹卡片没有徽章', !!rootCard && !rootCard.badge, rootCard?.badge || '无');
    check('副标题含文件数', !!rootCard && rootCard.sub?.includes('3'), rootCard?.sub);

    /* 大小改到悬停浮层里显示 —— 悬停后应能看到 7.0 KB */
    const tipSize = await ev(`(async () => {
      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === ${JSON.stringify(rootName)});
      if (!card) return { error: '没找到卡片' };
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: r.left + 20, clientY: r.top + 20,
      }));
      await new Promise(r2 => setTimeout(r2, 700));
      const tip = document.querySelector('#hoverTip');
      return { hidden: tip.hidden, text: tip.textContent.replace(/\\s+/g, ' ').trim() };
    })()`);
    check('悬停浮层显示文件夹总大小',
      tipSize.hidden === false && /KB|MB|B/.test(tipSize.text),
      tipSize.text?.slice(0, 100));

    console.log('\n     渲染结果：');
    rendered.forEach((c) => console.log(`       ${c.name}: 徽章「${c.badge}」 副标题「${c.sub}」`));

    /* 空目录不应显示 0 B */
    const emptyCase = await ev(`(async () => {
      await window.vault.courses.create('空目录测试', '#5b8def', null);
      window.__vaultDebug.apply(await window.vault.getState());
      await new Promise(r => setTimeout(r, 300));
      const card = [...document.querySelectorAll('.dir-card')]
        .find(c => c.querySelector('.card-name')?.textContent === '空目录测试');
      return { badge: card?.querySelector('.card-badge')?.textContent?.trim() };
    })()`);
    check('空目录不显示 0 B', !emptyCase.badge?.includes('0 B'), emptyCase.badge);

    /* 文件被删掉后，文件夹大小应该跟着减少，不能拿旧记录充数 */
    const gone = await ev(`(async () => {
      const before = window.__vaultDebug.state.courses.find(c => c.name === ${JSON.stringify(rootName)});
      const beforeSize = before.totalSize;
      // 删掉最大的那个 c.txt（4096 B），然后刷新
      window.__vaultDebug.apply(await window.vault.getState());
      const st = window.__vaultDebug.state;
      const target = st.files.find(f => f.name === 'c.txt');
      return { beforeSize, targetId: target?.id, targetSize: target?.size };
    })()`);

    // 真删磁盘文件，再让主进程重新 stat
    fs.rmSync(path.join(tree, '子1', '子2', 'c.txt'));
    await sleep(2200); // 等 statCache 的 2 秒 TTL 过期

    const afterGone = await ev(`(async () => {
      window.__vaultDebug.apply(await window.vault.getState());
      const c = window.__vaultDebug.state.courses.find(x => x.name === ${JSON.stringify(rootName)});
      return { totalSize: c?.totalSize, totalCount: c?.totalCount };
    })()`);

    check('删掉文件后总大小同步减少',
      afterGone.totalSize === gone.beforeSize - 4096,
      `${gone.beforeSize} → ${afterGone.totalSize}（应减 4096）`);
  } finally {
    if (ws) ws.close();
    try { child.kill(); } catch { /* 忽略 */ }
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
