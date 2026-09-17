/* ============================================================
   UI：棋盘渲染、骰子、弹层（地契 / 拍卖 / 筹款 / 资产 / 战报 …）
   ============================================================ */
window.DC = window.DC || {};

(function (DC) {
  'use strict';

  var U = DC.util, C = DC.CONFIG, CELLS = DC.CELLS, money = U.money;
  var TOKEN_OFFSET = [[-4.6, -4.6], [4.6, -4.6], [-4.6, 4.6], [4.6, 4.6]];
  var PIPS = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function icon(id, cls) {
    return '<svg class="ico ' + (cls || '') + '" aria-hidden="true"><use href="#' + id + '"></use></svg>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ============================================================ */
  function UI(engine) {
    this.e = engine;
    this.els = {};
    this._cellEls = [];
    this._tokenEls = [];
    this._sheet = null;
    this._lastFocus = null;
    this._assetsTab = 0;
    this._raiseCtx = null;
    this._auctionCtx = null;
    this._ticker = null;
  }

  UI.prototype = {
    constructor: UI,

    /* ---------------- 初始化 ---------------- */
    init: function () {
      var self = this;
      var $ = function (id) { return document.getElementById(id); };
      this.els = {
        app: $('app'), hud: document.querySelector('.hud'), board: $('board'), cells: $('cells'), tokens: $('tokens'),
        hub: $('hub'), hubDice: $('hubDice'), hubRound: $('hubRound'), hubWho: $('hubWho'),
        hubPot: $('hubPot'), hubTag: $('hubTag'),
        strip: $('strip'), ticker: $('ticker'), tickerList: $('tickerList'), dock: $('dock'),
        btnRoll: $('btnRoll'), btnAssets: $('btnAssets'), btnRules: $('btnRules'),
        btnSound: $('btnSound'), btnMenu: $('btnMenu'),
        sheetLayer: $('sheetLayer'), toasts: $('toasts'), fx: $('fx')
      };

      this.buildBoard();
      this.buildHub();
      this.bindChrome();
      this.applyMotion();

      // 棋盘取「可用区域」的正方形边长：任何视口下都不横滚、不裁切
      var stage = document.querySelector('.stage');
      var fit = function () {
        var cs = getComputedStyle(stage);
        var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        var padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        var w = stage.clientWidth - padX;
        var landscape = window.matchMedia('(orientation: landscape) and (max-height: 560px)').matches;
        var chrome = self.els.hud.offsetHeight + self.els.strip.offsetHeight + self.els.dock.offsetHeight;
        // 保留战报最小高度 + 底部投影余量，其余都给棋盘
        var reserve = landscape ? 18 : 48;
        var availH = window.innerHeight - chrome - reserve - Math.max(0, padY - 10);
        var side = Math.floor(Math.min(w, availH, 640));
        if (!(side > 100)) return;
        var bcs = getComputedStyle(self.els.board);
        var pad = (parseFloat(bcs.borderLeftWidth) || 0) + (parseFloat(bcs.borderRightWidth) || 0) +
                  (parseFloat(bcs.paddingLeft) || 0) + (parseFloat(bcs.paddingRight) || 0);
        self.els.board.style.width = side + 'px';
        self.els.board.style.height = side + 'px';
        self.els.board.style.setProperty('--u', ((side - pad) / 100) + 'px');
      };
      if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
      window.addEventListener('resize', fit);
      window.addEventListener('orientationchange', function () { setTimeout(fit, 150); });
      fit();

      this.e.on('state', function () { self.render(); });
      this.e.on('log', function (e) { self.ticker_(e); });
      this.e.on('move', function () { self.renderTokens(); });
      this.e.on('land', function (d) { self.landFlash(d.cell.i); });
      this.e.on('step', function (d) { self.stepFlash(d.pos); });
      this.e.on('ask', function (a) { self.onAsk(a); });
      this.e.on('askEnd', function () { self.closeSheet(true); });

      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && self._sheet && self._sheet.dismissible) { self.dismissSheet(); }
      });
      return this;
    },

    bindChrome: function () {
      var self = this, e = this.e;
      this.els.btnRoll.addEventListener('click', function () { e.pressRoll(); });
      this.els.btnAssets.addEventListener('click', function () { self.openAssets(); });
      this.els.btnRules.addEventListener('click', function () { self.openRules(); });
      this.els.btnMenu.addEventListener('click', function () { self.openMenu(); });
      this.els.btnSound.addEventListener('click', function () {
        e.settings.sound = !e.settings.sound;
        DC.audio.setEnabled(e.settings.sound);
        if (DC.saveSettings) DC.saveSettings();
        self.syncSound();
        self.toast(e.settings.sound ? '音效已开启' : '音效已静音', 'info');
      });
      this.els.btnRoll.setAttribute('aria-live', 'polite');
      this.syncSound();
      this.bindUiFeedback();
    },

    /* 全局按钮反馈：音效 + 轻震动（委托，覆盖动态弹层） */
    bindUiFeedback: function () {
      var e = this.e;
      var lastAt = 0;
      var pick = function (t) {
        if (!t || t.nodeType !== 1) return null;
        return t.closest && t.closest('button, [role="button"], .cell, .chip, .switch, .tab, .mini, .menu__item');
      };
      var fire = function (ev) {
        if (ev.button !== undefined && ev.button !== 0) return;
        var btn = pick(ev.target);
        if (!btn) return;
        if (btn.disabled || btn.classList.contains('is-disabled') || btn.getAttribute('aria-disabled') === 'true') return;
        var t = performance.now();
        if (t - lastAt < 50) return;
        lastAt = t;
        if (e.settings.sound && DC.audio && DC.audio.click) DC.audio.click();
        if (e.settings.haptics && DC.haptics) DC.haptics.tap();
      };
      document.addEventListener('pointerdown', fire, { capture: true, passive: true });
      document.addEventListener('click', fire, { capture: true, passive: true });
    },

    syncSound: function () {
      this.els.btnSound.innerHTML = icon(this.e.settings.sound ? 'i-sound' : 'i-mute');
      this.els.btnSound.setAttribute('aria-label', this.e.settings.sound ? '关闭音效' : '开启音效');
      this.els.btnSound.setAttribute('aria-pressed', String(!!this.e.settings.sound));
    },

    applyMotion: function () {
      var on = !!this.e.settings.reducedMotion;
      if (this.els.app) this.els.app.classList.toggle('reduce-motion', on);
    },

    /* ---------------- 棋盘 ---------------- */
    buildBoard: function () {
      var self = this;
      var frag = document.createDocumentFragment();
      CELLS.forEach(function (c) {
        var pos = DC.CELL_POS[c.i];
        var b = el('button', 'cell');
        b.style.gridArea = (pos[0] + 1) + ' / ' + (pos[1] + 1) + ' / span 1 / span 1';
        b.dataset.i = c.i;
        b.style.setProperty('--i', c.i);
        b.type = 'button';
        b.classList.add('cell--' + c.type);
        if (DC.CORNER_CELLS.indexOf(c.i) >= 0) b.classList.add('cell--corner');
        b.innerHTML =
          '<span class="cell__bar"></span>' +
          '<span class="cell__icon">' + self.cellIcon(c) + '</span>' +
          '<span class="cell__name">' + esc(c.short) + '</span>' +
          '<span class="cell__price"></span>' +
          '<span class="cell__houses"></span>' +
          '<span class="cell__owner"></span>';
        b.addEventListener('click', function () { self.openCell(c.i); });
        self._cellEls[c.i] = b;
        frag.appendChild(b);
      });
      this.els.cells.appendChild(frag);

      // 棋子
      var tf = document.createDocumentFragment();
      (this.e.state ? this.e.state.players : DC.PLAYER_PRESETS).forEach(function (p, i) {
        var t = el('div', 'token', '<span class="token__face">' + esc(p.short) + '</span><span class="token__ring"></span>');
        t.dataset.p = i;
        t.style.setProperty('--c', p.color);
        self._tokenEls[i] = t;
        tf.appendChild(t);
      });
      this.els.tokens.appendChild(tf);
    },

    cellIcon: function (c) {
      var map = {
        go: 'i-go', jail: 'i-jail', gotojail: 'i-jail', parking: 'i-parking',
        chance: 'i-chance', fate: 'i-fate', tax: 'i-tax', rail: 'i-rail', util: 'i-bolt'
      };
      return map[c.type] ? icon(map[c.type]) : '';
    },

    buildHub: function () {
      var h = this.els.hub;
      h.innerHTML =
        '<div class="hub__rays" aria-hidden="true"></div>' +
        '<div class="hub__frame">' +
          '<div class="hub__round">第 <b id="hubRound">1</b> 回合</div>' +
          '<div class="hub__dice" id="hubDice" aria-hidden="true">' +
            '<span class="die" data-v="0">' + '<i class="pip"></i>'.repeat(9) + '</span>' +
          '</div>' +
          '<div class="hub__who" id="hubWho">准备开始</div>' +
          '<div class="hub__pot" id="hubPot">罚款池 ¥0</div>' +
          '<div class="hub__last" id="hubLast"></div>' +
        '</div>';
      this.els.hubRound = document.getElementById('hubRound');
      this.els.hubDice = document.getElementById('hubDice');
      this.els.hubWho = document.getElementById('hubWho');
      this.els.hubPot = document.getElementById('hubPot');
      this.els.hubLast = document.getElementById('hubLast');
    },

    /* ---------------- 渲染 ---------------- */
    render: function () {
      var s = this.e.state;
      if (!s) return;
      this.renderStrip();
      this.renderCells();
      this.renderTokens();
      this.renderHub();
      this.renderDock();
      if (this._raiseCtx) this.renderRaiseBody();
      if (this._assetsCtx) this.renderAssetsBody();
    },

    renderStrip: function () {
      var s = this.e.state, self = this;
      var strip = this.els.strip;
      s.players.forEach(function (p, i) {
        var chip = strip.children[i];
        if (!chip) {
          chip = el('button', 'chip');
          chip.type = 'button';
          chip.dataset.p = i;
          chip.innerHTML =
            '<span class="chip__dot"></span>' +
            '<span class="chip__top"><b class="chip__name"></b><span class="chip__badge"></span></span>' +
            '<span class="chip__cash"></span>' +
            '<span class="chip__meta"></span>';
          chip.addEventListener('click', function () { self.openAssets(i); });
          strip.appendChild(chip);
        }
        chip.classList.toggle('is-active', i === s.current && !s.over);
        chip.classList.toggle('is-out', !!p.bankrupt);
        chip.classList.toggle('is-jail', !!p.inJail);
        chip.style.setProperty('--c', p.color);
        chip.querySelector('.chip__name').textContent = p.name;
        chip.querySelector('.chip__cash').textContent = money(p.cash);
        var meta = p.props.length + ' 处产业';
        if (p.inJail) meta = '狱中 · ' + meta;
        if (p.jailCards > 0) meta += ' · 证×' + p.jailCards;
        if (p.bankrupt) meta = '已破产';
        chip.querySelector('.chip__meta').textContent = meta;
        var badge = chip.querySelector('.chip__badge');
        badge.textContent = p.bankrupt ? 'OUT' : (p.isAI ? 'AI' : 'YOU');
        chip.setAttribute('aria-label', p.name + ' 现金 ' + money(p.cash) + '，' + meta);
      });
      if (this._lastCur !== s.current) {
        this._lastCur = s.current;
        var active = strip.children[s.current];
        if (active && active.scrollIntoView) {
          try { active.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) {}
        }
      }
    },

    renderCells: function () {
      var s = this.e.state, self = this;
      CELLS.forEach(function (c) {
        var b = self._cellEls[c.i];
        if (!b) return;
        var ownerId = s.owners[c.i];
        var owner = ownerId !== undefined ? s.players[ownerId] : null;
        var houses = s.houses[c.i] || 0;
        var groupColor = c.type === 'prop' ? DC.GROUPS[c.group].color : DC.TYPE_COLOR[c.type];
        b.style.setProperty('--gc', groupColor);
        b.classList.toggle('is-owned', !!owner);
        b.classList.toggle('is-mortgaged', !!s.mortgaged[c.i]);
        if (owner) b.style.setProperty('--oc', owner.color);
        var price = b.querySelector('.cell__price');
        if (c.type === 'prop' || c.type === 'rail' || c.type === 'util') {
          price.textContent = c.price >= 1000 ? (c.price / 1000) + 'k' : c.price;
        } else {
          price.textContent = c.type === 'tax' ? '10%' : '';
        }
        var hEl = b.querySelector('.cell__houses');
        if (houses > 0) {
          hEl.innerHTML = houses === 5
            ? '<i class="h h--hotel"></i>'
            : new Array(houses).fill('<i class="h"></i>').join('');
        } else hEl.innerHTML = '';
        var oEl = b.querySelector('.cell__owner');
        oEl.textContent = owner ? owner.short : '';
        if (owner) oEl.style.setProperty('--oc', owner.color);
        else oEl.style.removeProperty('--oc');
        var bits = [c.name, DC.TYPE_LABEL[c.type]];
        if (c.type === 'prop') bits.push(c.group + ' 组 · ' + DC.GROUPS[c.group].name);
        if (c.price) bits.push('售价 ' + money(c.price));
        if (owner) bits.push('业主 ' + owner.name);
        if (houses) bits.push(houses === 5 ? '已建酒店' : '已建 ' + houses + ' 栋房屋');
        if (s.mortgaged[c.i]) bits.push('已抵押');
        b.setAttribute('aria-label', bits.join('，'));
      });
    },

    renderTokens: function () {
      var s = this.e.state, self = this;
      if (!this._lastPos) this._lastPos = {};
      s.players.forEach(function (p, i) {
        var t = self._tokenEls[i];
        if (!t) return;
        var moved = self._lastPos[i] !== undefined && self._lastPos[i] !== p.pos;
        self._lastPos[i] = p.pos;
        if (moved && !self.e.settings.reducedMotion) {
          t.classList.remove('is-hop');
          void t.offsetWidth;
          t.classList.add('is-hop');
          setTimeout(function () { t.classList.remove('is-hop'); }, 300);
        }
        var c = DC.CELL_CENTER[p.pos];
        var off = TOKEN_OFFSET[i % 4];
        t.style.setProperty('--tx', (c.x + off[0]).toFixed(3));
        t.style.setProperty('--ty', (c.y + off[1]).toFixed(3));
        t.style.setProperty('--c', p.color);
        t.classList.toggle('is-active', i === s.current && !s.over);
        t.classList.toggle('is-out', !!p.bankrupt);
        t.classList.toggle('is-jail', !!p.inJail);
      });
    },

    renderHub: function () {
      var s = this.e.state, p = s.players[s.current];
      this.els.hubRound.textContent = s.round;
      this.els.hubPot.textContent = '罚款池 ' + money(s.pot);
      this.els.hubWho.textContent = s.over ? '对局结束' : (p ? p.name + ' 的回合' : '');
      this.els.hubWho.style.setProperty('--c', p ? p.color : '#C9A227');
      this.setDie(this.els.hubDice.children[0], s.die);
    },

    setDie: function (node, v) {
      node.dataset.v = v;
      var pips = node.children;
      var on = PIPS[v] || [];
      for (var i = 0; i < pips.length; i++) pips[i].classList.toggle('on', on.indexOf(i) >= 0);
    },

    houseLabel: function (h) {
      if (!h) return 'Lv.0';
      if (h >= 5) return '满级';
      return 'Lv.' + h;
    },

    nextHouseLabel: function (h) {
      var n = (h || 0) + 1;
      return n >= 5 ? '满级' : 'Lv.' + n;
    },

    humanPlayer: function () {
      var s = this.e.state;
      return s && s.players.filter(function (p) { return !p.isAI && !p.bankrupt; })[0];
    },

    renderDock: function () {
      var s = this.e.state;
      var p = s.players[s.current];
      var btn = this.els.btnRoll;
      var mine = p && !p.isAI && !p.bankrupt && !s.over;
      var can = mine && s.awaitingRoll;
      btn.disabled = !can;
      btn.classList.toggle('is-waiting', !can);
      var label = btn.querySelector('.btn__label');
      if (s.over) label.textContent = '对局结束';
      else if (can) label.textContent = '掷骰子';
      else if (p && p.isAI) label.textContent = p.name + ' 行动中…';
      else if (p && p.inJail) label.textContent = '处理监狱事务…';
      else label.textContent = '等待中…';
    },

    stepFlash: function (i) {
      var b = this._cellEls[i];
      if (!b || this.e.settings.reducedMotion) return;
      b.classList.remove('is-step');
      void b.offsetWidth;
      b.classList.add('is-step');
      setTimeout(function () { b.classList.remove('is-step'); }, 300);
    },

    landFlash: function (i) {
      var b = this._cellEls[i];
      if (!b) return;
      b.classList.add('is-land');
      setTimeout(function () { b.classList.remove('is-land'); }, 520);
    },

    /* ---------------- 骰子动画 ---------------- */
    dice: function (player, val) {
      var self = this, node = this.els.hubDice.children[0];
      this.els.hubDice.classList.add('is-rolling');
      this.els.hubWho.textContent = player.name + ' 掷骰…';
      var reduced = this.e.settings.reducedMotion;
      if (reduced) {
        this.setDie(node, val);
        this.els.hubDice.classList.remove('is-rolling');
        return Promise.resolve();
      }
      var t0 = performance.now(), dur = 620;
      return new Promise(function (res) {
        var tick = function (now) {
          if (now - t0 < dur) {
            self.setDie(node, U.rand(1, 6));
            requestAnimationFrame(tick);
          } else {
            self.setDie(node, val);
            self.els.hubDice.classList.remove('is-rolling');
            self.els.hubDice.classList.add('is-settled');
            setTimeout(function () { self.els.hubDice.classList.remove('is-settled'); }, 320);
            res();
          }
        };
        requestAnimationFrame(tick);
      });
    },

    /* ---------------- 特效 ---------------- */
    stamp: function (cell) {
      var self = this;
      var b = this._cellEls[cell.i];
      if (!b) return;
      var rect = b.getBoundingClientRect(), br = this.els.fx.getBoundingClientRect();
      var s = el('div', 'stamp', '<span class="stamp__ring"></span><span class="stamp__txt">' + esc(cell.short) + '</span>');
      s.style.left = (rect.left - br.left + rect.width / 2) + 'px';
      s.style.top = (rect.top - br.top + rect.height / 2) + 'px';
      this.els.fx.appendChild(s);
      this.confetti(cell.i, 14);
      setTimeout(function () { s.classList.add('is-out'); }, 900);
      setTimeout(function () { s.remove(); }, 1500);
    },

    float: function (text, cellIndex, kind) {
      var b = this._cellEls[cellIndex];
      if (!b) return;
      var rect = b.getBoundingClientRect(), br = this.els.fx.getBoundingClientRect();
      var f = el('div', 'float ' + (kind ? 'float--' + kind : ''), esc(text));
      f.style.left = (rect.left - br.left + rect.width / 2) + 'px';
      f.style.top = (rect.top - br.top + rect.height / 2) + 'px';
      this.els.fx.appendChild(f);
      setTimeout(function () { f.remove(); }, 1300);
    },

    confetti: function (cellIndex, n) {
      if (this.e.settings.reducedMotion) return;
      var b = this._cellEls[cellIndex];
      if (!b) return;
      var rect = b.getBoundingClientRect(), br = this.els.fx.getBoundingClientRect();
      var cx = rect.left - br.left + rect.width / 2;
      var cy = rect.top - br.top + rect.height / 2;
      var colors = ['#FF8FB1', '#FFC93C', '#6FD08C', '#6EC5F0', '#B08CFF', '#FFB067'];
      var total = n || 14;
      for (var i = 0; i < total; i++) {
        var node = document.createElement('i');
        node.className = 'confetti';
        node.style.left = cx + 'px';
        node.style.top = cy + 'px';
        node.style.background = colors[i % colors.length];
        if (i % 3 === 0) node.style.borderRadius = '50%';
        var ang = (Math.PI * 2 * i) / total + Math.random() * 0.6;
        var dist = 24 + Math.random() * 44;
        node.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
        node.style.setProperty('--dy', (Math.sin(ang) * dist - 18).toFixed(1) + 'px');
        node.style.setProperty('--rot', Math.round(Math.random() * 720 - 360) + 'deg');
        node.style.setProperty('--d', (0.5 + Math.random() * 0.4).toFixed(2) + 's');
        this.els.fx.appendChild(node);
        (function (el) {
          setTimeout(function () { el.remove(); }, 1000);
        })(node);
      }
    },

    coinFly: function (cellIndex, playerId) {
      if (this.e.settings.reducedMotion) return;
      var cell = this._cellEls[cellIndex];
      var chip = this.els.strip.children[playerId];
      if (!cell || !chip) return;
      var cr = cell.getBoundingClientRect(), hr = chip.getBoundingClientRect();
      var sx = cr.left + cr.width / 2, sy = cr.top + cr.height / 2;
      var ex = hr.left + hr.width / 2, ey = hr.top + hr.height / 2;
      var node = el('i', 'coin-fly');
      node.style.left = sx + 'px';
      node.style.top = sy + 'px';
      node.style.setProperty('--dx', (ex - sx).toFixed(1) + 'px');
      node.style.setProperty('--dy', (ey - sy).toFixed(1) + 'px');
      document.body.appendChild(node);
      setTimeout(function () { node.remove(); }, 800);
    },

    shake: function () {
      if (this.e.settings.reducedMotion) return;
      var app = this.els.app;
      app.classList.remove('is-shake');
      void app.offsetWidth;
      app.classList.add('is-shake');
      setTimeout(function () { app.classList.remove('is-shake'); }, 440);
    },

    toast: function (msg, kind) {
      var t = el('div', 'toast toast--' + (kind || 'info'), esc(msg));
      this.els.toasts.appendChild(t);
      setTimeout(function () { t.classList.add('is-out'); }, 2600);
      setTimeout(function () { t.remove(); }, 3000);
    },

    ticker_: function (entry) {
      var box = this.els.tickerList;
      var n = el('div', 'ticker__item ticker__item--' + entry.kind, esc(entry.text));
      box.appendChild(n);
      while (box.children.length > 24) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
      if (this.els.hubLast) this.els.hubLast.textContent = entry.text;
    },

    sfx: function (name) {
      if (DC.audio[name]) DC.audio[name]();
    },

    /* ---------------- 弹层 ---------------- */
    sheet: function (opts) {
      var self = this;
      var layer = this.els.sheetLayer;
      // 硬切换：立刻清掉上一张，避免退出动画与新增内容互相覆盖
      this._sheet = null;
      layer.innerHTML = '';
      layer.hidden = false;
      this._lastFocus = document.activeElement;

      var scrim = el('div', 'scrim');
      var sheet = el('div', 'sheet sheet--' + (opts.kind || 'default'));
      if ((opts.actions || []).length >= 3) sheet.classList.add('sheet--stack');
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      var head = '';
      if (opts.eyebrow) head += '<p class="eyebrow">' + esc(opts.eyebrow) + '</p>';
      if (opts.title) head += '<h2 class="sheet__title" id="sheetTitle">' + opts.title + '</h2>';
      if (opts.sub) head += '<p class="sheet__sub">' + opts.sub + '</p>';
      sheet.innerHTML =
        '<div class="sheet__grip" aria-hidden="true"></div>' +
        (head ? '<header class="sheet__head">' + head + '</header>' : '') +
        '<div class="sheet__body"></div>' +
        '<div class="sheet__actions"></div>';
      if (head) sheet.setAttribute('aria-labelledby', 'sheetTitle');

      var body = sheet.querySelector('.sheet__body');
      if (typeof opts.body === 'string') body.innerHTML = opts.body;
      else if (opts.body) body.appendChild(opts.body);

      var actions = sheet.querySelector('.sheet__actions');
      this.fillActions(actions, opts.actions);

      if (opts.dismissible !== false) {
        var x = el('button', 'sheet__close', icon('i-close'));
        x.type = 'button';
        x.setAttribute('aria-label', '关闭');
        x.addEventListener('click', function () { self.dismissSheet(); });
        sheet.appendChild(x);
        scrim.addEventListener('click', function () { self.dismissSheet(); });
      }

      layer.appendChild(scrim);
      layer.appendChild(sheet);
      this._sheet = {
        node: sheet, opts: opts, dismissible: opts.dismissible !== false,
        onDismiss: opts.onDismiss
      };
      requestAnimationFrame(function () { sheet.classList.add('is-in'); });
      var focusTarget = actions.querySelector('button:not([disabled])') || sheet;
      setTimeout(function () { focusTarget.focus({ preventScroll: true }); }, 60);
      document.body.classList.add('is-locked');
      return sheet;
    },

    fillActions: function (host, list) {
      var self = this;
      host.innerHTML = '';
      (list || []).forEach(function (a) {
        var btn = el('button', 'btn btn--' + (a.kind || 'ghost') + (a.disabled ? ' is-disabled' : ''));
        btn.type = 'button';
        btn.innerHTML = (a.icon ? icon(a.icon) : '') + '<span class="btn__label">' + esc(a.label) + '</span>';
        btn.disabled = !!a.disabled;
        btn.addEventListener('click', function () {
          if (btn.disabled) return;
          if (a.onClick) a.onClick();
          if (a.close !== false && !a.keepOpen) self.closeSheet();
        });
        host.appendChild(btn);
      });
    },

    dismissSheet: function () {
      var s = this._sheet;
      this.closeSheet();
      if (s && s.onDismiss) s.onDismiss();
    },

    closeSheet: function (fromAsk) {
      if (fromAsk && this._auctionCtx) return;   // 拍卖进行中：弹层由拍卖流程自己收尾
      var s = this._sheet;
      if (!s) return;
      this._sheet = null;
      this._raiseCtx = null;
      this._assetsCtx = null;
      var layer = this.els.sheetLayer;
      var node = s.node;
      node.classList.remove('is-in');
      node.classList.add('is-out');
      setTimeout(function () {
        if (!layer.contains(node)) return;          // 已经被新弹层顶掉
        layer.innerHTML = '';
        layer.hidden = true;
        document.body.classList.remove('is-locked');
      }, 220);
      if (this._lastFocus && this._lastFocus.focus) {
        try { this._lastFocus.focus({ preventScroll: true }); } catch (e) {}
      }
      this._lastFocus = null;
    },

    /* ---------------- 询问 ---------------- */
    onAsk: function (a) {
      if (!a) return;
      if (a.type === 'buy') this.askBuy(a);
      else if (a.type === 'upgrade') this.askUpgrade(a);
      else if (a.type === 'jail') this.askJail(a);
      else if (a.type === 'auction') this.askAuction(a);
      else if (a.type === 'raise') this.askRaise(a);
    },

    askUpgrade: function (a) {
      var self = this, e = this.e;
      var cell = CELLS[a.cellId];
      var p = e.player(a.playerId);
      var lv = a.level || 0;
      var body = el('div', 'deed');
      body.innerHTML = this.deedHtml(cell, { compact: false, owner: p });
      var note = el('p', 'upgrade__ask');
      note.textContent = '停在自己的地上，可花费 ' + money(a.cost) + ' 升级到 ' + self.nextHouseLabel(lv) +
        '（当前 ' + self.houseLabel(lv) + '）。升级后租金更高。';
      body.appendChild(note);
      this.sheet({
        eyebrow: '升级 · UPGRADE',
        title: esc(cell.name),
        sub: '是否升级当前土地？',
        body: body,
        dismissible: false,
        actions: [
          { label: '暂不升级', kind: 'ghost', onClick: function () { e.answer('skip'); } },
          { label: '升级 ' + money(a.cost), kind: 'primary', icon: 'i-upgrade', disabled: p.cash < a.cost, onClick: function () { e.answer('upgrade'); } }
        ]
      });
    },

    askBuy: function (a) {
      var self = this, e = this.e;
      var cell = CELLS[a.cellId];
      var p = e.player(a.playerId);
      var body = el('div', 'deed');
      body.innerHTML = this.deedHtml(cell, { compact: false, buyer: p });
      this.sheet({
        eyebrow: '地契 · TITLE DEED',
        title: esc(cell.name),
        sub: '落格无人认领，可即刻买下',
        body: body,
        dismissible: false,
        actions: [
          { label: '放弃，转入拍卖', kind: 'ghost', onClick: function () { e.answer('auction'); } },
          { label: '买下 ' + money(cell.price), kind: 'primary', icon: 'i-coin', onClick: function () { e.answer('buy'); } }
        ]
      });
    },

    askJail: function (a) {
      var e = this.e, p = e.player(a.playerId);
      var body = el('div', 'stack');
      body.innerHTML =
        '<div class="notice notice--jail">' + icon('i-jail') +
        '<div><b>你在狱中</b><p>已停留 ' + a.turns + ' / ' + a.maxTurns + ' 回合。掷出 6 即可出狱并前进。</p></div></div>';
      this.sheet({
        eyebrow: '监狱 · JAIL',
        title: '如何离开？',
        body: body,
        dismissible: false,
        actions: [
          { label: '掷骰求 6', kind: 'primary', icon: 'i-dice', onClick: function () { e.answer('roll'); } },
          { label: '用出狱许可证' + (a.cards ? '（' + a.cards + '）' : '（无）'), kind: 'ghost', disabled: !a.cards, onClick: function () { e.answer('card'); } },
          { label: '缴纳保释金 ' + money(a.fine), kind: 'ghost', disabled: p.cash < a.fine, onClick: function () { e.answer('pay'); } }
        ]
      });
    },

    askAuction: function (a) {
      this._auctionCtx = Object.assign(this._auctionCtx || { cellId: a.cellId, bid: 0, highId: null }, { ask: a });
      this.renderAuctionSheet();
    },

    auctionStart: function (cell) {
      this._auctionCtx = { cellId: cell.i, bid: 0, highId: null, ask: null };
      this.renderAuctionSheet();
    },

    auctionBid: function (p, bid) {
      if (!this._auctionCtx) return;
      this._auctionCtx.bid = bid;
      this._auctionCtx.highId = p.id;
      this._auctionCtx.ask = null;
      this.renderAuctionSheet();
    },

    auctionEnd: function () {
      this._auctionCtx = null;
      this.closeSheet();
    },

    renderAuctionSheet: function () {
      var self = this, e = this.e, ctx = this._auctionCtx;
      if (!ctx) return;
      var cell = CELLS[ctx.cellId];
      var high = ctx.highId != null ? e.player(ctx.highId) : null;
      var a = ctx.ask;
      var sub = a ? (a.last ? '只剩你一位竞买人' : '轮到你出价') : (high ? esc(high.name) + ' 领先' : '等待其他玩家出价…');
      var html =
        '<div class="auction__row"><span>当前最高价</span><b class="mono">' + (ctx.bid ? money(ctx.bid) : '尚无出价') + '</b></div>' +
        '<div class="auction__row"><span>最高出价人</span><b>' + (high ? esc(high.name) : '—') + '</b></div>' +
        (a ? '<div class="auction__row"><span>本次加价</span><b class="mono">' + money(a.nextBid) + '</b></div>' : '') +
        '<div class="deed deed--mini">' + this.deedHtml(cell, { compact: true, mini: true }) + '</div>';
      var actions = [];
      if (a) {
        var me = e.player(a.playerId);
        var canBid = me.cash >= a.nextBid;
        actions = [
          { label: '放弃', kind: 'ghost', onClick: function () { e.answer('pass'); } },
          {
            label: canBid ? '出价 ' + money(a.nextBid) : '现金不足', kind: 'primary', icon: 'i-coin',
            disabled: !canBid, onClick: function () { e.answer('bid'); }
          }
        ];
      }
      var cur = this._sheet;
      if (cur && cur.opts && cur.opts.kind === 'auction') {
        cur.node.querySelector('.sheet__body').innerHTML = '<div class="auction">' + html + '</div>';
        var subEl = cur.node.querySelector('.sheet__sub');
        if (subEl) subEl.innerHTML = sub;
        cur.opts.actions = actions;
        this.fillActions(cur.node.querySelector('.sheet__actions'), actions);
        return;
      }
      this.sheet({
        kind: 'auction', eyebrow: '拍卖 · AUCTION', title: esc(cell.name), sub: sub,
        body: '<div class="auction">' + html + '</div>', dismissible: false, actions: actions
      });
    },

    askRaise: function (a) {
      var self = this, e = this.e;
      var p = e.player(a.playerId);
      this._raiseCtx = { amount: a.amount, playerId: a.playerId, reason: a.reason };
      var body = el('div', 'raise');
      body.innerHTML =
        '<div class="notice notice--danger">' + icon('i-alert') +
        '<div><b>需要 ' + money(a.amount) + '</b><p>' + esc(a.reason || '现金不足') + '，还差 <span class="mono">' + money(a.need) + '</span>。抵押或拆除房产来筹款。</p></div></div>' +
        '<div class="raise__list" id="raiseList"></div>';
      this.sheet({
        eyebrow: '筹款 · RAISE FUNDS',
        title: '资金不足',
        sub: '现金 <b class="mono" id="raiseCash">' + money(p.cash) + '</b> / 需 ' + money(a.amount),
        body: body,
        dismissible: false,
        actions: [
          { label: '宣告破产', kind: 'danger', onClick: function () { e.answer('bankrupt'); } },
          { label: '继续', kind: 'primary', onClick: function () { e.answer('done'); } }
        ]
      });
      this.renderRaiseBody();
    },

    renderRaiseBody: function () {
      var ctx = this._raiseCtx;
      if (!ctx) return;
      var e = this.e, p = e.player(ctx.playerId);
      var list = document.getElementById('raiseList');
      var cashEl = document.getElementById('raiseCash');
      if (!list) { this._raiseCtx = null; return; }
      if (cashEl) cashEl.textContent = money(p.cash);
      var enough = p.cash >= ctx.amount;
      var rows = p.props.slice().sort(function (a, b) { return CELLS[a].i - CELLS[b].i; }).map(function (i) {
        var c = CELLS[i];
        var h = e.state.houses[i] || 0;
        var m = e.state.mortgaged[i];
        var acts = '';
        if (e.canSellHouse(p, i)) acts += '<button class="mini" data-act="sell" data-i="' + i + '">拆房 +' + money(Math.round(c.houseCost * C.houseSellRate)) + '</button>';
        if (e.canMortgage(p, i)) acts += '<button class="mini" data-act="mortgage" data-i="' + i + '">抵押 +' + money(Math.round(c.price * C.mortgageRate)) + '</button>';
        if (m) acts += '<span class="mini mini--tag">已抵押</span>';
        return '<li><span class="raise__name">' + esc(c.name) + (h ? ' <i class="dot-h">×' + h + '</i>' : '') + '</span><span class="raise__acts">' + acts + '</span></li>';
      }).join('');
      list.innerHTML = rows || '<li class="empty">名下已无资产可抵押</li>';
      list.querySelectorAll('button[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = +b.dataset.i;
          if (b.dataset.act === 'sell') e.sellHouse(p, i);
          else e.mortgage(p, i);
        });
      });
      var actions = this._sheet ? this._sheet.node.querySelector('.sheet__actions') : null;
      if (actions) {
        var cont = actions.querySelector('.btn--primary');
        if (cont) {
          cont.disabled = !enough;
          cont.classList.toggle('is-disabled', !enough);
          cont.querySelector('.btn__label').textContent = enough ? '继续' : '还需 ' + money(ctx.amount - p.cash);
        }
      }
    },

    /* ---------------- 地契 HTML ---------------- */
    deedHtml: function (cell, opts) {
      opts = opts || {};
      var e = this.e, s = e.state;
      var group = cell.type === 'prop' ? DC.GROUPS[cell.group] : null;
      var color = group ? group.color : DC.TYPE_COLOR[cell.type];
      var label = group ? (cell.group + ' 组 · ' + group.name) : DC.TYPE_LABEL[cell.type];
      var ownerId = s.owners[cell.i];
      var owner = ownerId !== undefined ? s.players[ownerId] : null;
      var houses = s.houses[cell.i] || 0;
      var rows = '';

      if (cell.type === 'prop') {
        rows =
          this.rentRow('空地租金', cell.rents[0]) +
          this.rentRow('满组空地', cell.rents[0] * 2, 'double') +
          this.rentRow('1 栋房屋', cell.rents[1]) +
          this.rentRow('2 栋房屋', cell.rents[2]) +
          this.rentRow('3 栋房屋', cell.rents[3]) +
          this.rentRow('4 栋房屋', cell.rents[4]) +
          this.rentRow('酒店', cell.rents[5], 'hotel');
      } else if (cell.type === 'rail') {
        rows = cell.rents.map(function (r, i) { return this.rentRow((i + 1) + ' 座车站', r); }, this).join('');
        rows += this.rentRow('每级升级', '+¥300', 'double');
      } else if (cell.type === 'util') {
        rows = this.rentRow('持有 1 家', '骰子 ×' + cell.mult[0]) + this.rentRow('持有 2 家', '骰子 ×' + cell.mult[1]);
        rows += this.rentRow('每级升级', '倍率 +50', 'double');
      }

      var priceLine = cell.price
        ? '<div class="deed__price"><span>售价</span><b class="mono">' + money(cell.price) + '</b></div>'
        : (cell.type === 'tax' ? '<div class="deed__price"><span>税率</span><b class="mono">现金 10%</b></div>' : '');

      var houseLine = cell.houseCost
        ? '<div class="deed__price deed__price--sub"><span>升级费用</span><b class="mono">' + money(cell.houseCost) + '</b></div>'
        : '';
      var lvText = houses ? (houses === 5 && cell.type === 'prop' ? '，建有酒店' : '，' + this.houseLabel(houses)) : '';

      return '' +
        '<div class="deed__band" style="--gc:' + color + '"><span class="deed__chip"></span><span>' + esc(label) + '</span></div>' +
        (opts.compact ? '' : '<h3 class="deed__name">' + esc(cell.name) + '</h3>') +
        priceLine +
        (opts.mini ? '' :
          houseLine +
          (rows ? '<table class="deed__table">' + rows + '</table>' : '<p class="deed__desc">' + esc(cell.desc || '') + '</p>') +
          (owner ? '<div class="deed__owner" style="--oc:' + owner.color + '"><span class="dot"></span>' + esc(owner.name) + ' 持有' + lvText + (s.mortgaged[cell.i] ? '（已抵押）' : '') + '</div>' : '') +
          (cell.houseCost && cell.price ? '<div class="deed__note">落在自有地上可升级 · 抵押可得 ' + money(Math.round(cell.price * C.mortgageRate)) + '</div>' : '')
        );
    },

    rentRow: function (label, value, cls) {
      return '<tr class="' + (cls || '') + '"><td>' + esc(label) + '</td><td class="mono">' + (typeof value === 'number' ? money(value) : value) + '</td></tr>';
    },

    openCell: function (i) {
      var e = this.e, cell = CELLS[i], s = e.state;
      var body = el('div', 'deed deed--sheet');
      body.innerHTML = this.deedHtml(cell, {});
      var actions = [{ label: '知道了', kind: 'primary' }];
      var p = s.players[s.current];
      var hint = '';
      if (p && !p.isAI && s.owners[i] === p.id && e.canUpgradeLevel(p, i) && cell.houseCost) {
        hint = '再次落在这里时可升级（' + money(cell.houseCost) + '）';
      }
      this.sheet({
        eyebrow: DC.TYPE_LABEL[cell.type] + ' · ' + (cell.type === 'prop' ? cell.group + ' 组' : ''),
        title: esc(cell.name),
        sub: hint || undefined,
        body: body,
        actions: actions
      });
    },

    /* ---------------- 资产 ---------------- */
    openAssets: function (tab) {
      var self = this, e = this.e;
      if (typeof tab === 'number') this._assetsTab = tab;
      this._assetsCtx = { tab: this._assetsTab };
      var body = el('div', 'assets');
      body.innerHTML = '<div class="tabs" id="assetTabs"></div><div class="assets__body" id="assetsBody"></div>';
      this.sheet({ eyebrow: '资产 · PORTFOLIO', title: '资产总览', body: body, dismissible: true, actions: [{ label: '关闭', kind: 'ghost' }] });
      this.renderAssetsBody();
    },

    renderAssetsBody: function () {
      var self = this, e = this.e, s = e.state;
      var tabs = document.getElementById('assetTabs');
      var box = document.getElementById('assetsBody');
      if (!tabs || !box) { this._assetsCtx = null; return; }
      var cur = this._assetsTab;
      tabs.innerHTML = s.players.map(function (p, i) {
        return '<button type="button" class="tab' + (i === cur ? ' is-on' : '') + '" data-t="' + i + '" style="--c:' + p.color + '">' +
          '<span class="dot"></span>' + esc(p.name) + '</button>';
      }).join('');
      tabs.querySelectorAll('.tab').forEach(function (b) {
        b.addEventListener('click', function () { self._assetsTab = +b.dataset.t; self.renderAssetsBody(); });
      });
      var p = s.players[cur];
      var isMine = p && !p.isAI;
      var rows = p.props.slice().sort(function (a, b) { return a - b; }).map(function (i) {
        var c = CELLS[i];
        var h = s.houses[i] || 0;
        var m = s.mortgaged[i];
        var acts = '';
        if (isMine) {
          if (e.canSellHouse(p, i)) acts += '<button class="mini" data-act="sell" data-i="' + i + '">拆除 +' + money(Math.round((c.houseCost || 0) * C.houseSellRate)) + '</button>';
          if (e.canMortgage(p, i)) acts += '<button class="mini" data-act="mortgage" data-i="' + i + '">抵押 +' + money(Math.round(c.price * C.mortgageRate)) + '</button>';
          if (e.canUnmortgage(p, i)) acts += '<button class="mini" data-act="unmortgage" data-i="' + i + '">赎回 ' + money(Math.round(c.price * C.mortgageRate * C.unmortgageRate)) + '</button>';
        }
        return '<li class="' + (m ? 'is-mortgaged' : '') + '">' +
          '<span class="assets__name"><i class="swatch" style="--gc:' + (c.type === 'prop' ? DC.GROUPS[c.group].color : DC.TYPE_COLOR[c.type]) + '"></i>' + esc(c.name) +
          (h ? ' <i class="dot-h">' + self.houseLabel(h) + '</i>' : '') + (m ? ' <i class="tag">抵押中</i>' : '') + '</span>' +
          '<span class="assets__acts">' + acts + '</span></li>';
      }).join('');
      box.innerHTML =
        '<div class="assets__sum">' +
          '<div><span>现金</span><b class="mono">' + money(p.cash) + '</b></div>' +
          '<div><span>总资产</span><b class="mono">' + money(e.netWorth(p)) + '</b></div>' +
          '<div><span>产业</span><b class="mono">' + p.props.length + ' 处</b></div>' +
          '<div><span>出狱证</span><b class="mono">' + p.jailCards + ' 张</b></div>' +
        '</div>' +
        (rows ? '<ul class="assets__list">' + rows + '</ul>' : '<p class="empty">还没有产业。落到空地就能买下它。</p>');
      box.querySelectorAll('button[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = +b.dataset.i;
          if (b.dataset.act === 'build') e.buyHouse(p, i);
          else if (b.dataset.act === 'sell') e.sellHouse(p, i);
          else if (b.dataset.act === 'mortgage') e.mortgage(p, i);
          else if (b.dataset.act === 'unmortgage') e.unmortgage(p, i);
        });
      });
    },

    /* ---------------- 战报 / 规则 / 设置 / 菜单 ---------------- */
    openLog: function () {
      var s = this.e.state;
      var body = el('div', 'loglist');
      body.innerHTML = s.log.slice().reverse().map(function (l) {
        return '<li class="loglist__row loglist__row--' + l.kind + '"><span class="loglist__r">R' + l.round + '</span>' + esc(l.text) + '</li>';
      }).join('') || '<li class="empty">还没有记录</li>';
      this.sheet({ eyebrow: '战报 · LEDGER', title: '对局记录', body: body, actions: [{ label: '关闭', kind: 'ghost' }] });
    },

    openRules: function () {
      var html =
        '<div class="rules">' +
        '<h3>目标</h3><p>让其他玩家全部破产，最后剩下的玩家获胜。也可在结算时比较总资产排名。</p>' +
        '<h3>回合</h3><p>掷一枚骰子前进对应步数。</p>' +
        '<h3>买地与租金</h3><p>停在无主地产可以选择买下或转入拍卖。停在他人地产需付租金：集齐同组全部地产空地租金翻倍，升级后租金更高。</p>' +
        '<h3>升级土地</h3><p>再次停在<strong>自己已买下</strong>的地块（含车站、水厂、电厂）时，会提示是否升级。地产、车站、公用事业都可升到满级；也可在地契里拆除或抵押。</p>' +
        '<h3>监狱</h3><p>入狱后可缴纳保释金、使用出狱许可证，或掷骰求 6。三回合未掷出 6 将强制保释。</p>' +
        '<h3>卡牌与税收</h3><p>机会与命运会带来收益、罚款、位移或入狱。缴纳的罚款会进入免费停车场的奖池，停在停车场即可全部领取。</p>' +
        '<h3>破产</h3><p>现金不足时必须变卖资产；仍无法支付则宣告破产，产业转给债主（或由银行收回）。</p>' +
        '</div>';
      this.sheet({ eyebrow: '规则 · RULES', title: '怎么玩', body: html, actions: [{ label: '知道了', kind: 'primary' }] });
    },

    openSettings: function () {
      var self = this, e = this.e;
      var body = el('div', 'settings');
      body.innerHTML =
        '<div class="row"><span>音效</span><button type="button" class="switch" id="swSound" role="switch"></button></div>' +
        '<div class="row"><span>背景音乐</span><button type="button" class="switch" id="swMusic" role="switch"></button></div>' +
        '<div class="row"><span>震动反馈</span><button type="button" class="switch" id="swHaptic" role="switch"></button></div>' +
        '<div class="row"><span>减少动画</span><button type="button" class="switch" id="swMotion" role="switch"></button></div>' +
        '<div class="row"><span>动画速度</span><div class="seg" id="segSpeed">' +
          '<button type="button" data-v="0.65">慢</button><button type="button" data-v="1">标准</button><button type="button" data-v="1.7">快</button>' +
        '</div></div>' +
        '<div class="row row--wide"><button class="btn btn--ghost btn--wide" id="btnNewGame">重新开局</button></div>';
      this.sheet({ eyebrow: '设置 · SETTINGS', title: '偏好', body: body, actions: [{ label: '关闭', kind: 'ghost' }] });

      var swS = document.getElementById('swSound');
      var swM = document.getElementById('swMusic');
      var swH = document.getElementById('swHaptic');
      var swR = document.getElementById('swMotion');
      var sync = function () {
        swS.classList.toggle('is-on', e.settings.sound);
        swS.setAttribute('aria-checked', String(e.settings.sound));
        swM.classList.toggle('is-on', !!e.settings.music);
        swM.setAttribute('aria-checked', String(!!e.settings.music));
        swH.classList.toggle('is-on', e.settings.haptics);
        swH.setAttribute('aria-checked', String(e.settings.haptics));
        swR.classList.toggle('is-on', !!e.settings.reducedMotion);
        swR.setAttribute('aria-checked', String(!!e.settings.reducedMotion));
      };
      sync();
      swS.addEventListener('click', function () {
        e.settings.sound = !e.settings.sound;
        DC.audio.setEnabled(e.settings.sound);
        if (DC.saveSettings) DC.saveSettings();
        self.syncSound(); sync();
      });
      swM.addEventListener('click', function () {
        e.settings.music = !e.settings.music;
        if (DC.audio.setMusic) DC.audio.setMusic(e.settings.music);
        if (DC.saveSettings) DC.saveSettings();
        sync();
      });
      swH.addEventListener('click', function () {
        e.settings.haptics = !e.settings.haptics;
        if (DC.saveSettings) DC.saveSettings();
        sync();
      });
      swR.addEventListener('click', function () {
        e.settings.reducedMotion = !e.settings.reducedMotion;
        self.applyMotion();
        if (DC.saveSettings) DC.saveSettings();
        sync();
      });
      var seg = document.getElementById('segSpeed');
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('is-on', Math.abs(parseFloat(b.dataset.v) - e.settings.speed) < 0.01);
        b.addEventListener('click', function () {
          e.settings.speed = parseFloat(b.dataset.v);
          if (DC.saveSettings) DC.saveSettings();
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
        });
      });
      document.getElementById('btnNewGame').addEventListener('click', function () {
        self.closeSheet();
        self.openStart(true);
      });
    },

    openMenu: function () {
      var self = this;
      var body = el('div', 'menu');
      body.innerHTML =
        '<button class="menu__item" id="mLog">' + icon('i-list') + '<span>战报记录</span></button>' +
        '<button class="menu__item" id="mRules">' + icon('i-book') + '<span>规则说明</span></button>' +
        '<button class="menu__item" id="mSettings">' + icon('i-gear') + '<span>设置</span></button>' +
        '<button class="menu__item" id="mNew">' + icon('i-restart') + '<span>重新开局</span></button>';
      this.sheet({ eyebrow: '菜单 · MENU', title: '大富翁 · 地产小镇', sub: '第 ' + this.e.state.round + ' 回合', body: body, actions: [] });
      var go = function (fn) { return function () { self.closeSheet(); setTimeout(fn, 240); }; };
      document.getElementById('mLog').addEventListener('click', go(function () { self.openLog(); }));
      document.getElementById('mRules').addEventListener('click', go(function () { self.openRules(); }));
      document.getElementById('mSettings').addEventListener('click', go(function () { self.openSettings(); }));
      document.getElementById('mNew').addEventListener('click', go(function () { self.openStart(true); }));
    },

    /* ---------------- 开局 / 结算 ---------------- */
    openStart: function (fromMenu) {
      var self = this, e = this.e;
      var save = DC.Store.load();
      var body = el('div', 'start');
      body.innerHTML =
        '<p class="start__lead">' + (fromMenu ? '当前对局将结束，' : '') + '选择人数，开始一局新的对局。</p>' +
        '<div class="seg seg--big" id="segCount">' +
          '<button type="button" data-v="2">2 人</button><button type="button" data-v="3">3 人</button><button type="button" data-v="4">4 人</button>' +
        '</div>' +
        '<ul class="start__hint">' +
          '<li>' + icon('i-coin') + '起步资金 ' + money(C.startCash) + '，经过起点领 ' + money(C.goSalary) + '</li>' +
          '<li>' + icon('i-house') + '再次停在自己的地上，可升级提高租金</li>' +
          '<li>' + icon('i-jail') + '保释金 ' + money(C.jailFine) + '，也可以掷 6 出狱</li>' +
        '</ul>';
      var actions = [{ label: '开始新对局', kind: 'primary', icon: 'i-dice', onClick: function () { self.startGame(count); } }];
      if (save) {
        actions.unshift({ label: '继续上次对局', kind: 'ghost', onClick: function () { self.resumeGame(); } });
      }
      this.sheet({
        eyebrow: '大富翁 · 地产小镇',
        title: '开局',
        sub: '1930 · 上海地产',
        body: body,
        dismissible: !!fromMenu,
        actions: actions
      });
      var count = 4;
      var seg = document.getElementById('segCount');
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('is-on', +b.dataset.v === count);
        b.addEventListener('click', function () {
          count = +b.dataset.v;
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
        });
      });
    },

    startGame: function (count) {
      this.e.newGame(count);
      this.rebuildTokens();
      this.closeSheet();
      DC.audio.unlock();
      if (DC.audio.startMusic) DC.audio.startMusic();
      if (DC.audio.start) DC.audio.start();
      this.e.start();
    },

    resumeGame: function () {
      var snap = DC.Store.load();
      if (!snap) { this.toast('没有找到存档', 'danger'); return; }
      this.e.restore(snap);
      this.rebuildTokens();
      this.closeSheet();
      DC.audio.unlock();
      if (DC.audio.startMusic) DC.audio.startMusic();
      this.e.start();
    },

    rebuildTokens: function () {
      var self = this, s = this.e.state;
      this.els.tokens.innerHTML = '';
      this._tokenEls = [];
      s.players.forEach(function (p, i) {
        var t = el('div', 'token', '<span class="token__face">' + esc(p.short) + '</span><span class="token__ring"></span>');
        t.dataset.p = i;
        t.style.setProperty('--c', p.color);
        self._tokenEls[i] = t;
        self.els.tokens.appendChild(t);
      });
      this.els.strip.innerHTML = '';
      this.render();
    },

    result: function (ranking) {
      var self = this;
      var winner = ranking[0];
      var isMe = winner && !winner.isAI;
      var body = el('div', 'result');
      body.innerHTML =
        '<div class="result__crown">' + icon('i-crown') + '</div>' +
        '<p class="result__win"><b style="--c:' + winner.color + '">' + esc(winner.name) + '</b> 赢得这局</p>' +
        '<ol class="result__list">' + ranking.map(function (p, i) {
          return '<li><span class="result__rank">' + (i + 1) + '</span>' +
            '<span class="result__name"><i class="dot" style="--c:' + p.color + '"></i>' + esc(p.name) + '</span>' +
            '<span class="result__worth mono">' + money(self.e.netWorth(p)) + '</span>' +
            '<span class="result__tag">' + (p.bankrupt ? '破产' : p.props.length + ' 处') + '</span></li>';
        }).join('') + '</ol>';
      this.sheet({
        eyebrow: '结算 · FINAL LEDGER',
        title: isMe ? '你赢了' : '本局结束',
        body: body,
        dismissible: false,
        actions: [
          { label: '查看棋盘', kind: 'ghost' },
          { label: '再来一局', kind: 'primary', icon: 'i-restart', onClick: function () { self.openStart(true); } }
        ]
      });
    },

    /* ---------------- 卡牌 ---------------- */
    showCard: function (p, card, label, isAI) {
      var self = this;
      var node = el('div', 'cardfx cardfx--' + (label === '机会' ? 'chance' : 'fate'));
      node.innerHTML =
        '<div class="cardfx__inner">' +
          '<div class="cardfx__band"><span>' + esc(label) + ' · ' + (label === '机会' ? 'CHANCE' : 'FATE') + '</span></div>' +
          '<p class="cardfx__text">' + esc(card.text) + '</p>' +
          '<p class="cardfx__who">' + esc(p.name) + '</p>' +
        '</div>';
      this.els.fx.appendChild(node);
      requestAnimationFrame(function () { node.classList.add('is-in'); });
      var close = function () {
        node.classList.remove('is-in');
        node.classList.add('is-out');
        setTimeout(function () { node.remove(); }, 320);
      };
      if (isAI || this.e.settings.reducedMotion) {
        return new Promise(function (res) { setTimeout(function () { close(); res(); }, isAI ? 1500 : 1200); });
      }
      return new Promise(function (res) {
        var btn = el('button', 'btn btn--primary cardfx__btn', '<span class="btn__label">知道了</span>');
        btn.type = 'button';
        node.appendChild(btn);
        setTimeout(function () { btn.focus({ preventScroll: true }); }, 80);
        btn.addEventListener('click', function () { close(); res(); });
      });
    }
  };

  DC.UI = UI;
})(window.DC);
