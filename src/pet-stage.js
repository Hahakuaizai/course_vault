/* ============================================================
   桌宠「桌面模式」的舞台脚本（pet-stage.js）
   跑在 pet-main.js 开的透明置顶小窗口里，逻辑和主窗口 pet.js
   的播放器同构（帧播放、待机看门狗、点击/拖动反应），区别是：
   - 配置由主窗口经主进程转发过来（pet:config），自己不存设置；
   - 拖动改成把位移发给主进程挪窗口，位置由主进程落盘；
   - 右键把菜单模型发给主进程，弹系统原生菜单（窗口太小，
     HTML 菜单弹不下），选中动作再由主进程发回来播。
   ============================================================ */
(() => {
  'use strict';

  const BUILTINS = [
    { id: 'whale-girl', label: '鲸娘' },
    { id: 'deepy', label: '像素鲸鱼' },
    { id: 'clawd', label: '克码人生' },
    { id: 'kunkun', label: '坤坤' },
    { id: 'maid', label: '蓝发小女仆' },
  ];
  const SIZE_PRESETS = { small: 64, medium: 92, large: 128 };
  const ANIM_LABELS = {
    idle: '待机', 'idle-look': '东张西望', 'idle-peck': '啄一啄', 'idle-spout': '喷水',
    thinking: '思考', typing: '打字', building: '建造', conducting: '指挥',
    compacting: '整理压缩', carrying: '搬东西', notification: '提醒', passed: '搞定',
    happy: '开心', error: '出错了', sleeping: '睡觉', waking: '醒来',
    'roam-hop': '蹦跶', swim: '游泳', basketball: '打篮球',
    'react-left': '戳左边', 'react-right': '戳右边', 'react-double': '连着戳',
    'react-drag': '被拎起来', drag: '被拎起来', tickle: '挠痒痒',
    coffee: '喝咖啡', music: '听音乐', reading: '看书',
    'smile-hearts': '冒爱心', 'thumbs-up': '竖大拇指',
    'poke-left': '戳左边', 'poke-right': '戳右边',
    todo: '列清单', team2: '双人小队', team3: '三人小队', subagents: '放分身',
    lgtm: '点赞', proceed: '继续', compact: '压缩', clone: '克隆',
    sleep: '睡觉', wake: '醒来', roam: '散步', hello: '打招呼', right: '向右看',
    rmrf: '挠痒痒', detached_long: '发呆', banned_long: '被禁言', notfound: '找不到',
    ultrathink: '深度思考', plan: '做计划', simple: '简单模式', bug: '抓虫子',
    loop: '循环', deadline: '赶截止日', fish: '摸鱼', duck: '看鸭子', works: '干活',
    blame: '甩锅', deploy: '部署', overtime: '加班', offwork: '下班', leak: '漏水',
    overflow: '溢出', cherry: '吃樱桃', esc: '逃跑', forcepush: '强推代码',
    stash: '暂存', clear: '清空', bye_long: '告别',
  };
  const STATE_ORDER = ['idle', 'thinking', 'working', 'juggling', 'sweeping', 'carrying',
    'notification', 'attention', 'error', 'sleeping', 'waking', 'roam'];
  const STATE_LABELS = {
    idle: '待机', thinking: '思考', working: '工作', juggling: '忙碌', sweeping: '打扫',
    carrying: '搬运', notification: '提醒', attention: '完成', error: '出错',
    sleeping: '睡觉', waking: '醒来', roam: '散步',
  };

  const pet = (window.vault && window.vault.pet) || null;
  const canvas = document.querySelector('#petCv');
  const ctx = canvas.getContext('2d');

  let cfg = { pet: 'kunkun', size: 'medium', sizePx: 92, customName: '', custom: null };
  let pack = null;
  let sheetURL = null;
  let images = new Map();
  let blobURLs = [];
  let cur = null;
  let dragging = false;
  let lastWinSize = '';

  function targetH() {
    if (cfg.size === 'custom') return Math.min(200, Math.max(40, cfg.sizePx || 92));
    return SIZE_PRESETS[cfg.size] || 92;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- 播放器（与 pet.js 同构） ---------------- */

  function loadSheet(name) {
    let img = images.get(name);
    if (img) return Promise.resolve(img);
    img = new Image();
    images.set(name, img);
    return new Promise((res, rej) => {
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('精灵图加载失败：' + name));
      img.src = sheetURL(name);
    });
  }

  function frameList(anim, img) {
    if (Array.isArray(anim.frames) && anim.frames.length) return anim.frames;
    if (anim.count) return Array.from({ length: anim.count }, (_, i) => ({ i, ms: anim.ms || 140 }));
    const rows = img && img.naturalHeight ? Math.max(1, Math.round(img.naturalHeight / anim.frameH)) : 1;
    const n = (anim.cols || 1) * rows;
    return Array.from({ length: n }, (_, i) => ({ i, ms: 140 }));
  }

  function sizeStage(anim) {
    const box = pack.contentBox || { w: anim.frameW, h: anim.frameH };
    const k = targetH() / Math.max(1, box.h * (pack.scale || 1));
    const w = Math.round(anim.frameW * k);
    const h = Math.round(anim.frameH * k);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const key = w + 'x' + h;
    if (pet && key !== lastWinSize) {
      lastWinSize = key;
      pet.resize(w, h);
    }
  }

  function stopCurrent() {
    if (cur && cur.timer) clearTimeout(cur.timer);
    cur = null;
  }

  function play(name, mode) {
    if (!pack) return;
    if (!pack.animations[name]) {
      if (mode !== 'base') play('idle', 'base');
      return;
    }
    stopCurrent();
    const anim = pack.animations[name];
    const myPack = pack;
    loadSheet(anim.sheet).then((img) => {
      if (!pack || pack !== myPack) return;
      canvas.width = anim.frameW;
      canvas.height = anim.frameH;
      sizeStage(anim);
      cur = { name, anim, frames: frameList(anim, img), idx: 0, cycles: mode === 'base' ? Infinity : 1, timer: 0 };
      step();
      if (mode === 'base' && name === 'idle') scheduleIdle();
    }).catch(() => { if (mode !== 'base') play('idle', 'base'); });
  }

  function step() {
    if (!cur) return;
    const f = cur.frames[cur.idx];
    draw(f.i);
    cur.idx++;
    if (cur.idx >= cur.frames.length) {
      cur.idx = 0;
      if (cur.cycles !== Infinity) {
        cur.cycles--;
        if (cur.cycles <= 0) { play('idle', 'base'); return; }
      }
    }
    cur.timer = setTimeout(step, Math.max(30, f.ms || 120));
  }

  function draw(i) {
    const a = cur.anim;
    const img = images.get(a.sheet);
    if (!img) return;
    const cols = a.cols || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, (i % cols) * a.frameW, Math.floor(i / cols) * a.frameH,
      a.frameW, a.frameH, 0, 0, a.frameW, a.frameH);
  }

  function isIdleNow() {
    return !!cur && cur.name === 'idle';
  }

  /* ---------------- 待机随机动作（看门狗，与 pet.js 同构） ---------------- */

  let nextIdleAt = 0;
  let idleWatcher = 0;

  function armIdle(delay) { nextIdleAt = Date.now() + delay; }

  function scheduleIdle() {
    if (!idleWatcher) {
      armIdle(2500 + Math.random() * 2000);
      idleWatcher = setInterval(() => {
        try {
          /* 自愈：dragStart 后迟迟等不到 dragStop（命令丢失等），
             又没有本地按下在进行，3 秒后自动退出拖动态 */
          if (dragging && !down && cmdDragAt && Date.now() - cmdDragAt > 3000) {
            dragging = false;
            cmdDragAt = 0;
            play('idle', 'base');
          }
          if (dragging) return;
          if (!pack) return;
          if (!isIdleNow()) return;
          if (Date.now() < nextIdleAt) return;
          const pick = pickIdleAction();
          if (pick) play(pick, 'once');
          armIdle(4000 + Math.random() * 5000);
        } catch { armIdle(5000); }
      }, 500);
    } else if (Date.now() >= nextIdleAt) {
      armIdle(2500 + Math.random() * 2500);
    }
  }

  function dragAnimName() {
    if (!pack) return 'idle';
    const r = pack.reactions && pack.reactions.drag;
    if (r && pack.animations[r]) return r;
    if (pack.animations['react-drag']) return 'react-drag';
    if (pack.animations.drag) return 'drag';
    return 'idle';
  }

  function randomAction() {
    if (!pack) return null;
    const drag = dragAnimName();
    const names = Object.keys(pack.animations).filter((n) =>
      n !== 'idle' && n !== 'sleeping' && n !== 'sleep' && n !== 'waking' && n !== 'wake' && n !== drag);
    if (!names.length) return null;
    return names[Math.floor(Math.random() * names.length)];
  }

  function pickIdleAction() {
    const pool = (pack.idlePool && pack.idlePool.anims) || [];
    if (pool.length && Math.random() < 0.75) {
      const ok = pool.filter((p) => pack.animations[p.anim]);
      if (ok.length) {
        const total = ok.reduce((s, p) => s + (p.weight || 1), 0);
        let r = Math.random() * total;
        for (const p of ok) { r -= (p.weight || 1); if (r <= 0) return p.anim; }
      }
    }
    return randomAction();
  }

  /* ---------------- 配置应用 ---------------- */

  function applyConfig(next) {
    cfg = Object.assign(cfg, next || {});
    if (pet && pet.debug) pet.debug('config pet=' + cfg.pet);
    stopCurrent();
    for (const u of blobURLs) URL.revokeObjectURL(u);
    blobURLs = [];
    images = new Map();
    pack = null;
    lastWinSize = '';
    if (cfg.pet === 'custom') {
      const c = cfg.custom;
      if (!c || !c.manifest) return;
      pack = c.manifest;
      const files = new Map();
      for (const [k, b64] of Object.entries(c.files || {})) files.set(k, b64ToBytes(b64));
      sheetURL = (name) => {
        const data = files.get((c.prefix || '') + name);
        if (!data) return '';
        const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
        blobURLs.push(url);
        return url;
      };
    } else {
      pack = (window.CVPacks || {})[cfg.pet];
      if (!pack) return;
      const base = 'pets/' + cfg.pet + '/';
      sheetURL = (n) => base + n;
    }
    play('idle', 'base');
  }

  /* ---------------- 指针：点击随机动作，拖动挪窗口 ---------------- */

  let down = null;
  let cmdDragAt = 0; // 最近一次收到 dragStart 的时间（看门狗自愈用）
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (pet && pet.debug) pet.debug('pointerdown pack=' + (pack && pack.id) + ' dragging=' + dragging);
    /* 每次按下都从干净状态开始：万一拖动态因为某次命令丢失
       卡住了，这一下就能把它清掉，不会越点越没反应 */
    dragging = false;
    cmdDragAt = 0;
    down = { sx: e.screenX, sy: e.screenY, lx: e.screenX, ly: e.screenY, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 抓不到也不影响 */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.screenX - down.lx;
    const dy = e.screenY - down.ly;
    down.lx = e.screenX;
    down.ly = e.screenY;
    if (!down.moved && Math.hypot(e.screenX - down.sx, e.screenY - down.sy) > 5) {
      down.moved = true;
      dragging = true;
      play(dragAnimName(), 'base');
    }
    if (down.moved && pet && (dx || dy)) pet.moveBy(dx, dy);
  });
  const endPointer = (e) => {
    if (!down) return;
    const wasDrag = down.moved;
    if (pet && pet.debug) pet.debug('pointerup drag=' + wasDrag);
    down = null;
    if (wasDrag) {
      dragging = false;
      /* 带上松手时的指针屏幕坐标：落在主窗口范围内 → 主进程把它收回软件内 */
      if (pet) pet.dragEnd({ screenX: e.screenX, screenY: e.screenY });
      play('idle', 'base');
    } else if (pack) {
      const r = canvas.getBoundingClientRect();
      const rel = (e.clientX - r.left) / Math.max(1, r.width);
      const rx = pack.reactions || {};
      let name = null;
      if (Math.random() < 0.5) {
        if (rel < 0.36 && rx.tapLeft && pack.animations[rx.tapLeft]) name = rx.tapLeft;
        else if (rel > 0.64 && rx.tapRight && pack.animations[rx.tapRight]) name = rx.tapRight;
      }
      if (!name) name = randomAction();
      if (name) play(name, 'once');
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', (e) => {
    down = null;
    if (dragging) {
      dragging = false;
      if (pet) pet.dragEnd({ screenX: e.screenX || -9999, screenY: e.screenY || -9999 });
      play('idle', 'base');
    }
  });

  /* ---------------- 右键：组装菜单模型给主进程弹原生菜单 ---------------- */

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (pet && pet.debug) pet.debug('contextmenu pack=' + (pack && pack.id));
    if (!pet || !pack) return;
    const used = new Set();
    const groups = [];
    const states = pack.states || {};
    const addGroup = (title, names) => {
      const items = names
        .filter((n) => pack.animations[n] && !used.has(n))
        .map((n) => { used.add(n); return { id: n, label: ANIM_LABELS[n] || n }; });
      if (items.length) groups.push({ label: title, items });
    };
    if (pack.groups) {
      for (const [title, list] of Object.entries(pack.groups)) addGroup(title, list);
    }
    for (const st of STATE_ORDER) {
      if (states[st]) addGroup(STATE_LABELS[st] || st, states[st]);
    }
    addGroup('其他动作', Object.keys(pack.animations));
    const pets = BUILTINS.map((b) => ({ id: b.id, label: b.label, tick: cfg.pet === b.id }));
    if (cfg.customName) pets.push({ id: 'custom', label: cfg.customName, tick: cfg.pet === 'custom' });
    const sizes = [
      { key: 'small', label: '小', tick: cfg.size === 'small' },
      { key: 'medium', label: '中', tick: cfg.size === 'medium' },
      { key: 'large', label: '大', tick: cfg.size === 'large' },
      { key: 'custom', label: '自定义（' + targetH() + 'px）', tick: cfg.size === 'custom' },
    ];
    pet.contextMenu({ groups, pets, sizes, anchor: { x: e.screenX, y: e.screenY } });
  });

  /* ---------------- 主进程通道 ---------------- */

  if (pet) {
    pet.onConfig((next) => applyConfig(next));
    pet.onPlay((name) => play(name, name === 'idle' ? 'base' : 'once'));
    /* 主窗口里把宠物拖出边界时，拖动态由主进程在这边点火/收尾 */
    if (pet.onCommand) pet.onCommand((cmd) => {
      if (!cmd) return;
      if (pet.debug) pet.debug('cmd ' + cmd.type);
      if (cmd.type === 'dragStart') { dragging = true; cmdDragAt = Date.now(); play(dragAnimName(), 'base'); }
      else if (cmd.type === 'dragStop') { dragging = false; cmdDragAt = 0; play('idle', 'base'); }
    });
  }
})();
