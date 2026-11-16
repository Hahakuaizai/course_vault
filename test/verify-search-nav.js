'use strict';

/**
 * 验证「名称搜索状态下做导航，搜索必须一起被清掉」。
 *
 * 背景：用户报过一个 bug —— 在「全部文件」里搜 code，点结果里的 code
 * 文件夹进不去。标题和面包屑都换了，可网格还是全库搜索结果，里面的文件
 * 一个都看不见。根因是导航只清了 S.searchHits，而 renderMain / visibleFiles
 * 判断「是否在搜索」用的是搜索框里的文字 S.search。
 *
 * 所以凡是能离开当前视图的入口，都必须调用 clearSearchState()：
 *   1. 点文件夹卡片（enterDir）
 *   2. 点侧栏「全部文件 / 最近导入」
 *   3. 点目录树节点
 *   4. 点面包屑
 *   5. Alt+↑ / Alt+Home
 *
 * 每个入口都按「搜 → 导航 → 搜索框空 + 网格是目录内容」来断言。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 9351;
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
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sn-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-snsrc-'));

  /* 项目设计/code/ 里放 3 个文件 —— 和用户截图里的场景一致：
     搜索能搜到 code 文件夹，但它内部有文件，点进去必须看得见。 */
  const design = path.join(base, '项目设计');
  const code = path.join(design, 'code');
  fs.mkdirSync(code, { recursive: true });
  fs.writeFileSync(path.join(code, '工作满意度分析.R'), 'x <- 1');
  fs.writeFileSync(path.join(code, 'mama.py'), 'print(1)');
  fs.writeFileSync(path.join(code, 'notes.md'), '# 笔记');
  fs.mkdirSync(path.join(design, 'kvengine'), { recursive: true });
  fs.writeFileSync(path.join(design, 'kvengine', 'main.c'), 'int main(){}');

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
      const t = setTimeout(() => { pending.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, 25000);
      pending.set(mid, {
        resolve: (v) => { clearTimeout(t); res(v); },
        reject: (e) => { clearTimeout(t); rej(e); },
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    await sleep(2500);

    /* --- 准备：导入 项目设计/，保留层级 --- */
    const setup = await ev(`(async () => {
      await window.vault.files.import(
        ${JSON.stringify([design])}, null, 'link', 'skip', true);
      const st = await window.vault.getState();
      window.__vaultDebug.apply(st);
      await new Promise(r => setTimeout(r, 500));
      return {
        courses: st.courses.map(c => ({ id: c.id, name: c.name, parentId: c.parentId || null })),
        files: st.files.map(f => ({ name: f.name, courseId: f.courseId })),
      };
    })()`);
    /* 保留层级导入会建出 项目设计 / code / kvengine 三个目录 */
    check('准备数据（3 个目录 / 4 个文件）',
      setup.courses.length === 3 && setup.files.length === 4,
      `${setup.courses.length} 目录 / ${setup.files.length} 文件`);

    /* 公用小工具：切到「全部文件」+ 输入搜索词 + 等 debounce */
    const search = async (q) => {
      await ev(`(async () => {
        document.querySelector('#navAll').click();
        await new Promise(r => setTimeout(r, 300));
        const inp = document.querySelector('#searchInput');
        inp.value = ${JSON.stringify(q)};
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(700);
    };

    /* 公用快照：搜索框 / 标题 / 计数 / 面包屑 / 网格内容 */
    const snap = () => ev(`(() => {
      const inp = document.querySelector('#searchInput');
      return {
        search: inp ? inp.value : null,
        title: document.querySelector('#viewTitle')?.textContent,
        count: document.querySelector('#viewCount')?.textContent,
        crumb: [...document.querySelectorAll('.crumb')].map(e => e.textContent.trim()),
        dirs: [...document.querySelectorAll('.card[data-dir]')]
          .map(c => (c.querySelector('.card-name')?.textContent || '').trim()),
        files: [...document.querySelectorAll('.card[data-file]')]
          .map(c => (c.querySelector('.card-name')?.textContent || '').trim()),
      };
    })()`);

    /* --- 1. 名称搜索：结果里确实有 code 文件夹 --- */
    await search('code');
    const before = await snap();
    check('名称搜索能搜到 code 文件夹', before.dirs.includes('code'),
      `目录=${JSON.stringify(before.dirs)} 文件=${JSON.stringify(before.files)}`);
    check('搜索时网格里没有文件（只剩文件夹结果）', before.files.length === 0,
      String(before.files.length));

    /* --- 2. 点文件夹卡片：必须真的进去 --- */
    const clickCard = await ev(`(() => {
      const card = [...document.querySelectorAll('.card[data-dir]')]
        .find(c => (c.querySelector('.card-name')?.textContent || '').trim() === 'code');
      if (!card) return { err: '没找到 code 卡片' };
      card.click();
      return { ok: true };
    })()`);
    await sleep(700);
    const inDir = await snap();
    check('点文件夹卡片后搜索框被清空', inDir.search === '', JSON.stringify(inDir.search));
    check('点文件夹卡片后标题变成 code', inDir.title === 'code', String(inDir.title));
    check('点文件夹卡片后能看到里面的 3 个文件',
      inDir.files.length === 3,
      `${inDir.files.length} 个：${JSON.stringify(inDir.files)}`);
    check('计数不再显示「N 个结果」', !/结果/.test(inDir.count || ''), String(inDir.count));
    check('面包屑显示「全部 / 项目设计 / code」',
      JSON.stringify(inDir.crumb) === JSON.stringify(['全部', '项目设计', 'code']),
      JSON.stringify(inDir.crumb));

    /* --- 3. 面包屑导航也清搜索 ---
       面包屑只有在目录里才有多级；先点进 code，再搜索，然后点「项目设计」。 */
    const enterCode = await ev(`(async () => {
      /* 上一步停在 code 里，先回顶层才能再点它 */
      document.querySelector('#navAll').click();
      await new Promise(r => setTimeout(r, 400));
      const card = [...document.querySelectorAll('.card[data-dir]')]
        .find(c => (c.querySelector('.card-name')?.textContent || '').trim() === '项目设计');
      if (!card) return { err: '没找到项目设计卡片' };
      card.click();
      await new Promise(r => setTimeout(r, 400));
      const card2 = [...document.querySelectorAll('.card[data-dir]')]
        .find(c => (c.querySelector('.card-name')?.textContent || '').trim() === 'code');
      if (!card2) return { err: '项目设计里没找到 code 卡片' };
      card2.click();
      await new Promise(r => setTimeout(r, 500));
      const inp = document.querySelector('#searchInput');
      inp.value = 'code';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 700));
      return {
        search: inp.value,
        crumb: [...document.querySelectorAll('.crumb')].map(e => e.textContent.trim()),
      };
    })()`);
    check('目录里搜索时面包屑仍保留层级',
      JSON.stringify(enterCode.crumb) === JSON.stringify(['全部', '项目设计', 'code']),
      enterCode.err || JSON.stringify(enterCode.crumb));
    const crumbClick = await ev(`(() => {
      const btn = [...document.querySelectorAll('.crumb')].find(b => b.textContent.trim() === '项目设计');
      if (!btn) return { err: '没有「项目设计」面包屑' };
      btn.click();
      return { ok: true };
    })()`);
    await sleep(700);
    const afterCrumb = await snap();
    check('点面包屑后搜索框被清空', afterCrumb.search === '', String(afterCrumb.search));
    check('点面包屑后进入项目设计（能看到 code 子目录）',
      afterCrumb.title === '项目设计' && afterCrumb.dirs.includes('code'),
      `标题=${afterCrumb.title} 目录=${JSON.stringify(afterCrumb.dirs)}`);

    /* --- 4. 侧栏导航也清搜索 --- */
    await search('code');
    const navClick = await ev(`(async () => {
      document.querySelector('#navAll').click();
      return true;
    })()`);
    await sleep(700);
    const afterNav = await snap();
    check('点侧栏「全部文件」后搜索框被清空', afterNav.search === '', String(afterNav.search));
    check('点侧栏「全部文件」后回到顶层视图',
      afterNav.title === '全部文件', String(afterNav.title));
    check('点侧栏「全部文件」后网格恢复为顶层目录',
      afterNav.dirs.includes('项目设计'), JSON.stringify(afterNav.dirs));

    /* --- 5. 目录树导航也清搜索 --- */
    await search('code');
    const treeClick = await ev(`(async () => {
      // 树里的「项目设计」是顶层节点，一定可见；先确保它是展开的
      const row = [...document.querySelectorAll('[data-course]')]
        .find(r => (r.querySelector('.tree-name')?.textContent || '').trim() === '项目设计');
      if (!row) return { err: '树里没有「项目设计」' };
      row.click();
      return { ok: true };
    })()`);
    await sleep(700);
    const afterTree = await snap();
    check('点目录树后搜索框被清空', afterTree.search === '', String(afterTree.search));
    check('点目录树后进入项目设计',
      afterTree.title === '项目设计' && afterTree.dirs.includes('code'),
      `标题=${afterTree.title} 目录=${JSON.stringify(afterTree.dirs)}`);

    /* --- 6. Alt+↑ / Alt+Home 也清搜索 --- */
    const keyNav = await ev(`(async () => {
      const out = {};
      for (const [name, key] of [['Alt+↑', 'ArrowUp'], ['Alt+Home', 'Home']]) {
        // 先制造搜索状态
        document.querySelector('#navAll').click();
        await new Promise(r => setTimeout(r, 250));
        const inp = document.querySelector('#searchInput');
        inp.value = 'code';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));

        document.dispatchEvent(new KeyboardEvent('keydown', {
          key, altKey: true, bubbles: true, cancelable: true,
        }));
        await new Promise(r => setTimeout(r, 700));

        const inp2 = document.querySelector('#searchInput');
        out[name] = {
          search: inp2 ? inp2.value : null,
          title: document.querySelector('#viewTitle')?.textContent,
          dirs: [...document.querySelectorAll('.card[data-dir]')]
            .map(c => (c.querySelector('.card-name')?.textContent || '').trim()),
        };
      }
      return out;
    })()`);
    for (const [name, r] of Object.entries(keyNav)) {
      check(`${name} 后搜索框被清空`, r.search === '', String(r.search));
      check(`${name} 后回到顶层视图且目录可见`,
        r.title === '全部文件' && r.dirs.includes('项目设计'),
        `标题=${r.title} 目录=${JSON.stringify(r.dirs)}`);
    }

    /* --- 7. 反向保护：搜索框清空后正常导航仍工作 --- */
    const plain = await ev(`(async () => {
      document.querySelector('#navAll').click();
      await new Promise(r => setTimeout(r, 300));
      const card = [...document.querySelectorAll('.card[data-dir]')]
        .find(c => (c.querySelector('.card-name')?.textContent || '').trim() === '项目设计');
      if (!card) return { err: '没找到项目设计卡片' };
      card.click();
      await new Promise(r => setTimeout(r, 500));
      return {
        title: document.querySelector('#viewTitle')?.textContent,
        dirs: [...document.querySelectorAll('.card[data-dir]')]
          .map(c => (c.querySelector('.card-name')?.textContent || '').trim()),
      };
    })()`);
    check('没有搜索时点文件夹照常进入',
      plain.title === '项目设计' && plain.dirs.includes('code'),
      `标题=${plain.title} 目录=${JSON.stringify(plain.dirs)}`);
  } finally {
    if (ws) ws.close();
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(800);
    for (const d of [tmpData, base]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
