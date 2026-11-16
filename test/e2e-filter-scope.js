/** 验证三种筛选范围的边界：不筛选 / 选文件夹 / 选其他类型 */
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

  const target = await c.ev(`(async () => {
    const s = await window.vault.getState();
    // 找子目录最多的顶层目录
    const tops = s.courses.filter(x => !x.parentId);
    let best = null;
    for (const t of tops) {
      const kids = s.courses.filter(x => x.parentId === t.id).length;
      if (!best || kids > best.kids) best = { id: t.id, name: t.name, kids };
    }
    return best;
  })()`);
  log('测试目录:', JSON.stringify(target));

  const probe = async (kind, docKind) => c.ev(`(() => {
    const d = window.__vaultDebug;
    d.state.view = { type: 'course', courseId: ${JSON.stringify(target.id)} };
    d.state.kindFilter = ${JSON.stringify(kind)};
    d.state.docKind = ${JSON.stringify(docKind)};
    d.state.search = '';
    d.render();
    return {
      files: document.querySelectorAll('.card[data-file]').length,
      dirs: document.querySelectorAll('.card[data-dir]').length,
    };
  })()`);

  // 1) 不筛选：只显示本层文件和子目录卡片
  const plain = await probe('all', 'all');
  log('① 不筛选:', JSON.stringify(plain));
  check('不筛选时显示子目录卡片', plain.dirs > 0, `${plain.dirs} 个`);
  check('不筛选时本层无文件所以 0 个文件卡', plain.files === 0);

  // 2) 选「文件夹」：只显示文件夹，不显示文件
  const folders = await probe('folder', 'all');
  log('② 选文件夹:', JSON.stringify(folders));
  check('选文件夹时显示文件夹', folders.dirs > 0);
  check('选文件夹时不显示文件', folders.files === 0);

  // 3) 选「图片」等具体类型：显示子树里的文件，不显示文件夹
  const images = await probe('image', 'all');
  log('③ 选图片:', JSON.stringify(images));
  check('选具体类型时不显示文件夹卡片', images.dirs === 0);

  // 4) 选「文档」但子类型是「全部」：也要跨子树
  const docs = await probe('doc', 'all');
  log('④ 选文档(全部子类):', JSON.stringify(docs));
  check('选文档时跨子树显示', docs.files > 0, `${docs.files} 个`);

  // 5) 回到「全部文件」视图选类型：应该全库显示
  const allView = await c.ev(`(() => {
    const d = window.__vaultDebug;
    d.state.view = { type: 'all', courseId: null };
    d.state.kindFilter = 'doc';
    d.state.docKind = 'pdf';
    d.render();
    return { files: document.querySelectorAll('.card[data-file]').length };
  })()`);
  const totalPdf = await c.ev(`window.vault.getState().then(s => s.files.filter(f => f.kind === 'pdf').length)`);
  log('⑤ 全部文件视图选 PDF:', JSON.stringify(allView), '库内 PDF 总数:', totalPdf);
  check('全部文件视图显示全库 PDF', allView.files === totalPdf, `${allView.files} / ${totalPdf}`);

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
