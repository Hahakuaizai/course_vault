/* ============================================================
   文件夹封面 · 渲染层
   ------------------------------------------------------------
   只在「更改封面」和「封面区渲染」两处被现有代码调用，
   不改动任何既有数据结构、主题逻辑或卡片布局。
   ============================================================ */

const api = window.vault;
/** 封面功能唯一的主进程通道，按 op 分发 */
const call = (msg) => api.cover(msg);

/* ---------- 开关与参数 ---------- */
/** 总开关：false 时菜单项不显示、已保存封面被忽略、界面完全回到原样 */
export const ENABLE_FOLDER_COVER = true;
/** 图片封面是否隐藏中间的白色图标方块 */
export const HIDE_ICON_TILE_ON_IMAGE = true;
/** 缩略图宽度上限（150%–200% 缩放下仍然清晰）与 JPEG 质量 */
const THUMB_WIDTH = 960;
const THUMB_QUALITY = 0.85;
/** 解码后的像素上限，防止一张超大图把渲染进程拖垮 */
const MAX_PIXELS = 40 * 1000 * 1000;

/**
 * 预设颜色表：选中的颜色改的是**文件夹图形本身的颜色**（图标填充），
 * 封面区背景、白色图标方块、圆点、文字都不动。
 * id 与 folder-cover.css 里的 [data-fc='...'] 一一对应，
 * 亮色/暗色两套取值写在 CSS 里（同一份文件内，不改现有变量）。
 * 顺序即面板里的显示顺序；第一项「默认」恢复这个目录原来的图标颜色。
 */
export const PRESET_COLORS = [
  { id: 'default', label: '默认', hint: '恢复原来的图标颜色' },
  { id: 'slate', label: '灰蓝' },
  { id: 'coral', label: '橙红' },
  { id: 'blue', label: '蓝' },
  { id: 'green', label: '绿' },
  { id: 'purple', label: '紫' },
  { id: 'pink', label: '粉' },
  { id: 'yellow', label: '黄' },
  { id: 'teal', label: '青' },
];

/* ---------- 状态 ---------- */
/** 文件夹 id → { type: 'color', colorId } | { type: 'image', file } */
let covers = {};
let loaded = false;

/** 缩略图文件名 → blob: URL（同一个文件只取一次、只建一个 URL） */
const thumbUrls = new Map();
const thumbPending = new Map();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/* 系统「显示动画」关闭时 matchMedia 为真；应用内「减少动画」开关走 no-motion 类 */
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  || document.documentElement.classList.contains('no-motion');

/* ---------- 数据 ---------- */
function applyPayload(res) {
  if (!res || typeof res !== 'object') return;
  covers = res.covers && typeof res.covers === 'object' ? res.covers : {};
  loaded = true;
}

/** 启动时读一次。失败当作没有封面，界面照常。 */
const readyPromise = (async () => {
  if (!ENABLE_FOLDER_COVER) return;
  try {
    applyPayload(await call({ op: 'load' }));
  } catch {
    /* 读不到就当作空数据 */
  }
  // 启动时卡片已经画好了，拿到数据后补一次
  const grid = document.getElementById('grid');
  if (grid) applyCovers(grid);
})();

/* ---------- 缩略图 ---------- */
async function getThumbUrl(file) {
  if (thumbUrls.has(file)) return thumbUrls.get(file);
  if (thumbPending.has(file)) return thumbPending.get(file);

  const p = (async () => {
    try {
      const r = await call({ op: 'thumb', file });
      if (!r || !r.data) return null;
      const blob = new Blob([r.data], { type: r.mime || 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      thumbUrls.set(file, url);
      return url;
    } catch {
      return null;
    }
  })().finally(() => thumbPending.delete(file));

  thumbPending.set(file, p);
  return p;
}

function revokeThumb(file) {
  const url = thumbUrls.get(file);
  if (!url) return;
  thumbUrls.delete(file);
  try { URL.revokeObjectURL(url); } catch { /* 忽略 */ }
}

/* ---------- 渲染接入 ---------- */
/** 懒加载观察器：卡片滚进视口才去取缩略图字节，100+ 张也不卡 */
const io = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const img = e.target.querySelector('.fc-img');
      if (img && img.dataset.fcFile) loadInto(img, img.dataset.fcFile, false);
    }
  }, { rootMargin: '200px 0px' })
  : null;

/**
 * 把封面画到卡片上。root 传 #grid，只处理卡片自身，不读任何布局。
 * 没有封面的卡片一个属性都不加 —— 渲染结果与改动前一致。
 */
export function applyCovers(root) {
  if (!ENABLE_FOLDER_COVER || !root || !root.querySelectorAll) return;
  if (!loaded) return;
  // 每次重绘都重置观察列表：旧卡片已经被 innerHTML 丢掉，
  // 不清理的话它们会一直挂在观察器里
  if (io) io.disconnect();
  for (const card of root.querySelectorAll('.dir-card')) {
    const id = card.dataset.dir;
    if (!id) continue;
    const cover = covers[id];
    if (!cover) continue;
    paint(card, cover, false);
  }
}

function paint(card, cover, fade) {
  const thumb = card.querySelector('.dir-thumb');
  if (!thumb) return;

  /* 颜色：只给封面区打 data-fc，CSS 据此换图标填充色。
     背景、白色方块、图标尺寸、圆点、文字全都不碰。 */
  if (cover.type === 'color' && cover.colorId) {
    if (thumb.dataset.fc === cover.colorId) return; // 已经是目标状态，别重复动 DOM
    thumb.dataset.fc = cover.colorId;
    delete thumb.dataset.fcHideIcon;
    const img = thumb.querySelector('.fc-img');
    if (img) img.remove();
    const veil = thumb.querySelector('.fc-veil');
    if (veil) veil.remove();
    return;
  }

  if (cover.type === 'image' && cover.file) {
    thumb.dataset.fc = 'image';
    if (HIDE_ICON_TILE_ON_IMAGE) thumb.dataset.fcHideIcon = '1';
    else delete thumb.dataset.fcHideIcon;

    let img = thumb.querySelector('.fc-img');
    if (!img) {
      img = document.createElement('img');
      img.className = 'fc-img';
      img.alt = '';
      img.decoding = 'async';
      // 绝对定位铺满，插在最前面；图标方块靠 z-index 保持在上面
      thumb.insertBefore(img, thumb.firstChild);
    }
    if (!thumb.querySelector('.fc-veil')) {
      const veil = document.createElement('div');
      veil.className = 'fc-veil';
      thumb.appendChild(veil);
    }

    // 同一张图已经显示好了就什么都不做（重绘网格时不会重复取字节）
    if (!fade && img.dataset.fcFile === cover.file && img.classList.contains('is-loaded')) return;

    if (img.dataset.fcFile !== cover.file) {
      // 换了一张图：先回到未加载态，避免旧图残留
      img.classList.remove('is-loaded');
      img.removeAttribute('src');
      if (fade) img.classList.add('fc-fade');
      else img.classList.remove('fc-fade');
    } else if (fade) {
      img.classList.add('fc-fade');
    }

    img.dataset.fcFile = cover.file;
    if (fade || !io) {
      if (io) io.unobserve(thumb);
      loadInto(img, cover.file, fade);
    } else if (!img.classList.contains('is-loaded')) {
      io.observe(thumb);
    }
  }
}

async function loadInto(img, file, fade) {
  const url = await getThumbUrl(file);
  if (!img.isConnected || img.dataset.fcFile !== file) return;
  if (!url) {
    // 缩略图读不到（文件被手动删了）：退回原背景，不留描边和遮罩
    const thumb = img.parentElement;
    if (thumb) {
      delete thumb.dataset.fc;
      delete thumb.dataset.fcHideIcon;
    }
    img.remove();
    const veil = thumb?.querySelector('.fc-veil');
    if (veil) veil.remove();
    return;
  }
  // 系统关闭动画时不播淡入，直接显示
  if (fade && reduceMotion()) img.classList.remove('fc-fade');
  img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
  img.addEventListener('error', () => img.classList.remove('is-loaded'), { once: true });

  /* 要淡入时先把 opacity:0 这一帧真的提交一次，
   * 否则浏览器可能把「0 → 1」合并到同一帧里，看不出淡入。
   * 只读一次布局，不在循环里。 */
  if (img.classList.contains('fc-fade')) void img.offsetWidth;
  img.src = url;
}

/** 只更新一张卡片（不重绘整个网格） */
function updateCard(id, fade) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const card = grid.querySelector(`.dir-card[data-dir="${CSS.escape(id)}"]`);
  if (!card) return;
  const cover = covers[id];
  if (!cover) {
    clearCard(card);
    return;
  }
  paint(card, cover, fade);
}

/** 移除封面后把卡片还原成原始外观 */
function clearCard(card) {
  const thumb = card.querySelector('.dir-thumb');
  if (!thumb) return;
  delete thumb.dataset.fc;
  delete thumb.dataset.fcHideIcon;
  const img = thumb.querySelector('.fc-img');
  if (img) img.remove();
  const veil = thumb.querySelector('.fc-veil');
  if (veil) veil.remove();
}

/* ---------- 面板 ---------- */
let panel = null;
let panelId = null;
let panelReturnFocus = null;

const ACTION_ICON_IMAGE = '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3.5 3.5 2.5-2.5L20 17"/></svg>';
const ACTION_ICON_REMOVE = '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12"/></svg>';

export function closeCoverPanel({ restoreFocus = true } = {}) {
  if (!panel) return;
  panel.remove();
  panel = null;
  const card = panelReturnFocus;
  panelReturnFocus = null;
  panelId = null;
  if (restoreFocus && card && card.isConnected) {
    try { card.focus({ preventScroll: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 在菜单旁锚定一个面板（现有菜单组件不支持子面板，这里不重写它）。
 * x/y 是右键时的坐标，靠近屏幕边缘会翻转/夹回视口。
 */
export function openCoverPanel(id, x, y) {
  if (!ENABLE_FOLDER_COVER) return;
  closeCoverPanel({ restoreFocus: false });
  panelId = id;

  const card = document.querySelector(`.dir-card[data-dir="${CSS.escape(id)}"]`);
  panelReturnFocus = card || document.activeElement;

  const cur = covers[id];
  const curColor = cur && cur.type === 'color' ? cur.colorId : (cur ? null : 'default');
  const hasCustom = !!cur;

  const el = document.createElement('div');
  el.className = 'fc-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '更改封面');
  el.innerHTML = `
    <div class="fc-title">文件夹颜色</div>
    <div class="fc-swatches" role="radiogroup" aria-label="文件夹颜色">
      ${PRESET_COLORS.map((c) => `
        <button class="fc-swatch" data-color="${c.id}" role="radio"
                aria-checked="${curColor === c.id ? 'true' : 'false'}"
                tabindex="${curColor === c.id || (!curColor && c.id === 'default') ? '0' : '-1'}"
                title="${escapeHtml(c.hint ? `${c.label}（${c.hint}）` : c.label)}"
                aria-label="${escapeHtml(c.label)}"></button>
      `).join('')}
    </div>
    <div class="fc-sep"></div>
    <button class="fc-action" data-act="pick">${ACTION_ICON_IMAGE}<span>用图片当封面…</span></button>
    ${hasCustom ? `<button class="fc-action" data-act="remove">${ACTION_ICON_REMOVE}<span>移除自定义封面</span></button>` : ''}
    <div class="fc-note" hidden></div>
  `;

  document.body.appendChild(el);
  panel = el;

  // 定位：先量再夹，放不下就翻到鼠标另一侧
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x + 4;
  if (left + w > vw - 8) left = x - w - 4;
  left = Math.max(8, Math.min(left, vw - w - 8));
  let top = y + 4;
  if (top + h > vh - 8) top = y - h - 4;
  top = Math.max(8, Math.min(top, vh - h - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const note = (msg) => {
    const n = el.querySelector('.fc-note');
    n.textContent = msg || '';
    n.hidden = !msg;
  };

  /* 色块是单选组：点选后立即生效并关闭面板。
     事件挂在容器上，用 closest 找目标，避免给每个色块单独绑。 */
  el.querySelector('.fc-swatches').addEventListener('click', async (e) => {
    const sw = e.target.closest('.fc-swatch');
    if (!sw) return;
    await pickColor(id, sw.dataset.color, el, note);
  });

  /* --- 图片 / 移除 --- */
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('.fc-action');
    if (!btn) return;
    if (btn.dataset.act === 'pick') await pickImage(id, btn, el, note);
    else if (btn.dataset.act === 'remove') await removeCover(id, el, note);
  });

  /* --- 键盘：方向键在色块间移动，Esc 关闭 --- */
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCoverPanel();
      return;
    }
    const sws = [...el.querySelectorAll('.fc-swatch')];
    const i = sws.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = 5;
    let next = -1;
    if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'ArrowDown') next = i + cols;
    else if (e.key === 'ArrowUp') next = i - cols;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = sws.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = sws[Math.max(0, Math.min(sws.length - 1, next))];
    sws.forEach((s) => { s.tabIndex = s === target ? 0 : -1; });
    target.focus();
  });

  const active = el.querySelector('.fc-swatch[aria-checked="true"]')
    || el.querySelector('.fc-swatch');
  if (active) active.focus({ preventScroll: true });
}

/* ---------- 动作 ---------- */
async function pickColor(id, colorId, el, note) {
  try {
    note('');
    applyPayload(await call({ op: 'setColor', id, colorId }));
    const prev = el.querySelector('.fc-swatch[data-color]');
    el.querySelectorAll('.fc-swatch').forEach((s) => {
      s.setAttribute('aria-checked', s.dataset.color === colorId ? 'true' : 'false');
      s.tabIndex = s.dataset.color === colorId ? 0 : -1;
    });
    if (prev) prev.blur();
    // 颜色不需要淡入（淡入只给图片），主题切换也不受影响
    updateCard(id, false);
    closeCoverPanel();
  } catch (err) {
    note(err?.message || '设置失败');
  }
}

async function removeCover(id, el, note) {
  try {
    note('');
    const prev = covers[id];
    applyPayload(await call({ op: 'remove', id }));
    if (prev?.type === 'image') revokeThumb(prev.file);
    updateCard(id, false);
    closeCoverPanel();
  } catch (err) {
    note(err?.message || '移除失败');
  }
}

async function pickImage(id, btn, el, note) {
  const label = btn.querySelector('span');
  const text = label.textContent;
  btn.disabled = true;
  try {
    note('');
    const picked = await call({ op: 'pickImage', id });
    if (!picked || picked.canceled) return;

    label.textContent = '正在处理…';
    const jpeg = await toThumbJpeg(picked.data);

    const prev = covers[id];
    applyPayload(await call({ op: 'saveImage', id, data: jpeg }));
    if (prev?.type === 'image') revokeThumb(prev.file);

    updateCard(id, true); // 只有这一张淡入
    closeCoverPanel();
  } catch (err) {
    note(err?.message || '这张图片处理失败');
    label.textContent = text;
    btn.disabled = false;
  }
}

/* ---------- 图片处理（异步，不阻塞 UI） ---------- */
async function toThumbJpeg(bytes) {
  if (!bytes || !bytes.byteLength) throw new Error('这张图片是空的');

  let bmp;
  try {
    // imageOrientation: 'from-image' 按 EXIF 方向转正；重新编码后 EXIF 自然丢掉
    bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' });
  } catch {
    throw new Error('这张图片无法解码，可能已损坏或格式不受支持');
  }

  try {
    const sw = bmp.width;
    const sh = bmp.height;
    if (!sw || !sh) throw new Error('这张图片无法解码，可能已损坏');
    if (sw * sh > MAX_PIXELS) throw new Error('图片像素过大，请换一张小一点的');

    const w = Math.min(THUMB_WIDTH, sw);
    const h = Math.max(1, Math.round((sh * w) / sw));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片处理失败');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // 白底：源图带透明通道时转 JPEG 不会变黑
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY));
    if (!blob) throw new Error('图片处理失败');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    if (typeof bmp.close === 'function') bmp.close();
  }
}

/* ---------- 关闭时机 ---------- */
document.addEventListener('click', (e) => {
  if (!panel) return;
  if (panel.contains(e.target)) return;
  // 刚打开面板的那次点击不要立刻关掉
  if (e.target.closest?.('.fc-panel')) return;
  closeCoverPanel();
}, true);

document.addEventListener('scroll', (e) => {
  if (!panel) return;
  if (panel.contains(e.target)) return;
  closeCoverPanel();
}, true);

window.addEventListener('blur', () => {
  if (panel) closeCoverPanel({ restoreFocus: false });
});

window.addEventListener('resize', () => {
  if (panel) closeCoverPanel({ restoreFocus: false });
});

export { readyPromise };
