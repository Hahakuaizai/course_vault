'use strict';

/**
 * 验证图片编辑器（旋转 / 裁剪 / 画笔 / 马赛克 / 橡皮 / 撤销 / 保存回原文件）。
 *
 * 用真鼠标事件驱动画布 —— 合成 .click() 不产生 pointerdown/pointermove 配对，
 * 画不出一笔（这条坑在底栏那次已经踩过）。
 *
 * 检查的结论：
 *   · 四种工具都能改到画布上，橡皮能擦掉墨迹
 *   · 撤销 / 重做 / 还原是真的在改画布，不只是改按钮状态
 *   · 旋转换宽高、裁剪能裁出指定矩形
 *   · 保存后磁盘上的原文件真的变成裁剪后的 50×50，且改之前的旧版本备份还在
 *   · GIF 这类画布编不出来的格式不给编辑入口，强行调用保存会被拒绝
 *
 * 全程用系统临时目录，不碰用户的任何文件。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const PORT = 9352;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 造一张 200×120 的 PNG（不借任何图片库） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      const o = row + 1 + x * 3;
      raw[o] = 40 + Math.floor((x / w) * 120);
      raw[o + 1] = 90 + Math.floor((y / h) * 90);
      raw[o + 2] = 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 从 PNG 文件头读宽高（IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后） */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/* 1×1 的透明 GIF，只用来验证「不支持的格式不给编辑入口」 */
const GIF_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64',
);

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
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-img-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-imgsrc-'));
  const pngPath = path.join(base, '测试图.png');
  const gifPath = path.join(base, '小图.gif');
  const jpgPath = path.join(base, '照片.jpg');
  const ORIG_PNG = makePng(200, 120);
  fs.writeFileSync(pngPath, ORIG_PNG);
  fs.writeFileSync(gifPath, GIF_BYTES);

  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron,
    [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmpData}`],
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
    if (!wsUrl) throw new Error('连不上调试端口');

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
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    };
    /** 真实鼠标拖动：把「图片像素坐标」换算成窗口坐标后逐点派发 */
    const drag = async (points, steps = 6) => {
      const g = await ev(`(() => {
        const wrap = document.querySelector('#ieWrap');
        const ie = window.__vaultDebug.imageEditor;
        if (!wrap || !ie) return null;
        const r = wrap.getBoundingClientRect();
        return { left: r.left, top: r.top, sx: r.width / ie.baseCanvas.width, sy: r.height / ie.baseCanvas.height };
      })()`);
      if (!g) throw new Error('画布还没准备好');
      const at = (p) => ({ x: g.left + p.x * g.sx, y: g.top + p.y * g.sy });
      const first = at(points[0]);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, buttons: 0 });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1,
      });
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        for (let s = 1; s <= steps; s += 1) {
          const p = at({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1,
          });
        }
      }
      const last = at(points[points.length - 1]);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1,
      });
      await sleep(200);
    };
    const snap = () => ev(`(() => {
      const ie = window.__vaultDebug.imageEditor;
      const ink = document.querySelector('#ieInk');
      let inkPx = null;
      if (ink) {
        const d = ink.getContext('2d').getImageData(0, 0, ink.width, ink.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
        inkPx = n;
      }
      return {
        hasEditor: !!document.querySelector('.img-editor'),
        ops: ie ? ie.ops.length : -1,
        redo: ie ? ie.redo.length : -1,
        w: ie ? ie.baseCanvas.width : 0,
        h: ie ? ie.baseCanvas.height : 0,
        tool: ie ? ie.tool : null,
        ink: inkPx,
        cropBar: !document.querySelector('#ieCropBar')?.hidden,
        editHidden: document.querySelector('#btnEdit')?.hidden,
      };
    })()`);
    const alphaIn = (x0, y0, x1, y1) => ev(`(() => {
      const ink = document.querySelector('#ieInk');
      if (!ink) return -1;
      const d = ink.getContext('2d').getImageData(${x0}, ${y0}, ${x1 - x0}, ${y1 - y0}).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
      return n;
    })()`);
    const click = async (sel) => {
      const r = await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!r) throw new Error(`找不到 ${sel}`);
      await sleep(200);
    };
    const waitFor = async (test, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await ev(test)) return true;
        await sleep(200);
      }
      return false;
    };

    await sleep(2500);

    /* ---------- 0. 借渲染层的画布生成一张 JPG（Node 没有图片编码器） ---------- */
    const jpgB64 = await ev(`(() => {
      const c = document.createElement('canvas');
      c.width = 60; c.height = 40;
      const g = c.getContext('2d');
      g.fillStyle = '#2b6cb0';
      g.fillRect(0, 0, 60, 40);
      g.fillStyle = '#f6ad55';
      g.fillRect(10, 10, 20, 20);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    })()`);
    fs.writeFileSync(jpgPath, Buffer.from(jpgB64, 'base64'));

    /* ---------- 1. 导入 ---------- */
    const reg = await ev(`(async () => {
      await window.vault.files.import(
        [${JSON.stringify(pngPath)}, ${JSON.stringify(gifPath)}, ${JSON.stringify(jpgPath)}],
        null, 'link');
      window.__vaultDebug.apply(await window.vault.getState());
      const st = window.__vaultDebug.state;
      const png = st.files.find(f => f.path === ${JSON.stringify(pngPath)});
      const gif = st.files.find(f => f.path === ${JSON.stringify(gifPath)});
      const jpg = st.files.find(f => f.path === ${JSON.stringify(jpgPath)});
      return { png: png?.id, gif: gif?.id, jpg: jpg?.id, kinds: st.files.map(f => f.name) };
    })()`);
    check('导入测试图片', !!reg.png && !!reg.gif && !!reg.jpg, JSON.stringify(reg.kinds));
    if (!reg.png) throw new Error('测试图片没导入成功');

    /* ---------- 2. 预览里能进编辑器 ---------- */
    await ev(`window.__vaultDebug.openPreview(${JSON.stringify(reg.png)})`);
    await sleep(900);
    const beforeEdit = await snap();
    check('PNG 预览的「编辑」按钮可见', beforeEdit.editHidden === false);
    const editTitle = await ev(`document.querySelector('#btnEdit').title`);
    check('编辑按钮的提示是「编辑图片」', /图片/.test(editTitle || ''), editTitle);

    await click('#btnEdit');
    await waitFor(`!!window.__vaultDebug.imageEditor`);
    const start = await snap();
    check('进入后出现图片编辑器', start.hasEditor === true);
    check('画布尺寸是原图的 200 × 120', start.w === 200 && start.h === 120, `${start.w}×${start.h}`);
    check('保存按钮出现、编辑按钮收起', start.editHidden === true);

    /* ---------- 3. 画笔 ---------- */
    await drag([{ x: 20, y: 30 }, { x: 100, y: 30 }, { x: 180, y: 30 }]);
    const afterBrush = await snap();
    check('画笔画出了一笔（墨迹层有像素）', afterBrush.ink > 0, `${afterBrush.ink} px`);
    check('这一笔记进了操作栈', afterBrush.ops === 1, `ops=${afterBrush.ops}`);

    /* ---------- 4. 撤销 / 重做 ---------- */
    await click('[data-act="undo"]');
    const afterUndo = await snap();
    check('撤销后墨迹层被清空', afterUndo.ink === 0, `${afterUndo.ink} px`);
    check('撤销把这一笔移出了操作栈', afterUndo.ops === 0 && afterUndo.redo === 1,
      `ops=${afterUndo.ops} redo=${afterUndo.redo}`);

    await click('[data-act="redo"]');
    const afterRedo = await snap();
    check('重做后笔画回来了', afterRedo.ink > 0 && afterRedo.ops === 1);

    /* Ctrl+Z / Ctrl+Shift+Z 也要能用 */
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`);
    const keyUndo = await snap();
    check('Ctrl+Z 撤销生效', keyUndo.ops === 0, `ops=${keyUndo.ops}`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`);
    const keyRedo = await snap();
    check('Ctrl+Shift+Z 重做生效', keyRedo.ops === 1, `ops=${keyRedo.ops}`);

    /* ---------- 5. 马赛克 ---------- */
    await click('[data-tool="mosaic"]');
    const inkBeforeMosaic = (await snap()).ink;
    await drag([{ x: 20, y: 90 }, { x: 70, y: 90 }, { x: 110, y: 90 }]);
    const afterMosaic = await snap();
    check('马赛克笔在画布上留下了块', afterMosaic.ink > inkBeforeMosaic,
      `${inkBeforeMosaic} → ${afterMosaic.ink}`);
    check('马赛克笔也进了操作栈', afterMosaic.ops === 2, `ops=${afterMosaic.ops}`);

    /* 只点一下马赛克：应该按格子上色，不能画成画笔那种实心红点 */
    await drag([{ x: 150, y: 60 }]);
    const dot = await ev(`(() => {
      const c = document.querySelector('#ieInk');
      const d = c.getContext('2d').getImageData(150, 60, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    })()`);
    check('马赛克单击是按格子上色，不是画笔色块',
      Math.abs(dot[0] - 229) + Math.abs(dot[1] - 72) + Math.abs(dot[2] - 77) > 30,
      JSON.stringify(dot));
    await click('[data-act="undo"]');

    /* ---------- 6. 橡皮 ---------- */
    await click('[data-tool="eraser"]');
    const regionBefore = await alphaIn(20, 75, 110, 105);
    await drag([{ x: 25, y: 90 }, { x: 105, y: 90 }]);
    const regionAfter = await alphaIn(20, 75, 110, 105);
    check('橡皮擦掉了马赛克', regionAfter < regionBefore, `${regionBefore} → ${regionAfter}`);
    check('橡皮本身也算一步操作', (await snap()).ops === 3);

    /* ---------- 7. 还原 ---------- */
    await click('[data-act="reset"]');
    const afterReset = await snap();
    check('还原后回到原图尺寸且墨迹清空',
      afterReset.ink === 0 && afterReset.w === 200 && afterReset.h === 120 && afterReset.ops === 0,
      `${afterReset.w}×${afterReset.h} ink=${afterReset.ink} ops=${afterReset.ops}`);

    /* ---------- 8. 重新画一遍，准备保存 ---------- */
    await click('[data-tool="brush"]');
    await drag([{ x: 20, y: 30 }, { x: 180, y: 30 }]);
    await click('[data-tool="mosaic"]');
    await drag([{ x: 30, y: 90 }, { x: 120, y: 90 }]);
    check('重新编辑后有两步操作', (await snap()).ops === 2);

    /* ---------- 9. 旋转：不进撤销栈 ---------- */
    await click('[data-act="rotate-right"]');
    const rotated = await snap();
    check('向右旋转后宽高互换（120 × 200）',
      rotated.w === 120 && rotated.h === 200, `${rotated.w}×${rotated.h}`);
    await click('[data-act="undo"]');
    const afterRotateUndo = await snap();
    check('撤销不会撤销旋转（尺寸仍 120 × 200）',
      afterRotateUndo.w === 120 && afterRotateUndo.h === 200,
      `${afterRotateUndo.w}×${afterRotateUndo.h}`);
    check('撤销撤掉的是最后一笔笔画', afterRotateUndo.ops === 2,
      `ops=${afterRotateUndo.ops}`);
    await click('[data-act="redo"]');
    const afterRotateRedo = await snap();
    check('重做把笔画放回、旋转保留',
      afterRotateRedo.ops === 3 && afterRotateRedo.w === 120,
      `ops=${afterRotateRedo.ops} ${afterRotateRedo.w}×${afterRotateRedo.h}`);

    /* ---------- 10. 裁剪：同样不进撤销栈 ---------- */
    await click('[data-tool="crop"]');
    await drag([{ x: 60, y: 100 }, { x: 110, y: 150 }], 4);
    const sel = await snap();
    check('拖出选区后出现「应用裁剪」', sel.cropBar === true);
    await click('[data-act="crop-apply"]');
    const cropped = await snap();
    check('应用裁剪后是 50 × 50', cropped.w === 50 && cropped.h === 50,
      `${cropped.w}×${cropped.h}`);
    check('裁剪后选区条收起', cropped.cropBar === false);
    await click('[data-act="undo"]');
    const afterCropUndo = await snap();
    check('撤销不会撤销裁剪（尺寸仍 50 × 50）',
      afterCropUndo.w === 50 && afterCropUndo.h === 50,
      `${afterCropUndo.w}×${afterCropUndo.h}`);
    check('撤销撤掉的仍是笔画', afterCropUndo.ops === 3, `ops=${afterCropUndo.ops}`);
    await click('[data-act="redo"]');
    const afterCropRedo = await snap();
    check('重做把笔画放回、裁剪保留',
      afterCropRedo.ops === 4 && afterCropRedo.w === 50,
      `ops=${afterCropRedo.ops} ${afterCropRedo.w}×${afterCropRedo.h}`);

    /* ---------- 11. 保存回原文件 ---------- */
    const sizeBefore = fs.statSync(pngPath).size;
    await click('[data-act="save"]');
    const saved = await waitFor(`!window.__vaultDebug.imageEditor
      && !!document.querySelector('#previewBody img')`);
    check('保存后自动退出编辑器', saved === true);

    const onDisk = fs.readFileSync(pngPath);
    const dims = pngSize(onDisk);
    check('磁盘上的原文件还是合法 PNG', !!dims, dims ? `${dims.w}×${dims.h}` : '文件头不对');
    check('原文件被改成裁剪后的 50 × 50',
      !!dims && dims.w === 50 && dims.h === 50, dims ? `${dims.w}×${dims.h}` : '—');
    check('文件内容确实变了（不是空写）', onDisk.length !== ORIG_PNG.length,
      `${ORIG_PNG.length} → ${onDisk.length} 字节`);
    /* 50×50 的图压缩完只有几百字节，阈值只管「不是空文件」 */
    check('重写后文件不是空文件', onDisk.length > 200 && sizeBefore > 0,
      `${onDisk.length} 字节`);

    /* 备份：改之前的旧版本要能找回 */
    const backupDir = path.join(tmpData, 'backups');
    const baks = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((n) => n.startsWith(reg.png))
      : [];
    check('保存前留了备份', baks.length > 0, `${baks.length} 份`);
    if (baks.length) {
      const bakBuf = fs.readFileSync(path.join(backupDir, baks[baks.length - 1]));
      check('备份里是原图（能还原编辑前的版本）', bakBuf.equals(ORIG_PNG));
    }

    /* 预览里显示的也是新图 */
    const shown = await ev(`(() => {
      const img = document.querySelector('#previewBody img');
      return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
    })()`);
    check('预览重新载入后是 50 × 50', !!shown && shown.w === 50 && shown.h === 50,
      shown ? `${shown.w}×${shown.h}` : '没有图片');

    /* 保存后的图里应该还能看到红色画笔（说明墨迹层也写进去了） */
    const redPixels = await ev(`(async () => {
      const img = document.querySelector('#previewBody img');
      if (!img) return -1;
      const blob = await (await fetch(img.src)).blob();
      const url = URL.createObjectURL(blob);
      try {
        const el = new Image();
        await new Promise((r, j) => { el.onload = r; el.onerror = j; el.src = url; });
        const c = document.createElement('canvas');
        c.width = el.naturalWidth; c.height = el.naturalHeight;
        const g = c.getContext('2d');
        g.drawImage(el, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 150 && d[i + 1] < 120 && d[i + 2] < 120) n += 1;
        }
        return n;
      } finally { URL.revokeObjectURL(url); }
    })()`);
    check('保存下来的图里带着画笔颜色（墨迹没丢）', redPixels > 0, `${redPixels} px`);

    /* ---------- 12. 有未保存改动时退出要确认 ---------- */
    await click('#btnEdit');
    await waitFor(`!!window.__vaultDebug.imageEditor`);
    await drag([{ x: 5, y: 5 }, { x: 20, y: 20 }]);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'e', ctrlKey: true, bubbles: true, cancelable: true }))`);
    const confirmShown = await waitFor(`!document.querySelector('#confirmModal').hidden`, 3000);
    check('有未保存改动时按 Ctrl+E 会先确认', confirmShown === true);
    await click('#btnConfirmCancel');
    await waitFor(`document.querySelector('#confirmModal').hidden`, 3000);
    check('取消后仍留在编辑器里', (await snap()).ops === 1);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'e', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(`!document.querySelector('#confirmModal').hidden`, 3000);
    await click('#btnConfirmOk');
    const exited = await waitFor(`!window.__vaultDebug.imageEditor`);
    check('确认放弃后退出编辑器', exited === true);
    check('放弃的改动没有写进磁盘',
      fs.readFileSync(pngPath).length === onDisk.length);

    /* ---------- 13. JPG 走同一条保存链路 ---------- */
    const jpgOrig = fs.readFileSync(jpgPath);
    await ev(`window.__vaultDebug.openPreview(${JSON.stringify(reg.jpg)})`);
    await sleep(900);
    await click('#btnEdit');
    await waitFor(`!!window.__vaultDebug.imageEditor`);
    const jpgStart = await snap();
    check('JPG 也能进图片编辑器', jpgStart.hasEditor === true && jpgStart.w === 60,
      `${jpgStart.w}×${jpgStart.h}`);
    await drag([{ x: 5, y: 5 }, { x: 50, y: 30 }]);
    await click('[data-act="save"]');
    const jpgSaved = await waitFor(`!window.__vaultDebug.imageEditor`);
    check('JPG 保存后退出编辑器', jpgSaved === true);
    const jpgNow = fs.readFileSync(jpgPath);
    check('JPG 原文件被重写且仍是 JPEG 头',
      jpgNow.length > 100 && jpgNow[0] === 0xff && jpgNow[1] === 0xd8 && jpgNow[2] === 0xff,
      `${jpgOrig.length} → ${jpgNow.length} 字节`);
    check('JPG 保存前后的内容不同', !jpgNow.equals(jpgOrig));

    /* ---------- 14. 不支持的格式 ---------- */
    await ev(`window.__vaultDebug.openPreview(${JSON.stringify(reg.gif)})`);
    await sleep(900);
    const gifState = await snap();
    check('GIF 预览不显示编辑入口', gifState.editHidden === true, String(gifState.editHidden));
    check('GIF 编辑器没有被打开', gifState.hasEditor === false);

    const rejected = await ev(`(async () => {
      try {
        await window.vault.files.saveImage(${JSON.stringify(reg.gif)},
          'image/png', new Uint8Array([137, 80, 78, 71]));
        return { ok: true };
      } catch (e) { return { ok: false, msg: e.message }; }
    })()`);
    check('强行把 PNG 字节写进 GIF 会被拒绝', rejected.ok === false, rejected.msg);
    check('被拒绝后 GIF 原文件没被改动', fs.readFileSync(gifPath).equals(GIF_BYTES));
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
