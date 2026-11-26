/* ============================================================
   桌宠「桌面模式」的自绘菜单（pet-menu.js）
   跑在 pet-main.js 开的无边框透明小窗口里，替代系统原生菜单：
   原生菜单做不了悬停预览，也塞不下大小滑块。这里的菜单结构
   和样式（pet.css 的 .cv-pet-menu）与软件内右键菜单同款，
   悬停动态预览、自定义大小滑块都在窗口内完成；选择经
   pet:menu-action 回主进程执行（播放动作发给舞台窗口，
   换宠/大小/设置等转发给主窗口）。
   窗口尺寸由主进程按工作区给足（560×600 上限），菜单根落在
   右键点上，子菜单和预览都在窗口内摆位，不会溢出屏幕。
   ============================================================ */
(() => {
  'use strict';

  const pet = (window.vault && window.vault.pet) || null;

  let data = null;
  let menuEl = null;
  let sizePop = null;
  let hoverEl = null;
  let hoverStop = null;
  let customBlobURL = null;

  /* ---------------- 与 pet.js / pet-stage.js 同构的小工具 ---------------- */

  function frameList(anim, img) {
    if (Array.isArray(anim.frames) && anim.frames.length) return anim.frames;
    if (anim.count) return Array.from({ length: anim.count }, (_, i) => ({ i, ms: anim.ms || 140 }));
    const rows = img && img.naturalHeight ? Math.max(1, Math.round(img.naturalHeight / anim.frameH)) : 1;
    const n = (anim.cols || 1) * rows;
    return Array.from({ length: n }, (_, i) => ({ i, ms: 140 }));
  }

  /* 按角色内容框裁剪缩放的 idle 预览（与 pet.js 的 startPreview 同规则） */
  /* 预览该播哪个动画：与 pet.js 的 pickPreviewAnim 同规则
     （idle 太静时换帧数多的动作展示，如克码人生） */
  function pickPreviewAnim(pk) {
    const anims = (pk && pk.animations) || {};
    const idle = anims.idle;
    if (!idle) return null;
    const stats = (a) => {
      const frames = Array.isArray(a.frames) && a.frames.length ? a.frames : null;
      return {
        n: frames ? frames.length : (a.count || 1),
        maxHold: frames ? Math.max(...frames.map((f) => f.ms || 120)) : (a.ms || 140),
      };
    };
    const si = stats(idle);
    if (si.n >= 3 && si.maxHold <= 1500) return { anim: idle, capMs: 0 };
    const GAG = /error|detached|banned|sleep|dead|fail|bug/i;
    let best = null;
    let bestN = 0;
    for (const [name, a] of Object.entries(anims)) {
      if (GAG.test(name)) continue;
      const s = stats(a);
      if (s.n >= 6 && s.maxHold <= 800 && s.n > bestN) { best = a; bestN = s.n; }
    }
    if (best) return { anim: best, capMs: 0 };
    return { anim: idle, capMs: 450 };
  }

  function startPreview(cv, pk, urlFor, fit, onSized) {
    const pick = pickPreviewAnim(pk);
    if (!pick) return () => {};
    const anim = pick.anim;
    if (!anim) return () => {};
    const targetH = (fit && fit.h) || 104;
    const maxW = (fit && fit.w) || 128;
    const img = new Image();
    let timer = 0;
    let stopped = false;
    img.onload = () => {
      if (stopped) return;
      const frames = frameList(anim, img).map((f) => (
        pick.capMs && (f.ms || 120) > pick.capMs ? { ...f, ms: pick.capMs } : f
      ));
      const scale = pk.scale || 1;
      const fwL = anim.frameW / scale;
      const fhL = anim.frameH / scale;
      let crop = { x: 0, y: 0, w: fwL, h: fhL };
      const cb = pk.previewBox || pk.contentBox;
      if (cb && cb.w > 0 && cb.h > 0 && cb.x >= 0 && cb.y >= 0
        && cb.x + cb.w <= fwL + 0.5 && cb.y + cb.h <= fhL + 0.5) {
        crop = { x: cb.x, y: cb.y, w: cb.w, h: cb.h };
      }
      const k = Math.min(
        targetH / Math.max(1, crop.h * scale),
        maxW / Math.max(1, crop.w * scale),
      );
      cv.width = Math.max(1, Math.round(crop.w * scale));
      cv.height = Math.max(1, Math.round(crop.h * scale));
      cv.style.width = Math.round(crop.w * scale * k) + 'px';
      cv.style.height = Math.round(crop.h * scale * k) + 'px';
      const c2 = cv.getContext('2d');
      const cols = anim.cols || 1;
      let idx = 0;
      const tick = () => {
        if (stopped) return;
        const f = frames[idx];
        const fx = (f.i % cols) * anim.frameW + crop.x * scale;
        const fy = Math.floor(f.i / cols) * anim.frameH + crop.y * scale;
        c2.clearRect(0, 0, cv.width, cv.height);
        c2.drawImage(img, fx, fy, crop.w * scale, crop.h * scale, 0, 0, cv.width, cv.height);
        idx = (idx + 1) % frames.length;
        timer = setTimeout(tick, Math.max(40, f.ms || 120));
      };
      tick();
      if (onSized) onSized();
    };
    img.src = urlFor(anim.sheet);
    return () => { stopped = true; clearTimeout(timer); };
  }

  /* ---------------- 菜单骨架（与 pet.js 同构） ---------------- */

  function menuItem(label, opts = {}) {
    const el = document.createElement('div');
    el.className = 'mi' + (opts.sub ? ' has-sub' : '') + (opts.tick ? ' is-on' : '');
    const l = document.createElement('span');
    l.textContent = label;
    el.appendChild(l);
    if (opts.sub) {
      const a = document.createElement('span');
      a.className = 'arrow';
      a.textContent = '▸';
      el.appendChild(a);
      el.appendChild(opts.sub);
    } else {
      const t = document.createElement('span');
      t.className = 'tick';
      t.textContent = '✓';
      el.appendChild(t);
      if (opts.onClick) el.addEventListener('click', () => opts.onClick(el));
    }
    return el;
  }

  function subMenu(flat) {
    const s = document.createElement('div');
    s.className = 'sub' + (flat ? ' flat' : '');
    return s;
  }

  function sep() {
    const s = document.createElement('div');
    s.className = 'sep';
    return s;
  }

  /* ---------- 级联子菜单的收起时机 ----------
   *
   * 与 pet.js 的 SUB_GRACE 同一套规则：斜着往子菜单移动时不能半路收
   * （「还没移过去就没了」），指针真的走开又要立刻收（「移走后几秒
   * 才消失」）。判定用「安全三角形」——父项右缘中点为顶点、子菜单
   * 左侧上下角为底边；指针在父项/子菜单/三角形里就一直保持，出了
   * 安全区 220ms 后收。挂在 document 的 pointermove 上，指针停在
   * 空白处不动时那次 move 已启动倒计时，不会挂着不走。
   */
  const SUB_GRACE = 220;

  function pointInRect(x, y, r, pad = 0) {
    return x >= r.left - pad && x <= r.right + pad
      && y >= r.top - pad && y <= r.bottom + pad;
  }

  function pointInTriangle(px, py, a, b, c) {
    const d1 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
    const d2 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
    const d3 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  /** 指针是否还在「父项 → 子菜单」这条必经之路上 */
  function inSubSafeZone(mi, x, y) {
    const sub = mi.querySelector(':scope > .sub');
    if (!sub) return false;
    const b = mi.getBoundingClientRect();
    if (pointInRect(x, y, b, 4)) return true;
    /* 孙菜单是固定定位、挂在子菜单外面，逐层检查所有已展开的子孙面板 */
    const panels = sub.querySelectorAll(':scope .sub');
    for (const p of panels) {
      if (p.classList.contains('positioned') && pointInRect(x, y, p.getBoundingClientRect(), 2)) return true;
    }
    const s = sub.getBoundingClientRect();
    if (pointInRect(x, y, s, 2)) return true;
    const onRight = s.left >= b.right - 12;
    /* 父项和子菜单之间的竖直通道（子菜单贴紧时三角形会退化） */
    const gapL = onRight ? b.right - 2 : s.right;
    const gapR = onRight ? s.left + 2 : b.left + 2;
    if (gapR > gapL && x >= gapL && x <= gapR
      && y >= Math.min(b.top, s.top) - 4 && y <= Math.max(b.bottom, s.bottom) + 4) return true;
    const apex = { x: onRight ? b.right : b.left, y: b.top + b.height / 2 };
    const cornerX = onRight ? s.left : s.right;
    return pointInTriangle(x, y, apex, { x: cornerX, y: s.top }, { x: cornerX, y: s.bottom });
  }

  /** 收起某一层里展开中的子菜单 */
  function closeSubIn(parent) {
    clearTimeout(parent._petSubTimer);
    parent._petSubTimer = 0;
    parent.querySelectorAll(':scope > .mi.has-sub.sub-open').forEach((o) => {
      o.classList.remove('sub-open');
      o.querySelectorAll('.sub-open').forEach((d) => d.classList.remove('sub-open'));
    });
  }

  let subAutoCloseInstalled = false;
  function installSubAutoClose() {
    if (subAutoCloseInstalled) return;
    subAutoCloseInstalled = true;
    document.addEventListener('pointermove', (e) => {
      const open = document.querySelectorAll('.cv-pet-menu .mi.has-sub.sub-open');
      if (!open.length) return;
      const x = e.clientX;
      const y = e.clientY;
      open.forEach((mi) => {
        const parent = mi.parentElement;
        if (inSubSafeZone(mi, x, y)) {
          clearTimeout(parent._petSubTimer);
          parent._petSubTimer = 0;
        } else if (!parent._petSubTimer) {
          parent._petSubTimer = setTimeout(() => closeSubIn(parent), SUB_GRACE);
        }
      });
    }, { passive: true });
  }

  /* 子菜单展开/收起与摆位：与 pet.js 的 wireSubMenus 同规则
     （JS 控制显隐 + 安全三角形判定；子菜单固定定位、先向右放不下
     翻左、翻左会压住祖先菜单就贴视口边缘，绝不移动已开菜单） */
  function wireSubMenus(root) {
    installSubAutoClose();
    const placeSub = (mi, sub) => {
      if (!sub) return;
      sub.classList.add('positioned');
      const vw = window.innerWidth, vh = window.innerHeight;
      const pr = mi.getBoundingClientRect();
      const w = sub.offsetWidth, h = sub.offsetHeight;
      let x = pr.right - 2;
      if (x + w > vw - 4) {
        const flipped = pr.left - w + 2;
        let hits = false;
        let node = mi.parentElement, parentSkipped = false;
        while (node && !hits) {
          const isMenu = node === root || (node.classList && node.classList.contains('sub'));
          if (isMenu) {
            if (!parentSkipped) parentSkipped = true;
            else {
              const r = node.getBoundingClientRect();
              if (flipped < r.right - 4 && flipped + w > r.left + 4) hits = true;
            }
            if (node === root) break;
          }
          node = node.parentElement;
        }
        x = (!hits && flipped >= 4) ? flipped
          : ((pr.left + pr.right) / 2 > vw / 2 ? vw - 4 - w : 4);
      }
      x = Math.max(4, Math.min(x, Math.max(4, vw - 4 - w)));
      let y = pr.top - 5;
      if (y + h > vh - 4) y = vh - 4 - h;
      if (y < 4) y = 4;
      sub.style.left = x + 'px';
      sub.style.top = y + 'px';
    };
    root.querySelectorAll('.mi.has-sub').forEach((mi) => {
      const parent = mi.parentElement;
      mi.addEventListener('pointerenter', () => {
        clearTimeout(parent._petSubTimer);
        parent._petSubTimer = 0;
        parent.querySelectorAll(':scope > .mi.has-sub.sub-open').forEach((o) => {
          if (o !== mi) {
            o.classList.remove('sub-open');
            o.querySelectorAll('.sub-open').forEach((d) => d.classList.remove('sub-open'));
          }
        });
        mi.classList.add('sub-open');
        placeSub(mi, mi.querySelector(':scope > .sub'));
      });
      /* 离开父项不直接倒计时 —— 指针可能是斜着去子菜单，交给全局
         pointermove 的安全三角形判定（见 SUB_GRACE 处）。 */
    });
    /* 普通条目也不单独收起：指针移出安全区后由全局 pointermove
       统一倒计时。 */
  }

  /* ---------------- 悬停动态预览 ---------------- */

  function hideHover() {
    if (hoverStop) { try { hoverStop(); } catch { /* 已停 */ } hoverStop = null; }
    if (hoverEl) { hoverEl.remove(); hoverEl = null; }
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 预览摆位：与 pet.js 的 placeHoverPanel 同规则 —— 候选位置
     依次试子菜单右/左、菜单簇右/左、菜单簇下/上，第一个完整
     落在窗口内且不和任何已打开菜单重叠的胜出。 */
  function placeHoverPanel(el, anchorEl) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rects = [];
    document.querySelectorAll('.cv-pet-menu').forEach((n) => rects.push(n.getBoundingClientRect()));
    document.querySelectorAll('.cv-pet-menu .mi.sub-open > .sub').forEach((n) => rects.push(n.getBoundingClientRect()));
    if (!rects.length) rects.push(anchorEl.getBoundingClientRect());
    const ir = anchorEl.getBoundingClientRect();
    const sub = anchorEl.closest('.sub');
    const sr = (sub || anchorEl).getBoundingClientRect();
    const bx = Math.min(...rects.map((r) => r.left));
    const bxx = Math.max(...rects.map((r) => r.right));
    const by = Math.min(...rects.map((r) => r.top));
    const byy = Math.max(...rects.map((r) => r.bottom));
    const yItem = Math.min(Math.max(4, ir.top - 6), Math.max(4, vh - 4 - h));
    const xSub = Math.min(Math.max(4, sr.left), Math.max(4, vw - 4 - w));
    const candidates = [
      { x: sr.right + 8, y: yItem },
      { x: sr.left - w - 8, y: yItem },
      { x: bxx + 8, y: yItem },
      { x: bx - w - 8, y: yItem },
      { x: xSub, y: byy + 8 },
      { x: xSub, y: by - h - 8 },
    ];
    const overlap = (x, y) => rects.reduce((acc, r) => {
      const ox = Math.max(0, Math.min(x + w, r.right) - Math.max(x, r.left));
      const oy = Math.max(0, Math.min(y + h, r.bottom) - Math.max(y, r.top));
      return acc + ox * oy;
    }, 0);
    const inView = (x, y) => x >= 4 && y >= 4 && x + w <= vw - 4 && y + h <= vh - 4;
    let best = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      if (inView(c.x, c.y) && overlap(c.x, c.y) === 0) { best = c; break; }
      let score = overlap(c.x, c.y);
      if (!inView(c.x, c.y)) score += 1000000;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    el.style.left = Math.min(Math.max(4, best.x), Math.max(4, vw - 4 - w)) + 'px';
    el.style.top = Math.min(Math.max(4, best.y), Math.max(4, vh - 4 - h)) + 'px';
    el.classList.add('is-placed');
  }

  function showHover(petId, anchorEl) {
    hideHover();
    if (petId === 'none' || !data) return;
    let pk = null;
    let urlFor = null;
    /* 自定义桌宠的 id 是 'custom:<id>' 形式（可以有多只）。
       外部窗口读不到 IndexedDB，所以当前那只的 idle 精灵图由主进程
       随菜单数据一起送过来（customPreview）。 */
    if (typeof petId === 'string' && petId.startsWith('custom:')) {
      const cp = data.customPreview;
      if (!cp || !cp.manifest || petId !== data.pet) return;
      pk = cp.manifest;
      if (customBlobURL) URL.revokeObjectURL(customBlobURL);
      customBlobURL = URL.createObjectURL(new Blob([b64ToBytes(cp.b64)], { type: 'image/webp' }));
      urlFor = () => customBlobURL;
    } else {
      pk = (window.CVPacks || {})[petId];
      if (!pk) return;
      urlFor = (n) => 'pets/' + petId + '/' + n;
    }
    const el = document.createElement('div');
    el.className = 'cv-pet-hoverprev';
    const cv = document.createElement('canvas');
    el.appendChild(cv);
    document.body.appendChild(el);
    hoverEl = el;
    hoverStop = startPreview(cv, pk, urlFor, { h: 104, w: 128 }, () => {
      if (hoverEl !== el) return;
      placeHoverPanel(el, anchorEl);
    });
  }

  /* ---------------- 自定义大小滑块（窗口内浮层） ---------------- */

  function closeSizePop() {
    if (!sizePop) return;
    sizePop.remove();
    sizePop = null;
  }

  function showSizePop(anchorEl) {
    closeSizePop();
    if (!data) return;
    sizePop = document.createElement('div');
    sizePop.className = 'cv-pet-sizepop';
    const label = document.createElement('div');
    label.className = 'cv-pet-sizepop-label';
    label.textContent = '桌宠大小（拖动即时生效）';
    sizePop.appendChild(label);
    const row = document.createElement('div');
    row.className = 'cv-pet-sizepop-row';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '40';
    range.max = '420';
    range.step = '2';
    range.value = String(data.sizePx || 92);
    const val = document.createElement('span');
    val.className = 'cv-pet-sizepop-val';
    val.textContent = range.value + 'px';
    let lastSent = 0;
    range.addEventListener('input', () => {
      data.sizePx = Number(range.value) || 92;
      val.textContent = range.value + 'px';
      const now = Date.now();
      if (now - lastSent > 40 && pet) {
        lastSent = now;
        pet.menuAction({ type: 'setSizePx', px: data.sizePx });
      }
    });
    range.addEventListener('change', () => {
      if (pet) pet.menuAction({ type: 'setSizePx', px: data.sizePx });
    });
    row.appendChild(range);
    row.appendChild(val);
    sizePop.appendChild(row);
    document.body.appendChild(sizePop);
    const mr = menuEl.getBoundingClientRect();
    const w = sizePop.offsetWidth;
    const h = sizePop.offsetHeight;
    let x = mr.right + 8;
    if (x + w > window.innerWidth - 4) x = mr.left - w - 8;
    x = Math.max(4, Math.min(x, Math.max(4, window.innerWidth - w - 4)));
    const ir = anchorEl.getBoundingClientRect();
    const y = Math.min(Math.max(4, ir.top - 10), Math.max(4, window.innerHeight - h - 4));
    sizePop.style.left = x + 'px';
    sizePop.style.top = y + 'px';
    range.focus();
  }

  /* ---------------- 渲染 ---------------- */

  function render(payload) {
    data = payload || {};
    if (data.theme) document.documentElement.setAttribute('data-theme', data.theme);
    hideHover();
    closeSizePop();
    if (menuEl) { menuEl.remove(); menuEl = null; }
    const model = data.model || {};
    menuEl = document.createElement('div');
    menuEl.className = 'cv-pet-menu' + (data.flip ? ' flip' : '');
    const head = document.createElement('div');
    head.className = 'mhead';
    const cur = (model.pets || []).find((p) => p.tick);
    head.textContent = cur ? cur.label : (data.customName || '桌宠');    menuEl.appendChild(head);

    const groups = (model.groups || []).filter((g) => (g.items || []).length);
    if (groups.length) {
      const actRoot = subMenu(true);
      for (const g of groups) {
        const gSub = subMenu(false);
        for (const it of g.items) {
          gSub.appendChild(menuItem(it.label, {
            onClick: () => { if (pet) pet.menuAction({ type: 'play', id: it.id }); },
          }));
        }
        actRoot.appendChild(menuItem(g.label, { sub: gSub }));
      }
      menuEl.appendChild(menuItem('播放动作', { sub: actRoot }));
      menuEl.appendChild(sep());
    }

    const petSub = subMenu(false);
    for (const p of model.pets || []) {
      const it = menuItem(p.label, {
        tick: p.tick,
        onClick: () => { if (pet) pet.menuAction({ type: 'setPet', id: p.id }); },
      });
      it.addEventListener('pointerenter', () => showHover(p.id, it));
      it.addEventListener('pointerleave', hideHover);
      petSub.appendChild(it);
    }
    petSub.appendChild(sep());
    petSub.appendChild(menuItem('不显示', {
      tick: data.pet === 'none',
      onClick: () => { if (pet) pet.menuAction({ type: 'setPet', id: 'none' }); },
    }));
    menuEl.appendChild(menuItem('更换宠物', { sub: petSub }));

    const sizeSub = subMenu(false);
    for (const s of model.sizes || []) {
      if (s.key === 'custom') {
        sizeSub.appendChild(menuItem(s.label, {
          tick: s.tick,
          onClick: (el) => {
            if (pet) pet.menuAction({ type: 'setSize', key: 'custom' });
            showSizePop(el);
          },
        }));
      } else {
        sizeSub.appendChild(menuItem(s.label, {
          tick: s.tick,
          onClick: () => { if (pet) pet.menuAction({ type: 'setSize', key: s.key }); },
        }));
      }
    }
    menuEl.appendChild(menuItem('桌宠大小', { sub: sizeSub }));
    menuEl.appendChild(sep());
    menuEl.appendChild(menuItem('打开桌宠设置', {
      onClick: () => { if (pet) pet.menuAction({ type: 'openSettings' }); },
    }));
    menuEl.appendChild(menuItem('切回软件内显示', {
      onClick: () => { if (pet) pet.menuAction({ type: 'dock' }); },
    }));
    menuEl.appendChild(menuItem('隐藏桌宠', {
      onClick: () => { if (pet) pet.menuAction({ type: 'hide' }); },
    }));
    document.body.appendChild(menuEl);

    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    const ax = (data.anchorInWin && data.anchorInWin.x) || 8;
    const ay = (data.anchorInWin && data.anchorInWin.y) || 8;
    let left = data.flip ? ax - mw : ax;
    left = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - mw - 4));
    const top = Math.min(Math.max(4, ay), Math.max(4, window.innerHeight - mh - 4));
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
    wireSubMenus(menuEl);
  }

  /* 点菜单外（窗口内的透明区域）或按 Esc 关闭 */
  document.addEventListener('pointerdown', (e) => {
    if (menuEl && menuEl.contains(e.target)) return;
    if (sizePop && sizePop.contains(e.target)) return;
    if (pet) pet.menuClose();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pet) pet.menuClose();
  });

  if (pet && pet.onMenuOpen) pet.onMenuOpen(render);
})();
