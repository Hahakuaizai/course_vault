/**
 * 验证：一级目录下按文件类型筛选，能看到子文件夹里的文件
 * 用真实数据（只读，不改动任何东西）
 */
const { connect } = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const log = (...a) => console.log(...a);
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(ok);
    log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  };

  // 选一个有多级子目录、且子目录里确实有 PDF 的顶层目录
  const info = await c.ev(`(async () => {
    const s = await window.vault.getState();
    const tops = s.courses.filter(x => !x.parentId);
    const result = [];
    for (const t of tops) {
      // 算子树
      const ids = new Set([t.id]);
      const stack = [t.id];
      while (stack.length) {
        const cur = stack.pop();
        for (const k of s.courses.filter(x => x.parentId === cur)) {
          if (!ids.has(k.id)) { ids.add(k.id); stack.push(k.id); }
        }
      }
      const own = s.files.filter(f => f.courseId === t.id);
      const inSub = s.files.filter(f => f.courseId !== t.id && ids.has(f.courseId));
      result.push({
        id: t.id, name: t.name,
        childCount: ids.size - 1,
        ownFiles: own.length,
        subFiles: inSub.length,
        subKinds: [...new Set(inSub.map(f => f.kind))],
        subPdf: inSub.filter(f => f.kind === 'pdf').length,
      });
    }
    return result;
  })()`);
  log('顶层目录概况:');
  info.forEach((t) => log(`  ${t.name}: ${t.childCount} 子目录, 本层 ${t.ownFiles} 文件, 子树里另有 ${t.subFiles} 文件 (${t.subKinds.join(',')})`));

  // 挑一个子目录里有 PDF 的
  const target = info.find((t) => t.subPdf > 0) || info.find((t) => t.subFiles > 0);
  if (!target) {
    log('没有合适的测试目录，跳过');
    c.close();
    return;
  }
  log(`\n测试目录: ${target.name}`);

  // 进入该目录
  await c.ev(`(() => {
    const d = window.__vaultDebug;
    d.state.view = { type: 'course', courseId: ${JSON.stringify(target.id)} };
    d.state.kindFilter = 'all';
    d.state.docKind = 'all';
    d.state.search = '';
    d.render();
  })()`);
  await sleep(600);

  const before = await c.ev(`(() => ({
    cards: document.querySelectorAll('.card[data-file]').length,
    dirs: document.querySelectorAll('.card[data-dir]').length,
    count: document.querySelector('#viewCount')?.textContent || '',
  }))()`);
  log('① 未筛选:', JSON.stringify(before));

  // 点「文档」→「PDF」
  const filtered = await c.ev(`(async () => {
    // 点顶部的「文档」筛选
    const docBtn = [...document.querySelectorAll('.filter-btn, .kind-btn, [data-kind]')]
      .find(b => b.dataset.kind === 'doc' || (b.textContent || '').trim() === '文档');
    if (!docBtn) {
      // 找不到就改状态再渲染
      const d = window.__vaultDebug;
      d.state.kindFilter = 'doc';
      d.render();
    } else {
      docBtn.click();
    }
    await new Promise(r => setTimeout(r, 400));
    // 再点 PDF 子筛选
    const pdfBtn = [...document.querySelectorAll('.subfilter-btn')].find(b => b.dataset.dockey === 'pdf');
    if (pdfBtn) pdfBtn.click();
    else { window.__vaultDebug.state.docKind = 'pdf'; window.__vaultDebug.render(); }
    await new Promise(r => setTimeout(r, 500));
    return {
      kindFilter: window.__vaultDebug.state.kindFilter,
      docKind: window.__vaultDebug.state.docKind,
      cards: document.querySelectorAll('.card[data-file]').length,
      dirs: document.querySelectorAll('.card[data-dir]').length,
      count: document.querySelector('#viewCount')?.textContent || '',
      courses: [...document.querySelectorAll('.card[data-file] .card-course')].map(e => e.textContent.trim()),
      names: [...document.querySelectorAll('.card[data-file] .card-name')].map(e => e.textContent),
    };
  })()`);
  log('② 筛选 PDF:', JSON.stringify(filtered, null, 1));

  check('筛选状态正确', filtered.kindFilter === 'doc' && filtered.docKind === 'pdf');
  check('列出了 PDF 文件', filtered.cards > 0, `${filtered.cards} 个`);
  check('包含子目录里的 PDF', filtered.cards > before.cards || filtered.cards >= target.subPdf,
    `本层原本 ${before.cards} 个卡片，子树里有 ${target.subPdf} 个 PDF`);

  // 对比：实际应等于子树内 PDF 总数
  const expected = await c.ev(`(async () => {
    const s = await window.vault.getState();
    const ids = new Set([${JSON.stringify(target.id)}]);
    const stack = [${JSON.stringify(target.id)}];
    while (stack.length) {
      const cur = stack.pop();
      for (const k of s.courses.filter(x => x.parentId === cur)) {
        if (!ids.has(k.id)) { ids.add(k.id); stack.push(k.id); }
      }
    }
    return s.files.filter(f => ids.has(f.courseId) && f.kind === 'pdf').length;
  })()`);
  check('数量等于子树内 PDF 总数', filtered.cards === expected, `界面 ${filtered.cards} vs 应有 ${expected}`);

  // 卡片底部应显示来源目录，方便识别文件在哪
  const hasSource = filtered.courses.length > 0;
  check('卡片显示了所属目录', hasSource, [...new Set(filtered.courses)].join(' / '));

  // 还原
  await c.ev(`(() => {
    const d = window.__vaultDebug;
    d.state.kindFilter = 'all';
    d.state.docKind = 'all';
    d.state.view = { type: 'all', courseId: null };
    d.render();
  })()`);

  const okCount = results.filter(Boolean).length;
  log(`\n${okCount}/${results.length} 项通过`);
  c.close();
  if (okCount !== results.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
