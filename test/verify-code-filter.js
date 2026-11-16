'use strict';

/**
 * 验证「代码」的二级类型筛选（Python / C / Java / 前端 / Go / Rust / 脚本 / 数据配置 / 其他）。
 *
 * 只测前端筛选逻辑，不需要真的导入文件 —— 直接往 state 里塞构造好的记录，
 * 比造一堆真实文件快得多，也不会在用户库里留垃圾。
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
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cf-'));
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
      const t = setTimeout(() => { pending.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, 20000);
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

    /* --- 1. 子筛选条是否存在、按钮是否齐全 --- */
    const bar = await ev(`(() => {
      const el = document.querySelector('#codeSubFilter');
      if (!el) return { err: '没有 #codeSubFilter' };
      return {
        hidden: el.hidden,
        keys: [...el.querySelectorAll('.subfilter-btn')].map(b => b.dataset.codekey),
        labels: [...el.querySelectorAll('.subfilter-btn')].map(b => b.textContent.trim()),
      };
    })()`);
    check('代码子筛选条存在', !bar.err, bar.err || '');
    const expectKeys = ['all', 'python', 'cpp', 'java', 'web', 'go', 'rust', 'shell', 'data', 'other'];
    check('按钮齐全', JSON.stringify(bar.keys) === JSON.stringify(expectKeys), (bar.keys || []).join(', '));
    check('默认隐藏（没选「代码」时）', bar.hidden === true, String(bar.hidden));

    /* --- 2. 塞数据 ---
     * 前端是封闭作用域，codeLangOf / CODE_LANG_MAP 在页面里访问不到，
     * 所以映射表只能靠「塞进去 → 筛选 → 看剩谁」来验证。
     * 顺带把各组的边界扩展名都塞进来（.pyw / .kt / .tsx / .toml / .yaml…），
     * 一个用例同时测了筛选和映射。 */
    const setup = await ev(`(async () => {
      // 用一个顶层目录挂这些假记录，避免混进真实数据。
      // 注意要用 create 返回的 state（已含新目录），不能拿建之前的旧 state，
      // 否则 apply 回去会把刚建的目录冲掉。
      const st = await window.vault.courses.create('筛选测试', '#5b8def', null);
      const dir = st.courses.find(c => c.name === '筛选测试' && !c.parentId);
      const now = Date.now();
      const mk = (name, ext, kind) => ({
        id: 'fake_' + name, courseId: dir.id, name, ext, kind,
        size: 100, mtime: now, addedAt: now, path: 'C:\\\\fake\\\\' + name,
        storage: 'link', exists: true,
      });
      const fake = [
        // Python
        mk('train.py', '.py', 'code'),
        mk('win.pyw', '.pyw', 'code'),
        // C 家族
        mk('test_index.cpp', '.cpp', 'code'),
        mk('util.h', '.h', 'code'),
        // JVM
        mk('Main.java', '.java', 'code'),
        mk('Form.kt', '.kt', 'code'),
        // 前端
        mk('app.js', '.js', 'code'),
        mk('index.html', '.html', 'code'),
        mk('App.tsx', '.tsx', 'code'),
        mk('style.css', '.css', 'code'),
        // Go / Rust
        mk('main.go', '.go', 'code'),
        mk('lib.rs', '.rs', 'code'),
        mk('Cargo.toml', '.toml', 'code'),
        // 脚本
        mk('run.bat', '.bat', 'code'),
        mk('deploy.sh', '.sh', 'code'),
        // 数据配置
        mk('metrics.json', '.json', 'code'),
        mk('conf.yaml', '.yaml', 'code'),
        mk('schema.sql', '.sql', 'code'),
        // 其他
        mk('notes.rb', '.rb', 'code'),
        // 非代码，用来验证不会被混进来
        mk('report.pdf', '.pdf', 'pdf'),
        mk('shot.png', '.png', 'image'),
      ];
      st.files.push(...fake);
      window.__vaultDebug.apply(st);
      window.__vaultDebug.state.view = { type: 'course', courseId: dir.id };
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 400));
      return { dirId: dir.id, total: fake.length };
    })()`);
    check('准备测试数据', !!setup.dirId, `${setup.total} 条记录`);

    /* --- 3. 逐个筛选 --- */

    /* 点「代码」看子筛选条出现 */
    const clickCode = await ev(`(async () => {
      const btn = [...document.querySelectorAll('#kindFilter .seg-btn')]
        .find(b => b.dataset.kind === 'code');
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      const bar = document.querySelector('#codeSubFilter');
      const names = [...document.querySelectorAll('.card[data-file] .card-name')].map(n => n.textContent);
      return { hidden: bar.hidden, count: names.length, names };
    })()`);
    check('点「代码」后子筛选条出现', clickCode.hidden === false, String(clickCode.hidden));
    check('「全部代码」显示所有代码文件', clickCode.count === 19,
      `${clickCode.count} 个：${clickCode.names.join(', ')}`);
    check('代码筛选里没有 PDF / 图片',
      !clickCode.names.some((n) => /\.pdf$|\.png$/.test(n)), clickCode.names.join(', '));

    /* 逐个二级分类点过去 */
    const pick = async (key) => ev(`(async () => {
      const btn = document.querySelector('#codeSubFilter [data-codekey="${key}"]');
      if (!btn) return { err: '没有按钮 ' + ${JSON.stringify(key)} };
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      const active = document.querySelector('#codeSubFilter .subfilter-btn.is-active');
      return {
        activeKey: active?.dataset.codekey,
        names: [...document.querySelectorAll('.card[data-file] .card-name')].map(n => n.textContent),
      };
    })()`);

    const expectations = {
      python: ['train.py', 'win.pyw'],
      cpp: ['test_index.cpp', 'util.h'],
      java: ['Form.kt', 'Main.java'],
      web: ['App.tsx', 'app.js', 'index.html', 'style.css'],
      go: ['main.go'],
      rust: ['Cargo.toml', 'lib.rs'],
      shell: ['deploy.sh', 'run.bat'],
      data: ['conf.yaml', 'metrics.json', 'schema.sql'],
      other: ['notes.rb'],
    };

    for (const [key, want] of Object.entries(expectations)) {
      const r = await pick(key);
      const got = (r.names || []).slice().sort();
      const ok = JSON.stringify(got) === JSON.stringify(want.slice().sort());
      check(`「${key}」只出该类文件`, ok, `实得 [${got.join(', ')}]`);
    }

    /* 按钮高亮跟着走 */
    const activeState = await pick('python');
    check('选中的按钮高亮', activeState.activeKey === 'python', String(activeState.activeKey));

    /* 空分类的提示文案：把 go 文件删掉，点 Go 应给出针对「Go」的提示 */
    const emptyTip = await ev(`(async () => {
      const st = window.__vaultDebug.state;
      st.files = st.files.filter(f => f.ext !== '.go');
      window.__vaultDebug.apply(st);
      window.__vaultDebug.state.view = st.view;
      window.__vaultDebug.render();
      await new Promise(r => setTimeout(r, 300));
      document.querySelector('#codeSubFilter [data-codekey="go"]').click();
      await new Promise(r => setTimeout(r, 300));
      const p = document.querySelector('#emptyState p');
      return { hidden: document.querySelector('#emptyState').hidden, text: p?.textContent };
    })()`);
    check('空分类给出针对性提示', emptyTip.text && emptyTip.text.includes('Go'), emptyTip.text || '（没提示）');

    /* --- 4. 切走再切回来，二级分类要归零 --- */
    const reset = await ev(`(async () => {
      const docBtn = [...document.querySelectorAll('#kindFilter .seg-btn')].find(b => b.dataset.kind === 'doc');
      docBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const codeBtn = [...document.querySelectorAll('#kindFilter .seg-btn')].find(b => b.dataset.kind === 'code');
      codeBtn.click();
      await new Promise(r => setTimeout(r, 300));
      const active = document.querySelector('#codeSubFilter .subfilter-btn.is-active');
      return { activeKey: active?.dataset.codekey };
    })()`);
    check('切走再回来二级分类归零', reset.activeKey === 'all', String(reset.activeKey));

    /* --- 5. 文档子筛选条和代码条不会同时出现 --- */
    const exclusive = await ev(`(async () => {
      const codeBtn = [...document.querySelectorAll('#kindFilter .seg-btn')].find(b => b.dataset.kind === 'code');
      codeBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const a = { doc: document.querySelector('#docSubFilter').hidden, code: document.querySelector('#codeSubFilter').hidden };
      const docBtn = [...document.querySelectorAll('#kindFilter .seg-btn')].find(b => b.dataset.kind === 'doc');
      docBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const b = { doc: document.querySelector('#docSubFilter').hidden, code: document.querySelector('#codeSubFilter').hidden };
      return { codeView: a, docView: b };
    })()`);
    check('代码视图只显示代码条',
      exclusive.codeView.doc === true && exclusive.codeView.code === false,
      JSON.stringify(exclusive.codeView));
    check('文档视图只显示文档条',
      exclusive.docView.doc === false && exclusive.docView.code === true,
      JSON.stringify(exclusive.docView));

    /* 清理：删掉测试目录和假记录 */
    await ev(`(async () => {
      const st = window.__vaultDebug.state;
      const dir = st.courses.find(c => c.name === '筛选测试');
      st.files = st.files.filter(f => !String(f.id).startsWith('fake_'));
      if (dir) st.courses = st.courses.filter(c => c.id !== dir.id);
      window.__vaultDebug.apply(st);
      await new Promise(r => setTimeout(r, 200));
      return true;
    })()`);
  } finally {
    if (ws) ws.close();
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(800);
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
