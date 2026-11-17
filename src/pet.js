/* ============================================================
   桌宠（pet.js）— 独立脚本，不依赖 app.js 的内部状态。
   - 内置包清单在 pets/packs.js（window.CVPacks），精灵图在 pets/<id>/ 下；
   - 自定义包是用户导入的 zip（pack.json + 精灵图，和 dsh-go 宠物包同格式），
     整包存 IndexedDB，换电脑/清缓存会丢，属正常；
   - 设置与位置存 localStorage 'cv:pet.v1'。
   交互：左键单击随机动作，右键多级菜单选任意动作，按住拖动换拖动态，
   待机时每隔几秒随机做个小动作，不会完全静止。
   ============================================================ */
(() => {
  'use strict';

  const LS_KEY = 'cv:pet.v1';
  const BUILTINS = [
    { id: 'whale-girl', label: '鲸娘' },
    { id: 'deepy', label: '像素鲸鱼' },
    { id: 'clawd', label: '克码人生' },
    { id: 'kunkun', label: '坤坤' },
    { id: 'maid', label: '蓝发小女仆' },
  ];
  /* 大小三档是「内容高度」的目标像素，自定义在 40–200 之间拉滑块 */
  const SIZE_PRESETS = { small: 64, medium: 92, large: 128 };

  /* 动作 id → 中文名（菜单里显示）。没收录的直接显示原 id。 */
  const ANIM_LABELS = {
    idle: '待机', 'idle-look': '东张西望', 'idle-peck': '啄一啄', 'idle-spout': '喷水',
    thinking: '思考', typing: '打字', building: '建造', conducting: '指挥',
    compacting: '整理压缩', carrying: '搬东西', notification: '提醒', passed: '搞定',
    happy: '开心', error: '出错了', sleeping: '睡觉', waking: '醒来',
    'roam-hop': '蹦跶', swim: '游泳', basketball: '打篮球', dribble: '运球', 'idle-ball': '玩球', 'ball-show': '耍球表演',
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

  /* ---------------- 设置 ---------------- */

  /* 配置的权威副本在 userData/pet-config.json（主进程文件）：
     实测这台机器上 localStorage 跨重启不可靠——每次启动读到的
     都是默认值（pet-debug.log 里 petboot 与 petsave 对照确认），
     而同目录的文件（pet-window.json、日志）一直正常。所以保存
     走文件（见 saveCfg / pet-main 的 pet:config-* 通道），
     localStorage 只留作同会话内的兜底。 */
  function normalizeCfg(c) {
    const dflt = { pet: 'kunkun', pos: null, customName: '', size: 'medium', sizePx: 92, mode: 'inside', perPet: {} };
    const out = Object.assign(dflt, c || {});
    /* 每只宠物的大小/位置分开存（perPet[宠物id] = {size, sizePx, pos}）：
       每只宠物的基础大小不一样，共用一套设置来回切换就得反复调。
       顶层的 size/sizePx/pos 是旧版的共用设置，只作迁移种子：
       第一次升级时把它们记到当前宠物名下，之后不再读它们。 */
    if (!out.perPet || typeof out.perPet !== 'object' || Array.isArray(out.perPet)) out.perPet = {};
    if (!out.perPet[out.pet]) {
      out.perPet[out.pet] = { size: out.size || 'medium', sizePx: out.sizePx || 92, pos: out.pos || null };
    }
    return out;
  }
  function loadCfg() {
    let c;
    try { c = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch { c = {}; }
    return normalizeCfg(c);
  }
  let cfg = loadCfg();
  function saveCfg() {
    const text = JSON.stringify(cfg);
    try { localStorage.setItem(LS_KEY, text); } catch { /* 存不下就算了 */ }
    const vp = vaultPet();
    if (vp && vp.saveConfig) { try { vp.saveConfig(text); } catch { /* 主进程没接上就算了 */ } }
  }
  /* 当前宠物的独立设置（没单独存过的宠物用默认值） */
  function petCfg() {
    const p = cfg.perPet[cfg.pet] || {};
    return { size: p.size || 'medium', sizePx: p.sizePx || 92, pos: p.pos || null };
  }
  function setPetCfg(patch) {
    cfg.perPet[cfg.pet] = Object.assign(petCfg(), patch);
    saveCfg();
    /* 【临时诊断】每次保存把当前宠物的设置写进 pet-debug.log，
       用来核对「退出后没保存」到底丢在哪一步 */
    const vp = vaultPet();
    if (vp && vp.debug) vp.debug('petsave ' + cfg.pet + ' ' + JSON.stringify(cfg.perPet[cfg.pet]));
  }
  function targetH() {
    const p = petCfg();
    if (p.size === 'custom') return Math.min(200, Math.max(40, p.sizePx || 92));
    return SIZE_PRESETS[p.size] || 92;
  }
  function builtinLabel(id) {
    const b = BUILTINS.find((x) => x.id === id);
    return b ? b.label : null;
  }

  /* ---------------- IndexedDB：存自定义包的 zip 原文件 ---------------- */

  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('cv-pet-db', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  const idbGet = (k) => idbDo('readonly', (s) => s.get(k));
  const idbSet = (k, v) => idbDo('readwrite', (s) => s.put(v, k));
  const idbDel = (k) => idbDo('readwrite', (s) => s.delete(k));

  /* ---------------- zip 解包（只用 zip 中央目录 + DecompressionStream） ---------------- */

  async function unzipAll(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const files = new Map();
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const lhOfs = dv.getUint32(off + 42, true);
      const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
      const lNameLen = dv.getUint16(lhOfs + 26, true);
      const lExtraLen = dv.getUint16(lhOfs + 28, true);
      const start = lhOfs + 30 + lNameLen + lExtraLen;
      const comp = u8.subarray(start, start + csize);
      let data;
      if (method === 0) {
        data = comp.slice();
      } else if (method === 8) {
        const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error('zip 里有不支持的压缩方式');
      }
      if (!name.endsWith('/')) files.set(name, data);
      off += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  /* 在解开的文件里找 pack.json（顶层或一层文件夹内），并校验 idle 动画齐全 */
  function parsePack(files) {
    let key = null;
    for (const k of files.keys()) {
      if (k === 'pack.json' || /^[^/]+\/pack\.json$/.test(k)) { key = k; break; }
    }
    if (!key) return null;
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(files.get(key))); }
    catch { return null; }
    if (!manifest.animations || !manifest.animations.idle) return null;
    const prefix = key.slice(0, key.length - 'pack.json'.length);
    if (!files.has(prefix + manifest.animations.idle.sheet)) return null;
    return { manifest, prefix, files };
  }

  /* 自定义包解析结果缓存（设置页预览和舞台共用） */
  let customCache = null;
  let customCacheTried = false;
  async function getCustom() {
    if (customCache || customCacheTried) return customCache;
    customCacheTried = true;
    try {
      const blob = await idbGet('customZip');
      if (!blob) return null;
      customCache = parsePack(await unzipAll(await blob.arrayBuffer()));
    } catch { customCache = null; }
    return customCache;
  }

  /* ---------------- 舞台与播放器 ---------------- */

  let stage = null;
  let canvas = null;
  let ctx = null;
  let pack = null;            // 当前包清单
  let sheetURL = null;        // (sheet 名) => 可加载的 URL
  let images = new Map();     // sheet 名 => HTMLImageElement
  let blobURLs = [];          // 自定义包的对象 URL，切换时释放
  let cur = null;             // { name, anim, frames, idx, cycles, timer }
  let dragging = false;
  let idleTimer = 0;

  function ensureStage() {
    if (stage) return;
    stage = document.createElement('div');
    stage.id = 'cvPet';
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    stage.appendChild(canvas);
    document.body.appendChild(stage);
    bindPointer();
    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    });
  }

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

  /* 显示尺寸：把内容框（contentBox × scale）归一化到 targetH() 那么高 */
  function sizeStage(anim) {
    const box = pack.contentBox || { w: anim.frameW, h: anim.frameH };
    const k = targetH() / Math.max(1, box.h * (pack.scale || 1));
    canvas.style.width = Math.round(anim.frameW * k) + 'px';
    canvas.style.height = Math.round(anim.frameH * k) + 'px';
  }

  function stopCurrent() {
    if (cur && cur.timer) clearTimeout(cur.timer);
    cur = null;
  }

  /* mode: 'base' 无限循环（待机/拖动）；'once' 播一遍后回到待机 */
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
      if (!pack || pack !== myPack) return; // 加载期间换了宠物，丢弃这次播放
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
    const sx = (i % cols) * a.frameW;
    const sy = Math.floor(i / cols) * a.frameH;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, a.frameW, a.frameH, 0, 0, a.frameW, a.frameH);
  }

  function isIdleNow() {
    return !!cur && cur.name === 'idle';
  }

  /* ---------------- 待机随机动作（自检式调度） ----------------
     不用链式 setTimeout：一旦某环异常，链会静默断掉、宠物再也不动。
     改成每 500ms 自检一次的看门狗 + 到点时间戳，怎么都死不了。 */

  let nextIdleAt = 0;
  let idleWatcher = 0;

  function armIdle(delay) { nextIdleAt = Date.now() + delay; }

  function scheduleIdle() {
    if (!idleWatcher) {
      armIdle(2500 + Math.random() * 2000); // 开局先动一次，确认是活的
      idleWatcher = setInterval(() => {
        try {
          if (dragging || document.hidden) return;
          if (!pack) return;
          if (!isIdleNow()) return;
          if (Date.now() < nextIdleAt) return;
          const pick = pickIdleAction();
          if (pick) play(pick, 'once');
          armIdle(4000 + Math.random() * 5000);
        } catch { armIdle(5000); }
      }, 500);
    } else if (Date.now() >= nextIdleAt) {
      armIdle(2500 + Math.random() * 2500); // 刚回待机且已过期，留个短暂的呼吸间隔
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

  /* ---------------- 拖动与点击 ---------------- */

  function clampPos(x, y, w, h) {
    return {
      x: Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4)),
      y: Math.min(Math.max(4, y), Math.max(4, window.innerHeight - h - 4)),
    };
  }

  function applyPos() {
    const pc = petCfg();
    if (!stage || !pc.pos) return;
    const r = stage.getBoundingClientRect();
    const p = clampPos(pc.pos.x, pc.pos.y, r.width, r.height);
    stage.style.left = p.x + 'px';
    stage.style.top = p.y + 'px';
    stage.style.right = 'auto';
    stage.style.bottom = 'auto';
  }

  function clickAction(e) {
    if (!pack) return;
    const r = stage.getBoundingClientRect();
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

  /* 拖出窗口后松手：落点算数由主进程裁决，这里只发 dragEndOut
     并做本地清理，不再抢先切桌面模式。以前抢先 applyPet 打开外部
     窗口、又和主进程的收回（dockInside）撞车：收回先把窗口关了，
     抢先发出的 openExternal 随后到、又把窗口开出来，界面状态和
     实际窗口就此对不上（幽灵窗口不听指挥）。现在主进程二选一回话：
     落在窗口内 → dockInside 命令；落在外面 → stayOut 命令。 */
  function finishDragOut(screenX, screenY) {
    dragging = false;
    if (stage) {
      stage.classList.remove('cv-pet-dragging');
      stage.style.visibility = '';
    }
    const vp = vaultPet();
    if (vp && vp.dragEndOut) vp.dragEndOut({ screenX, screenY });
    if (pack) play('idle', 'base');
  }

  function bindPointer() {
    let down = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      closeMenu();
      down = { x: e.clientX, y: e.clientY, moved: false, out: false, rect: stage.getBoundingClientRect() };
      try { stage.setPointerCapture(e.pointerId); } catch { /* 抓不到也不影响拖动 */ }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) > 5) {
        down.moved = true;
        dragging = true;
        stage.classList.add('cv-pet-dragging');
        play(dragAnimName(), 'base');
      }
      if (!down.moved) return;
      if (down.out) {
        /* 已交接给桌面窗口：后续移动发屏幕坐标给主进程挪窗口 */
        const vp = vaultPet();
        if (vp && vp.dragMove) {
          vp.dragMove({ screenX: e.screenX, screenY: e.screenY, grabDX: down.grabDX, grabDY: down.grabDY });
        }
        return;
      }
      const vp = vaultPet();
      const outside = e.clientX < -4 || e.clientY < -4 ||
        e.clientX > window.innerWidth + 4 || e.clientY > window.innerHeight + 4;
      if (outside && vp && vp.dragOut) {
        /* 拖出窗口边界：把宠物交接给桌面置顶小窗口，它不受本窗口
           边界限制，能停在桌面和任何软件上方；本窗口这只先藏起来 */
        down.out = true;
        down.grabDX = down.x - down.rect.left;
        down.grabDY = down.y - down.rect.top;
        const geo = {
          grabDX: down.grabDX, grabDY: down.grabDY,
          w: Math.round(down.rect.width), h: Math.round(down.rect.height),
          screenX: e.screenX, screenY: e.screenY,
        };
        stage.style.visibility = 'hidden';
        const pc = petCfg();
        if (externalCfgCache && externalCfgCache.pet === cfg.pet
          && externalCfgCache.size === pc.size && externalCfgCache.sizePx === pc.sizePx) {
          vp.dragOut(Object.assign(geo, { cfg: externalCfgCache }));
        } else {
          buildExternalCfg().then((c) => { externalCfgCache = c; vp.dragOut(Object.assign(geo, { cfg: c })); }).catch(() => {});
        }
        return;
      }
      const p = clampPos(down.rect.left + dx, down.rect.top + dy, down.rect.width, down.rect.height);
      stage.style.left = p.x + 'px';
      stage.style.top = p.y + 'px';
      stage.style.right = 'auto';
      stage.style.bottom = 'auto';
    });
    const end = (e) => {
      if (!down) return;
      const wasDrag = down.moved;
      const wasOut = down.out;
      down = null;
      if (wasOut) {
        finishDragOut(e.screenX, e.screenY);
      } else if (wasDrag) {
        dragging = false;
        stage.classList.remove('cv-pet-dragging');
        const r = stage.getBoundingClientRect();
        setPetCfg({ pos: { x: Math.round(r.left), y: Math.round(r.top) } });
        play('idle', 'base');
      } else {
        clickAction(e);
      }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', (e) => {
      const wasOut = down && down.out;
      down = null;
      if (wasOut) finishDragOut(e.screenX || -9999, e.screenY || -9999);
      else if (dragging) { dragging = false; stage.classList.remove('cv-pet-dragging'); play('idle', 'base'); }
    });
  }

  /* ---------------- 右键多级菜单 ---------------- */

  let menuEl = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function onDocDown(e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }
  function onMenuKey(e) {
    if (e.key === 'Escape') closeMenu();
  }

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
      if (opts.onClick) el.addEventListener('click', () => { closeMenu(); opts.onClick(); });
    }
    return el;
  }

  function subMenu(flat) {
    const s = document.createElement('div');
    s.className = 'sub' + (flat ? ' flat' : '');
    return s;
  }

  /* 子菜单显隐由 JS 控制（纯 CSS :hover 在斜向移动时容易断）：
     同一层共用一个收起计时——进入带子菜单的条目就展开它并取消
     本层待收起；进入普通条目或离开父条目，700ms 后才收起本层
     展开中的子菜单。从条目移进它自己的子菜单不算离开（子菜单
     是条目的子元素，pointerleave 不触发），700ms 也足够斜着
     划过邻项再进入子菜单。 */
  function wireSubMenus(root) {
    /* 子菜单用固定定位，但【绝不移动已经打开的菜单】——上一版的
       级联平移会把父菜单从指针下面挪走：条目滑走点不到、悬停目标
       突变还会让子菜单无故消失。定位规则：先向右展开；放不下翻到
       条目左侧，但翻过去会压住更上层祖先菜单（比如根菜单）时不翻，
       改贴视口边缘（只和直接父级少量重叠）；纵向同样夹进视口。 */
    const placeSub = (mi, sub) => {
      if (!sub) return;
      sub.classList.add('positioned');
      const vw = window.innerWidth, vh = window.innerHeight;
      const pr = mi.getBoundingClientRect();
      const w = sub.offsetWidth, h = sub.offsetHeight;
      let x = pr.right - 2;
      if (x + w > vw - 4) {
        const flipped = pr.left - w + 2;
        // 翻到左侧会不会压住祖先菜单（跳过直接父级菜单本身）
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
    const closeIn = (parent) => {
      parent.querySelectorAll(':scope > .mi.has-sub.sub-open').forEach((o) => {
        o.classList.remove('sub-open');
        o.querySelectorAll('.sub-open').forEach((d) => d.classList.remove('sub-open'));
      });
    };
    /* 待收起计时按父级各存一份；指针落到任何子菜单面板自身
       （边距、滚动条、分隔区这类「空白处」）时，把所有待收起计时
       一并取消——斜着移向子菜单时不会再被半路收掉。 */
    const armedParents = new Set();
    const armClose = (parent) => {
      clearTimeout(parent._petSubTimer);
      armedParents.add(parent);
      parent._petSubTimer = setTimeout(() => closeIn(parent), 700);
    };
    root.addEventListener('pointerover', (e) => {
      if (e.target.closest && e.target.closest('.sub') && !e.target.closest('.mi')) {
        armedParents.forEach((p) => clearTimeout(p._petSubTimer));
        armedParents.clear();
      }
    });
    root.querySelectorAll('.mi.has-sub').forEach((mi) => {
      const parent = mi.parentElement;
      mi.addEventListener('pointerenter', () => {
        clearTimeout(parent._petSubTimer);
        armedParents.delete(parent);
        parent.querySelectorAll(':scope > .mi.has-sub.sub-open').forEach((o) => {
          if (o !== mi) {
            o.classList.remove('sub-open');
            o.querySelectorAll('.sub-open').forEach((d) => d.classList.remove('sub-open'));
          }
        });
        mi.classList.add('sub-open');
        placeSub(mi, mi.querySelector(':scope > .sub'));
      });
      mi.addEventListener('pointerleave', () => armClose(parent));
    });
    root.querySelectorAll('.mi:not(.has-sub)').forEach((mi) => {
      mi.addEventListener('pointerenter', () => armClose(mi.parentElement));
    });
  }

  /* 播放动作：三级菜单 — 分组（模式）一层，组内动作再一层 */
  function buildActionsSub() {
    const root = subMenu(true);
    const used = new Set();
    const addGroup = (title, names) => {
      const list = names.filter((n) => pack.animations[n] && !used.has(n));
      if (!list.length) return;
      list.forEach((n) => used.add(n));
      const g = subMenu(false);
      for (const n of list) {
        g.appendChild(menuItem(ANIM_LABELS[n] || n, {
          onClick: () => play(n, n === 'idle' ? 'base' : 'once'),
        }));
      }
      root.appendChild(menuItem(title, { sub: g }));
    };
    /* 包自带分组（女仆按待机/工作/互动…分）优先，其次按应用状态分 */
    if (pack.groups) {
      for (const [title, list] of Object.entries(pack.groups)) addGroup(title, list);
    }
    const states = pack.states || {};
    for (const st of STATE_ORDER) {
      if (states[st]) addGroup(STATE_LABELS[st] || st, states[st]);
    }
    addGroup('其他动作', Object.keys(pack.animations));
    return root;
  }

  function buildPetSub() {
    const sub = subMenu(false);
    for (const b of BUILTINS) {
      sub.appendChild(menuItem(b.label, { tick: cfg.pet === b.id, onClick: () => setPet(b.id) }));
    }
    if (cfg.customName) {
      sub.appendChild(menuItem(cfg.customName, { tick: cfg.pet === 'custom', onClick: () => setPet('custom') }));
    }
    const sep = document.createElement('div');
    sep.className = 'sep';
    sub.appendChild(sep);
    sub.appendChild(menuItem('不显示', { tick: cfg.pet === 'none', onClick: () => setPet('none') }));
    return sub;
  }

  function buildSizeSub() {
    const sub = subMenu(false);
    const curSize = petCfg().size;
    const item = (key, label) => menuItem(label, { tick: curSize === key, onClick: () => setSize(key) });
    sub.appendChild(item('small', '小'));
    sub.appendChild(item('medium', '中'));
    sub.appendChild(item('large', '大'));
    sub.appendChild(menuItem('自定义（' + targetH() + 'px）', {
      tick: curSize === 'custom',
      onClick: () => { setSize('custom'); showSizePop(); },
    }));
    return sub;
  }

  /* ---------------- 自定义大小的浮动滑块（右键菜单点「自定义」时弹） ---------------- */

  let sizePop = null;

  function closeSizePop() {
    if (!sizePop) return;
    sizePop.remove();
    sizePop = null;
    document.removeEventListener('pointerdown', onSizePopDown, true);
    document.removeEventListener('keydown', onSizePopKey, true);
  }
  function onSizePopDown(e) {
    if (sizePop && !sizePop.contains(e.target)) closeSizePop();
  }
  function onSizePopKey(e) {
    if (e.key === 'Escape') closeSizePop();
  }

  function showSizePop() {
    closeSizePop();
    if (!stage || cfg.pet === 'none' || cfg.mode === 'desktop') return;
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
    range.max = '200';
    range.step = '2';
    range.value = String(petCfg().sizePx || 92);
    const val = document.createElement('span');
    val.className = 'cv-pet-sizepop-val';
    val.textContent = range.value + 'px';
    range.addEventListener('input', () => {
      setPetCfg({ sizePx: Number(range.value) || 92, size: 'custom' });
      val.textContent = range.value + 'px';
      if (cur && pack) sizeStage(cur.anim);
      syncSettingsUI();
      syncExternal();
    });
    row.appendChild(range);
    row.appendChild(val);
    sizePop.appendChild(row);
    document.body.appendChild(sizePop);
    const sr = stage.getBoundingClientRect();
    const pw = sizePop.offsetWidth;
    const ph = sizePop.offsetHeight;
    sizePop.style.left = Math.min(Math.max(4, sr.right - pw), Math.max(4, window.innerWidth - pw - 4)) + 'px';
    sizePop.style.top = Math.max(4, sr.top - ph - 8) + 'px';
    document.addEventListener('pointerdown', onSizePopDown, true);
    document.addEventListener('keydown', onSizePopKey, true);
  }

  function openMenu(x, y) {
    closeMenu();
    closeSizePop();
    if (!pack) return;
    menuEl = document.createElement('div');
    menuEl.className = 'cv-pet-menu';
    const head = document.createElement('div');
    head.className = 'mhead';
    head.textContent = builtinLabel(cfg.pet) || (pack && pack.name) || '桌宠';
    menuEl.appendChild(head);
    menuEl.appendChild(menuItem('播放动作', { sub: buildActionsSub() }));
    const sep1 = document.createElement('div');
    sep1.className = 'sep';
    menuEl.appendChild(sep1);
    menuEl.appendChild(menuItem('更换宠物', { sub: buildPetSub() }));
    menuEl.appendChild(menuItem('桌宠大小', { sub: buildSizeSub() }));
    if (cfg.mode === 'inside') {
      menuEl.appendChild(menuItem('放到桌面上', { onClick: () => setMode('desktop') }));
    }
    const sep2 = document.createElement('div');
    sep2.className = 'sep';
    menuEl.appendChild(sep2);
    menuEl.appendChild(menuItem('打开桌宠设置', { onClick: openPetSettings }));
    menuEl.appendChild(menuItem('隐藏桌宠', { onClick: () => setPet('none') }));
    document.body.appendChild(menuEl);
    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    const left = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - mw - 8));
    const top = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - mh - 8));
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
    if (window.innerWidth - left - mw < 190) menuEl.classList.add('flip');
    wireSubMenus(menuEl);
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  function openPetSettings() {
    const btn = document.querySelector('#btnSettings');
    if (btn) btn.click();
    setTimeout(() => {
      const nav = document.querySelector('.snav-item[data-pane="pet"]');
      if (nav) nav.click();
    }, 30);
  }

  /* ---------------- 大小 ---------------- */

  function setSize(key) {
    setPetCfg({ size: key });
    syncSettingsUI();
    if (cur && pack) sizeStage(cur.anim);
    syncExternal();
  }

  /* 显示位置切换（设置页分段控件、右键菜单、外部命令共用入口） */
  function setMode(m) {
    if (cfg.mode === m) return;
    cfg.mode = m;
    saveCfg();
    syncSettingsUI();
    applyPet();
  }

  /* ---------------- 宠物切换与加载 ---------------- */

  function setPet(id) {
    cfg.pet = id;
    saveCfg();
    syncSettingsUI();
    applyPet();
  }

  /* ---------------- 桌面模式（外部窗口） ----------------
     配置的唯一事实来源还是这里（localStorage）；主进程只负责
     开/关外部窗口和转发。自定义包要把文件内容编码后一起发过去，
     因为外部窗口读不到本窗口的 IndexedDB。 */

  const vaultPet = () => (window.vault && window.vault.pet) || null;

  function bytesToB64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  async function buildExternalCfg() {
    const pc = petCfg();
    const out = { pet: cfg.pet, size: pc.size, sizePx: pc.sizePx, customName: cfg.customName, custom: null };
    if (cfg.pet === 'custom') {
      const parsed = await getCustom();
      if (parsed) {
        const files = {};
        for (const [k, v] of parsed.files) files[k] = bytesToB64(v);
        out.custom = { manifest: parsed.manifest, prefix: parsed.prefix, files };
      }
    }
    return out;
  }

  /* 外部配置缓存：拖出交接要在 pointermove 里同步发出 dragOut，
     不能等 buildExternalCfg 的异步结果——慢一拍时松手先到，
     dragEndOut 会因「还没有窗口」被主进程丢弃，落点裁决丢失，
     两边状态从此对不上。缓存随 openExternal/syncExternal 刷新，
     拖出时对不上当前宠物/大小就回退到异步构建。 */
  let externalCfgCache = null;

  async function openExternal() {
    const vp = vaultPet();
    if (!vp) return;
    try {
      const c = await buildExternalCfg();
      externalCfgCache = c;
      await vp.openExternal(c);
    } catch { /* 主进程没接上就先这样 */ }
  }

  function syncExternal() {
    const vp = vaultPet();
    if (!vp || cfg.mode !== 'desktop' || cfg.pet === 'none') return;
    buildExternalCfg().then((c) => { externalCfgCache = c; vp.syncExternal(c); }).catch(() => {});
  }

  async function closeExternal() {
    const vp = vaultPet();
    if (!vp) return;
    try { await vp.closeExternal(); } catch { /* 已经关了 */ }
  }

  async function applyPet() {
    stopCurrent();
    closeMenu();
    closeSizePop();
    for (const u of blobURLs) URL.revokeObjectURL(u);
    blobURLs = [];
    images = new Map();
    pack = null;
    if (cfg.pet === 'none') {
      if (stage) stage.style.display = 'none';
      closeExternal();
      return;
    }
    if (cfg.mode === 'desktop') {
      if (stage) stage.style.display = 'none';
      openExternal();
      return;
    }
    closeExternal();
    ensureStage();
    stage.style.display = '';
    if (cfg.pet === 'custom') {
      const parsed = await getCustom();
      if (!parsed) { cfg.pet = 'kunkun'; saveCfg(); syncSettingsUI(); return applyPet(); }
      pack = parsed.manifest;
      sheetURL = (name) => {
        const data = parsed.files.get(parsed.prefix + name);
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
    applyPos();
    play('idle', 'base');
  }

  /* ---------------- 设置页：选择卡片（带动态预览） ---------------- */

  let previewStops = [];

  function stopPreviews() {
    for (const s of previewStops) { try { s(); } catch { /* 已停 */ } }
    previewStops = [];
  }

  /* 在小 canvas 上循环播某个包的 idle 动画，返回停止函数 */
  function startPreview(cv, pk, urlFor) {
    const anim = pk.animations.idle;
    if (!anim) return () => {};
    const img = new Image();
    let timer = 0;
    let stopped = false;
    img.onload = () => {
      if (stopped) return;
      const frames = frameList(anim, img);
      cv.width = anim.frameW;
      cv.height = anim.frameH;
      const box = pk.contentBox || { w: anim.frameW, h: anim.frameH };
      const k = Math.min(56 / Math.max(1, box.h * (pk.scale || 1)), 80 / anim.frameW);
      cv.style.width = Math.round(anim.frameW * k) + 'px';
      cv.style.height = Math.round(anim.frameH * k) + 'px';
      const c2 = cv.getContext('2d');
      const cols = anim.cols || 1;
      let idx = 0;
      const tick = () => {
        if (stopped) return;
        const f = frames[idx];
        c2.clearRect(0, 0, cv.width, cv.height);
        c2.drawImage(img, (f.i % cols) * anim.frameW, Math.floor(f.i / cols) * anim.frameH,
          anim.frameW, anim.frameH, 0, 0, anim.frameW, anim.frameH);
        idx = (idx + 1) % frames.length;
        timer = setTimeout(tick, Math.max(40, f.ms || 120));
      };
      tick();
    };
    img.src = urlFor(anim.sheet);
    return () => { stopped = true; clearTimeout(timer); };
  }

  function petCard(id, label) {
    const el = document.createElement('div');
    el.className = 'pet-card';
    el.dataset.petCard = id;
    return el;
  }

  async function buildCards() {
    const wrap = document.querySelector('#petCards');
    if (!wrap) return;
    stopPreviews();
    wrap.innerHTML = '';
    try {
      await buildCardsInner(wrap);
    } catch (err) {
      /* 【临时诊断】建卡片出错要留记录（以前是静默失败，只剩空区域） */
      const vp = vaultPet();
      if (vp && vp.debug) vp.debug('buildCards ERROR: ' + (err && err.message));
    }
    const vp2 = vaultPet();
    if (vp2 && vp2.debug) vp2.debug('buildCards: done children=' + wrap.children.length);
  }

  async function buildCardsInner(wrap) {
    for (const b of BUILTINS) {
      const pk = (window.CVPacks || {})[b.id];
      const card = petCard(b.id, b.label);
      if (pk) {
        const cv = document.createElement('canvas');
        card.appendChild(cv);
        previewStops.push(startPreview(cv, pk, (n) => 'pets/' + b.id + '/' + n));
      }
      const nm = document.createElement('div');
      nm.className = 'pet-card-name';
      nm.textContent = b.label;
      card.appendChild(nm);
      wrap.appendChild(card);
    }
    const custom = await getCustom();
    if (custom) {
      const card = petCard('custom', cfg.customName || custom.manifest.name || '自定义桌宠');
      const cv = document.createElement('canvas');
      card.appendChild(cv);
      previewStops.push(startPreview(cv, custom.manifest, (n) => {
        const data = custom.files.get(custom.prefix + n);
        if (!data) return '';
        const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
        blobURLs.push(url);
        return url;
      }));
      const nm = document.createElement('div');
      nm.className = 'pet-card-name';
      nm.textContent = cfg.customName || custom.manifest.name || '自定义桌宠';
      card.appendChild(nm);
      const rm = document.createElement('button');
      rm.className = 'pet-card-remove';
      rm.dataset.removeCustom = '1';
      rm.title = '移除自定义桌宠';
      rm.textContent = '×';
      card.appendChild(rm);
      wrap.appendChild(card);
    }
    const noneCard = petCard('none', '不显示');
    const nIcon = document.createElement('div');
    nIcon.className = 'pet-card-icon';
    nIcon.textContent = '✕';
    noneCard.appendChild(nIcon);
    const nName = document.createElement('div');
    nName.className = 'pet-card-name';
    nName.textContent = '不显示';
    noneCard.appendChild(nName);
    wrap.appendChild(noneCard);
    const impCard = petCard('import', '导入自己的桌宠');
    const iIcon = document.createElement('div');
    iIcon.className = 'pet-card-icon';
    iIcon.textContent = '＋';
    impCard.appendChild(iIcon);
    const iName = document.createElement('div');
    iName.className = 'pet-card-name';
    iName.textContent = '导入自己的桌宠';
    impCard.appendChild(iName);
    wrap.appendChild(impCard);
    syncCards();
  }

  function syncCards() {
    document.querySelectorAll('#petCards .pet-card').forEach((c) =>
      c.classList.toggle('is-active', c.dataset.petCard === cfg.pet));
  }

  function syncSettingsUI() {
    syncCards();
    const pc = petCfg();
    document.querySelectorAll('#petSizeSeg .seg-btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.size === pc.size));
    document.querySelectorAll('#petModeSeg .seg-btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.mode === cfg.mode));
    const box = document.querySelector('#petSizeCustom');
    const range = document.querySelector('#petSizeRange');
    const val = document.querySelector('#petSizeVal');
    if (box) box.hidden = pc.size !== 'custom';
    if (range) range.value = String(pc.sizePx || 92);
    if (val) val.textContent = String(pc.sizePx || 92) + 'px';
  }

  /* ---------------- 导入 / 移除自定义包 ---------------- */

  async function importZip(file) {
    const info = document.querySelector('#petCustomInfo');
    try {
      const buf = await file.arrayBuffer();
      const files = await unzipAll(buf);
      const parsed = parsePack(files);
      if (!parsed) throw new Error('包里找不到有效的 pack.json（需要顶层或一层文件夹内、且包含 idle 动画）');
      await idbSet('customZip', new Blob([buf], { type: 'application/zip' }));
      customCache = parsed;
      customCacheTried = true;
      cfg.customName = parsed.manifest.name || parsed.manifest.id || file.name;
      saveCfg();
      if (info) info.textContent = '已导入：' + cfg.customName + '（zip 宠物包，和 dsh-go 的宠物包通用）';
      await buildCards();
      setPet('custom');
    } catch (err) {
      if (info) info.textContent = '导入失败：' + (err && err.message ? err.message : '文件读不了');
    }
  }

  async function removeCustom() {
    await idbDel('customZip').catch(() => {});
    customCache = null;
    customCacheTried = true;
    cfg.customName = '';
    saveCfg();
    const info = document.querySelector('#petCustomInfo');
    if (info) info.textContent = '';
    if (cfg.pet === 'custom') setPet('kunkun');
    await buildCards();
    syncSettingsUI();
  }

  /* ---------------- 设置页绑定 ---------------- */

  function bindSettings() {
    const wrap = document.querySelector('#petCards');
    if (wrap) wrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove-custom]')) { removeCustom(); return; }
      const card = e.target.closest('.pet-card');
      if (!card) return;
      const id = card.dataset.petCard;
      if (id === 'import') {
        const fi = document.querySelector('#petImportFile');
        if (fi) fi.click();
      } else {
        setPet(id);
      }
    });
    const fileInput = document.querySelector('#petImportFile');
    if (fileInput) fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) importZip(fileInput.files[0]);
      fileInput.value = '';
    });
    const sizeSeg = document.querySelector('#petSizeSeg');
    if (sizeSeg) sizeSeg.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (b) setSize(b.dataset.size);
    });
    const modeSeg = document.querySelector('#petModeSeg');
    if (modeSeg) modeSeg.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (b) setMode(b.dataset.mode);
    });
    const range = document.querySelector('#petSizeRange');
    if (range) range.addEventListener('input', () => {
      setPetCfg({ sizePx: Number(range.value) || 92, size: 'custom' });
      syncSettingsUI();
      if (cur && pack) sizeStage(cur.anim);
    });
    const modal = document.querySelector('#settingsModal');
    if (modal && 'MutationObserver' in window) {
      new MutationObserver(() => {
        if (modal.hidden) stopPreviews();
        else { buildCards(); syncSettingsUI(); }
      }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  /* ---------------- 启动 ---------------- */

  document.addEventListener('visibilitychange', () => {
    if (!pack) return;
    if (document.hidden) {
      stopCurrent();
    } else if (!dragging && cfg.pet !== 'none') {
      play('idle', 'base');
    }
  });
  window.addEventListener('resize', applyPos);

  function init() {
    bindSettings();
    syncSettingsUI();
    /* 宠物脚本是首屏后才加载的：万一设置窗在脚本到位前就已经
       打开了，MutationObserver 等不到 hidden 变化，卡片区会一直
       空着 — 这里补一发：窗已经开着就立刻建卡片 */
    const modal0 = document.querySelector('#settingsModal');
    if (modal0 && !modal0.hidden) buildCards();
    /* 外部窗口右键菜单里的选择由主进程转回来，在这里统一执行 */
    const vp = vaultPet();
    if (vp && vp.onExternalCommand) {
      vp.onExternalCommand((cmd) => {
        if (!cmd) return;
        if (cmd.type === 'setPet') setPet(cmd.id);
        else if (cmd.type === 'setSize') setSize(cmd.key);
        else if (cmd.type === 'setMode') setMode(cmd.mode);
        else if (cmd.type === 'dockInside') {
          /* 桌面上的宠物被拖回窗口内松手（或点了「切回软件内显示」）：
             主进程已把屏幕坐标换算成窗口内坐标，并关掉了外部窗口 */
          cfg.mode = 'inside';
          if (Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) setPetCfg({ pos: { x: cmd.x, y: cmd.y } });
          saveCfg();
          syncSettingsUI();
          applyPet();
        }
        else if (cmd.type === 'stayOut') {
          /* 从软件内把宠物拖出、在窗口外松手：主进程确认它留在
             桌面上，这里才正式切到桌面模式（见 finishDragOut） */
          cfg.mode = 'desktop';
          saveCfg();
          syncSettingsUI();
          applyPet();
        }
        else if (cmd.type === 'openSettings') openPetSettings();
      });
    }
    /* 【临时诊断】启动时把读到的每只宠物设置写进 pet-debug.log，
       和 petsave 对照就能看出设置是没存下还是没读出来 */
    if (vp && vp.debug) vp.debug('petboot pet=' + cfg.pet + ' mode=' + cfg.mode + ' perPet=' + JSON.stringify(cfg.perPet));
    applyPet();
    /* 再把文件里的权威配置读回来覆盖（localStorage 在这台机器上
       跨重启会丢，见 loadCfg 上方说明）：读到就以它为准刷新一遍 */
    if (vp && vp.loadConfig) {
      vp.loadConfig().then((text) => {
        if (!text) return;
        let fileCfg = null;
        try { fileCfg = JSON.parse(text); } catch { /* 文件坏了就当没有 */ }
        if (!fileCfg || typeof fileCfg !== 'object') return;
        cfg = normalizeCfg(fileCfg);
        if (vp.debug) vp.debug('petboot-file pet=' + cfg.pet + ' perPet=' + JSON.stringify(cfg.perPet));
        syncSettingsUI();
        applyPet();
      }).catch(() => {});
    }
  }
  /* 【临时诊断】init 出错也要留下记录，不能静默死掉 */
  const safeInit = () => {
    const vp = vaultPet();
    if (vp && vp.debug) vp.debug('petinit: begin pet=' + cfg.pet + ' packs=' + (window.CVPacks ? Object.keys(window.CVPacks).length : 'NONE'));
    try { init(); }
    catch (err) {
      if (vp && vp.debug) vp.debug('petinit ERROR: ' + (err && err.message));
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();
})();
