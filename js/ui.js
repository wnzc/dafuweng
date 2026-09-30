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
  /* 卡牌大全养在弹层里。这里生成的是个文档内的小链接按钮，data-cards 记着
     「从哪儿来的」（rules / start），交给 init 里的一次事件委托统一接管 ——
     这样关掉卡牌大全时才知道该把哪个弹层放回来。 */
  function cardLink(text, from) {
    return '<button type="button" class="doclink" data-cards="' + from + '">' +
      esc(text) + '<i aria-hidden="true">›</i></button>';
  }

  /* 每张牌的详细作用：表格右列。每种 kind 都要有一句，否则右列会空一格 */
  function cardNote(c) {
    switch (c.kind) {
      case 'gain':
        return c.name
          ? '立即进账 ' + money(c.amount) + '，没有后续费用。'
          : '直接进账 ' + money(c.amount) + '，不触发其他结算。';
      case 'pay':
        return '从现金里扣 ' + money(c.amount) + '；现金不够时要先拆房或抵押筹款，仍不够才破产。';
      case 'payPerHouse':
        return '按你名下房屋总数计费（每栋 ' + money(c.amount) + '），一间房都没有就免付。';
      case 'collectAll':
        return '其他每位玩家各付你 ' + money(c.amount) + '，已经破产的不参与。';
      case 'moveTo':
        return c.target === C.goPos
          ? '移动到起点并结算，经过起点照常领薪。'
          : '移动到该格并结算落点：该买的地、该付的租一样不少。';
      case 'move':
        return (c.steps > 0 ? '前进 ' : '后退 ') + Math.abs(c.steps) + ' 格并结算落点。';
      case 'nearest':
        return '顺时针找到最近的车站，移动过去并结算。';
      case 'jail':
        return '直接送入监狱；没有出狱许可证就只能掷出 6 或缴保释金。';
      case 'jailCard':
        return '攒一张「出狱许可证」，入狱时可以立刻出狱。';
      case 'lapBonus':
        return '按你已经完成的圈数计价（每圈 ' + money(c.per) + '），上限 ' + money(c.cap) + '。';
      case 'freeHouse':
        return '在自有地产上免费升一级，同样受经典建房规则约束；一处都盖不了时折算 '
          + money(c.fallback) + ' 现金。';
      case 'item':
        return '从道具牌堆抽一张进手牌；手牌已满 ' + C.maxItems + ' 张时折算 '
          + money(C.itemFallback) + ' 现金。';
      /* 以下 5 种是道具卡 */
      case 'forceDie':
        return '本次掷骰直接按你指定的点数走（1–6），用来精确踩到想要的地。';
      case 'teleport':
        return '本回合不再掷骰，直接走到你选的那一格并结算；经过起点照常领薪。';
      case 'noRent':
        return '本回合踩到他人地产免付一次租金；抵押中的地产本来就免租，不会消耗护盾。';
      case 'doubleRent':
        return '从这一刻起、直到你下一次回合开始，别人踩到你的地租金翻倍。';
      default:
        return '';
    }
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
    this._homeVisible = false;
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
        hubPot: $('hubPot'),
        strip: $('strip'), ticker: $('ticker'), tickerNow: $('tickerNow'), dock: $('dock'),
        btnRoll: $('btnRoll'), btnAssets: $('btnAssets'), btnRules: $('btnRules'), btnLog: $('btnLog'),
        handbar: $('handbar'), hand: $('hand'),
        btnSound: $('btnSound'), btnMenu: $('btnMenu'),
        brand: $('brand'),
        home: $('home'),
        sheetLayer: $('sheetLayer'), toasts: $('toasts'), fx: $('fx')
      };

      this.buildBoard();
      this.buildHub();
      this.bindChrome();
      this.applyMotion();
      // 先把三个手牌空槽画出来：棋盘边长预算要按「手牌条已经占位」来算，
      // 否则开局瞬间手牌条撑开会把棋盘顶出舞台
      this.renderHand();

      // 棋盘取「可用区域」的正方形边长：任何视口下都不横滚、不裁切
      var stage = document.querySelector('.stage');
      var fit = function () {
        var cs = getComputedStyle(stage);
        var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        var padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        var w = stage.clientWidth - padX;
        // 两栏布局（大屏 / 横屏矮屏）：棋盘独占左栏，纵向预算里就**不该**再扣
        // 顶栏 / 玩家条 / 手牌条 / 战报条 / 操作坞 —— 它们在右栏，本来就不占棋盘的高度。
        // 单列才需要扣，那几条是叠在棋盘下面的。早先横屏没分情况，扣完只剩 51px，
        // 触发了下面的 `side > 100` 兜底直接 return，棋盘靠上一次的内联尺寸「碰巧」显示。
        var twoCol = window.matchMedia('(min-width: 900px)').matches ||
          window.matchMedia('(orientation: landscape) and (max-height: 560px)').matches;
        var availH;
        if (twoCol) {
          availH = window.innerHeight - padY - 16;     // 只留底部立体边与投影的余量
        } else {
          var chrome = self.els.hud.offsetHeight + self.els.strip.offsetHeight + self.els.dock.offsetHeight +
            (self.els.handbar ? self.els.handbar.offsetHeight : 0) +
            (self.els.ticker ? self.els.ticker.offsetHeight : 0);
          // 保留战报最小高度 + 底部投影余量，其余都给棋盘
          availH = window.innerHeight - chrome - 48 - Math.max(0, padY - 10);
        }
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
      this.fitBoard = fit;              // 手牌条显示/隐藏时也要重算（设置里切换道具卡）
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
      // 「卡牌大全」链接：弹层与首页共用这一次委托，data-cards 记着来源。
      // 挂在 document 上而不是 sheetLayer —— 首页的链接不在弹层里，挂在弹层上收不到。
      document.addEventListener('click', function (ev) {
        var t = ev.target;
        var link = t && t.closest && t.closest('[data-cards]');
        if (!link) return;
        ev.preventDefault();
        self.openCards(link.getAttribute('data-cards'));
      });
      // 主题变化（系统换肤、设置里改档、首页那颗按钮）都要刷新首页的图标。
      // 只在这里注册一次；syncHomeTheme 自己会在按钮不存在时跳过。
      if (DC.theme && DC.theme.onChange) DC.theme.onChange(function () { self.syncHomeTheme(); });
      // 左上角品牌区 = 回首页（整块是个按钮，键盘 Enter / Space 同样有效）
      this.els.brand.addEventListener('click', function () {
        self.e.buzz(8);
        self.goHome();
      });
      return this;
    },

    bindChrome: function () {
      var self = this, e = this.e;
      this.els.btnRoll.addEventListener('click', function () { e.pressRoll(); });
      this.els.btnAssets.addEventListener('click', function () { self.openAssets(); });
      this.els.btnRules.addEventListener('click', function () { self.openRules(); });
      this.els.btnLog.addEventListener('click', function () { self.openLog(); });
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
      // 首页不在 `.app` 里面，减少动画要单独挂一份
      if (this.els.home) this.els.home.classList.toggle('reduce-motion', on);
    },

    /* 首页右上角那颗主题按钮：图标画「按下去会变成什么」，白天挂月亮、黑夜挂太阳。
       首页没开（按钮不在 DOM 里）时什么也不做，所以可以安全地被主题变化回调反复调用。 */
    syncHomeTheme: function () {
      var btn = document.getElementById('homeTheme');
      if (!btn || !DC.theme) return;
      var dark = DC.theme.effective() === 'dark';
      btn.innerHTML = icon(dark ? 'i-sun' : 'i-moon');
      btn.setAttribute('aria-label', dark ? '切换到白天模式' : '切换到黑夜模式');
      btn.setAttribute('aria-pressed', String(dark));
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
        '</div>';
      this.els.hubRound = document.getElementById('hubRound');
      this.els.hubDice = document.getElementById('hubDice');
      this.els.hubWho = document.getElementById('hubWho');
      this.els.hubPot = document.getElementById('hubPot');
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
      if (this._itemsCtx) this.renderItemsBody();
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
            '<span class="chip__top"><b class="chip__name"></b>' +
              '<span class="chip__hand" hidden></span>' +
              '<span class="chip__badge"></span></span>' +
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
        // 手牌数：矮屏上 .chip__meta 会被整个隐藏，所以单独做一个角标，任何时候都看得见
        var hand = chip.querySelector('.chip__hand');
        var held = (p.items || []).length;
        var showHand = self.e.settings.itemCards !== false && held > 0 && !p.bankrupt;
        hand.hidden = !showHand;
        if (showHand) {
          hand.innerHTML = icon('i-cards') + '<b>' + held + '</b>';
          hand.setAttribute('title', p.name + ' 手牌 ' + held + ' 张');
        }
        chip.setAttribute('aria-label', p.name + ' 现金 ' + money(p.cash) +
          (showHand ? '，手牌 ' + held + ' 张' : '') + '，' + meta);
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
      this.renderHand();
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

    /* 战报条只留最新一条，完整记录在「全部」弹窗里 —— 所以这里只替换文本，不累积 DOM */
    ticker_: function (entry) {
      var node = this.els.tickerNow;
      if (!node) return;
      node.className = 'ticker__now ticker__item--' + entry.kind;
      node.textContent = 'R' + entry.round + ' · ' + entry.text;
      node.title = entry.text;
      if (!this.e.settings.reducedMotion) {
        void node.offsetWidth;
        node.classList.add('is-in');
      }
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
      var self = this;
      var s = this._sheet;
      if (!s) return;
      this._sheet = null;
      this._raiseCtx = null;
      this._assetsCtx = null;
      this._itemsCtx = null;
      var layer = this.els.sheetLayer;
      var node = s.node;
      node.classList.remove('is-in');
      node.classList.add('is-out');
      setTimeout(function () {
        if (!layer.contains(node)) return;          // 已经被新弹层顶掉
        layer.innerHTML = '';
        layer.hidden = true;
        document.body.classList.remove('is-locked');
        // 首页还开着时重画一遍：设置里的规则开关会改掉「规则速览」那几条
        if (self._homeVisible && self.renderHome) self.renderHome();
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
      if (p && !p.isAI && s.owners[i] === p.id && cell.houseCost) {
        var block = e.upgradeBlock(p, i);
        if (!block) hint = '再次落在这里时可升级（' + money(cell.houseCost) + '）';
        else if (block !== 'max') hint = e.upgradeBlockText(p, cell, block);
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
          var c = CELLS[i];
          // 赎回是花钱把自己救回来，方向安全，一键即可
          if (b.dataset.act === 'unmortgage') { e.unmortgage(p, i); return; }
          // 拆房只回半价、抵押要 110% 才赎得回来 —— 都不可逆，过一道确认
          if (b.dataset.act === 'sell') {
            self.confirmAction({
              eyebrow: '拆除房屋',
              title: c.name,
              sub: '收回 ' + money(Math.round((c.houseCost || 0) * C.houseSellRate)) + '（半价）',
              body: '<p class="cardsheet__how">房屋拆掉就回不来了，这块地的租金会跟着降一级。</p>',
              okLabel: '拆掉',
              onOk: function () { e.sellHouse(p, i); }
            });
            return;
          }
          if (b.dataset.act === 'mortgage') {
            self.confirmAction({
              eyebrow: '抵押地产',
              title: c.name,
              sub: '拿到 ' + money(Math.round(c.price * C.mortgageRate)) +
                '，赎回要付 ' + money(Math.round(c.price * C.mortgageRate * C.unmortgageRate)),
              body: '<p class="cardsheet__how">抵押期间别人踩到这块地不收租金；带房屋的地要先拆完房屋才能抵押。</p>',
              okLabel: '抵押',
              onOk: function () { e.mortgage(p, i); }
            });
          }
        });
      });
    },

    /* ---------------- 道具卡 ----------------
       手牌直接摆在棋盘正下方那排槽位里（index.html 里的 .handbar / .hand），不藏在弹层里。
       这里只做两件事：渲染那排迷你卡片，以及给「需要选目标」的牌提供输入界面。
       输入界面复用 sheet —— 遥控骰子选点数、专线直达选目的地，都是必须的输入，
       不是「查看手牌」的二级菜单。 */

    /* 手牌槽位：固定 C.maxItems 个，空的就是虚线框，有牌才填上内容。
       手牌签名没变就只更新可出牌状态，不重建 DOM（render 每回合会被叫很多次）。 */
    renderHand: function () {
      var self = this, e = this.e;
      var box = this.els.hand;
      if (!box) return;
      var off = e.settings.itemCards === false;
      if (this.els.handbar) this.els.handbar.hidden = off;
      if (off) { box.innerHTML = ''; box.dataset.sig = ''; return; }
      var me = this.humanPlayer();
      var list = (me && me.items) || [];
      var can = e.canUseItem(me);
      var sig = list.join(',');
      if (box.dataset.sig !== sig) {
        box.dataset.sig = sig;
        var html = '';
        for (var k = 0; k < C.maxItems; k++) {
          var it = list[k] ? DC.ITEM_BY_ID[list[k]] : null;
          html += it
            ? '<button type="button" class="hand__card" data-k="' + k + '"' +
                ' title="' + esc(it.text) + '　长按可丢弃">' +
                '<span class="hand__ico">' + icon(it.icon) + '</span>' +
                '<b class="hand__name">' + esc(it.name) + '</b>' +
              '</button>'
            : '<span class="hand__card is-empty" aria-hidden="true"></span>';
        }
        box.innerHTML = html;
        box.querySelectorAll('.hand__card[data-k]').forEach(function (b) { self.bindHandCard(b); });
      }
      box.querySelectorAll('.hand__card[data-k]').forEach(function (b) { b.classList.toggle('is-ready', can); });
      box.setAttribute('aria-label', list.length
        ? '手牌 ' + list.length + ' 张' + (can ? '，现在可以出牌' : '')
        : '手牌为空');
    },

    /* 单张手牌：点一下出牌，长按 550ms 改为丢弃。
       丢弃是不可逆的（少一张牌），所以长按之后还要过一次确认弹层。 */
    bindHandCard: function (b) {
      var self = this;
      var timer = null, longPressed = false;
      var down = function (ev) {
        if (ev && ev.button !== undefined && ev.button !== 0) return;   // 右键不参与长按
        longPressed = false;
        timer = setTimeout(function () {
          timer = null;
          longPressed = true;
          self.confirmDiscard(+b.dataset.k);
        }, 550);
      };
      var up = function () { if (timer) { clearTimeout(timer); timer = null; } };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
      b.addEventListener('click', function (ev) {
        if (longPressed) { longPressed = false; ev.preventDefault(); return; }
        self.onHandPick(+b.dataset.k);
      });
    },

    /* 长按手牌后的确认。不能丢的时候（不是自己的回合）给一句提示就收 */
    confirmDiscard: function (idx) {
      var self = this, e = this.e, me = this.humanPlayer();
      var it = me && DC.ITEM_BY_ID[(me.items || [])[idx]];
      if (!it) return;
      if (!e.canDiscardItem(me)) { this.toast('现在不能整理手牌', 'info'); return; }
      this.confirmAction({
        eyebrow: '丢弃道具',
        title: it.name,
        sub: it.text,
        body: '<p class="cardsheet__how">丢掉就没了，好处是手牌空出一格 —— ' +
          '手牌满的时候绕圈是收不到新牌的。牌堆抽空重洗时，这张会回到牌堆里。</p>',
        okLabel: '丢掉',
        onOk: function () { e.discardItem(me, idx); }
      });
    },

    /* 不可逆操作的统一确认层：拆房只回半价、抵押要 110% 才能赎回、弃牌少一张。
       注意「被迫筹款」那条路径（renderRaiseBody）不走这里 —— 那儿的玩家已经在
       明确地筹钱了，再拦一道只会添堵。 */
    confirmAction: function (opts) {
      this.sheet({
        eyebrow: opts.eyebrow || '确认',
        title: opts.title,
        sub: opts.sub,
        body: opts.body,
        dismissible: true,
        actions: [
          { label: '取消', kind: 'ghost' },
          { label: opts.okLabel || '确定', kind: opts.okKind || 'danger', onClick: opts.onOk }
        ]
      });
    },

    /* 点手牌：能出就直接出；要选目标的先要个输入；轮不到你出牌时，点一下当说明看 */
    onHandPick: function (idx) {
      var e = this.e, me = this.humanPlayer();
      var it = me && DC.ITEM_BY_ID[(me.items || [])[idx]];
      if (!it) return;
      if (!e.canUseItem(me)) {
        this.toast(it.name + '：' + it.text, 'info');
        return;
      }
      if (it.kind === 'forceDie' || it.kind === 'teleport') { this.openItemPicker(idx, it); return; }
      this.castItem(idx);
    },

    openItemPicker: function (idx, item) {
      var self = this;
      var view = item.kind === 'forceDie' ? 'die' : 'spot';
      this._itemsCtx = { view: view, idx: idx };
      this.sheet({
        kind: 'items',
        eyebrow: '道具 · ' + item.name,
        title: view === 'die' ? '指定点数' : '选择目的地',
        body: el('div', 'items'), dismissible: true,
        actions: [{ label: '取消', kind: 'ghost' }],
        onDismiss: function () { self._itemsCtx = null; }
      });
      this.renderItemsBody();
    },

    renderItemsBody: function () {
      var self = this, e = this.e, ctx = this._itemsCtx;
      if (!ctx) return;
      var layer = this.els.sheetLayer;
      var box = layer && layer.querySelector('.items');
      if (!box) { this._itemsCtx = null; return; }
      var me = this.humanPlayer();

      if (ctx.view === 'die') {
        box.innerHTML =
          '<p class="items__lead">遥控骰子：本次掷骰按你指定的点数走。</p>' +
          '<div class="items__dice">' +
          [1, 2, 3, 4, 5, 6].map(function (v) {
            return '<button type="button" class="items__pip" data-n="' + v + '"><b>' + v + '</b><span>' + v + ' 格</span></button>';
          }).join('') +
          '</div>';
        box.querySelectorAll('.items__pip').forEach(function (b) {
          b.addEventListener('click', function () { if (self.castItem(ctx.idx, +b.dataset.n)) self.closeSheet(); });
        });
        return;
      }

      var rows = CELLS.map(function (c) {
        var oid = e.state.owners[c.i];
        var owner = (oid !== undefined && oid !== null) ? e.state.players[oid] : null;
        var here = !!me && me.pos === c.i;
        var gc = c.type === 'prop' ? DC.GROUPS[c.group].color : (DC.TYPE_COLOR[c.type] || '#8FA6C4');
        var tag = here ? '当前位置' : (owner ? owner.name + ' 持有' : (c.price ? '无主 · ' + money(c.price) : DC.TYPE_LABEL[c.type]));
        return '<li><button type="button" class="items__spot" data-i="' + c.i + '"' + (here ? ' disabled' : '') + '>' +
          '<span class="items__spot-name"><i class="swatch" style="--gc:' + gc + '"></i>' + esc(c.name) + '</span>' +
          '<span class="items__spot-tag">' + esc(tag) + '</span></button></li>';
      }).join('');
      box.innerHTML =
        '<p class="items__lead">专线直达：本回合不掷骰，直接前往该格并结算；经过起点照常领 ' + money(C.goSalary) + '。</p>' +
        '<ul class="items__spots">' + rows + '</ul>';
      box.querySelectorAll('.items__spot').forEach(function (b) {
        b.addEventListener('click', function () { if (self.castItem(ctx.idx, +b.dataset.i)) self.closeSheet(); });
      });
    },

    /* 真正出牌。失败时引擎不消耗手牌，这里只负责把原因说给玩家听 */
    castItem: function (idx, target) {
      var e = this.e, me = this.humanPlayer();
      var item = me && DC.ITEM_BY_ID[(me.items || [])[idx]];
      var res = e.useItem(me, idx, target);
      if (!res.ok) { this.toast(res.reason || '无法使用这张道具', 'danger'); return false; }
      this.toast(item ? '使用「' + item.name + '」' : '已使用道具', 'info');
      return true;
    },

    /* ---------------- 战报 / 规则 / 设置 / 菜单 ---------------- */
    openLog: function () {
      var s = this.e.state;
      var body = el('div', 'loglist');
      body.innerHTML = s.log.slice().reverse().map(function (l) {
        return '<li class="loglist__row loglist__row--' + l.kind + '"><span class="loglist__r">R' + l.round + '</span>' + esc(l.text) + '</li>';
      }).join('') || '<li class="empty">还没有记录</li>';
      this.sheet({
        eyebrow: '战报 · LEDGER', title: '对局记录',
        sub: s.log.length ? '本次存档保留的最近 ' + s.log.length + ' 条（新在上）' : undefined,
        body: body, actions: [{ label: '关闭', kind: 'ghost' }]
      });
    },

    openRules: function () {
      var html =
        '<div class="rules">' +
        '<h3>目标</h3><p>让其他玩家全部破产，最后剩下的玩家获胜。也可在结算时比较总资产排名。</p>' +
        '<h3>回合</h3><p>掷一枚骰子前进对应步数。</p>' +
        '<h3>买地与租金</h3><p>停在无主地产可以选择买下或转入拍卖。停在他人地产需付租金：集齐同组全部地产空地租金翻倍，升级后租金更高。</p>' +
        '<h3>升级土地</h3><p>再次停在<strong>自己已买下</strong>的地块（含车站、水厂、电厂）时，会提示是否升级。地产、车站、公用事业都可升到满级；也可在地契里拆除或抵押。</p>' +
        '<h3>经典建房规则</h3><p>默认开启，三条限制只作用于分组的<strong>地产</strong>：必须先<strong>集齐同组全部地产</strong>才能在该组建房；同组内房屋数要均衡（相差不超过 1 栋）；同组内有地块处于抵押状态时不能建房。车站与公用事业没有分组、租金按持有数量计价，不受这三条限制。</p><p>觉得节奏太慢，可以在「设置」里关掉，退回「单块地即可一路升到酒店」的宽松规则。</p>' +
        '<h3>监狱</h3><p>入狱后可缴纳保释金、使用出狱许可证，或掷骰求 6。三回合未掷出 6 将强制保释。</p>' +
        '<h3>卡牌与税收</h3><p>机会与命运会带来收益、罚款、位移或入狱。缴纳的罚款会进入免费停车场的奖池，停在停车场即可全部领取。</p>' +
        '<p>' + cardLink('卡牌大全：四副牌组共 45 张的完整牌面与作用', 'rules') + '</p>' +
        '<h3>技能卡</h3><p>独立于机会与命运的一副牌，<strong>不占手牌、也没有出牌时机</strong>：每完成一圈自动抽一张，效果当场结算。整体偏收益（施工补贴、贷款贴息、按圈数分红、免费加盖一栋房屋），也夹着违建拆除、年度审计、稽查传唤这类负项。</p><p>其中「路网分红」按你已完成的圈数计价，上限 ¥1,500；「免费加盖」同样受经典建房规则的约束，若当时没有可加盖的地产，会折算为 ¥500 现金，不会空手。</p><p>不想要这套牌，可以在「设置 → 技能卡」里关掉，绕圈就不再发牌。</p>' +
        '<h3>道具卡</h3><p>与上面两副牌的关键差别是<strong>进手牌、由你主动打出</strong>：机会 / 命运里能抽到，每绕完一圈也会发一张，手牌上限 3 张。手牌就摆在<strong>棋盘正下方</strong>：固定三个位置，空格显示虚线框，有牌就是一张「上图下字」的小卡片，一直可见，点一下就能出牌。</p><p>出牌时机只有一处 —— <strong>自己的回合、按下「掷骰子」之前</strong>，每回合最多 1 张；轮到你能出牌时，这几张小卡片会亮起来。共 5 张：遥控骰子（指定本次点数）、专线直达（本回合不掷骰，直接前往任意地块并结算）、免租护盾（本回合免付一次他人地产的租金）、双倍收租（从这一刻直到你下次回合开始，别人踩到你的地租金翻倍）、紧急信贷（立即获得 ¥1,500）。免租护盾只活本回合；双倍收租要靠对手来踩才兑现，所以它跨过整轮对手。</p><p>手牌满了以后再绕圈不会再发牌（不会折算现金，免得「囤牌」反而成了收入）。这时可以<strong>长按手牌丢弃</strong>一张用不出去的 —— 比如地图上已经没有可买的地时，「专线直达」就是死牌，一直占着位置。轮不到你出牌时点一下卡片，会提示这张牌的效果。不想要这套牌，可以在「设置 → 道具卡」里关掉。</p>' +
        '<h3>破产</h3><p>现金不足时必须变卖资产；仍无法支付则宣告破产，产业转给债主（或由银行收回）。</p>' +
        '</div>';
      this.sheet({ eyebrow: '规则 · RULES', title: '怎么玩', body: html, actions: [{ label: '知道了', kind: 'primary' }] });
    },

    /* ---------------- 卡牌大全 ----------------
       四副牌组的全部牌面，表格列在弹层里。牌面现读 DC，不在这里另抄一份，
       所以改数值 / 加卡片时这里不用动。

       入口是「规则」/「首页」/「开局」弹层里的 .doclink 小链接，data-cards 记着来源。
       关掉时要**把来源放回来**：sheet() 是硬切换（旧弹层已被 innerHTML 清掉），
       所以不是「保留」而是重新打开一次 —— 这也是开局那处要带上已选人数的原因。
       首页不是弹层（是覆盖层），返回时先关掉卡牌大全再把它亮出来。 */
       openCards: function (from) {
       var self = this;
       var back = from === 'start' ? function () { self.openStart(true, self._startCount); }
         : from === 'home' ? function () { self.closeSheet(); self.openHome(); }
           : from === 'rules' ? function () { self.openRules(); }
             : null;
      var decks = [
        { name: '机会', list: DC.CHANCE, how: '落在 2 处「机会」格（第 8、20 格）时抽一张，当场结算，不进手牌。' },
        { name: '命运', list: DC.FATE, how: '落在 2 处「命运」格（第 2、14 格）时抽一张，当场结算，不进手牌。' },
        { name: '技能卡', list: DC.SKILL, how: '每绕完一圈发一张，当场结算，不进手牌。' },
        {
          name: '道具卡', list: DC.ITEMS,
          how: '每绕完一圈发一张，机会 / 命运里也能抽到。进手牌（上限 ' + C.maxItems +
            ' 张），自己回合按下「掷骰子」之前才能打出，每回合 1 张；长按手牌可以丢弃，腾出位置收新牌。'
        }
      ];
      var total = decks.reduce(function (n, d) { return n + d.list.length; }, 0);
      var html = '<div class="cardsheet">' + decks.map(function (d) {
        return '<section>' +
          '<h3>' + d.name + ' · ' + d.list.length + ' 张</h3>' +
          '<p class="cardsheet__how">' + esc(d.how) + '</p>' +
          '<table>' +
            '<thead><tr><th scope="col">卡牌</th><th scope="col">详细作用</th></tr></thead>' +
            '<tbody>' + d.list.map(function (c) {
              return '<tr><td>' + esc(c.name || c.text) + '</td>' +
                '<td>' + esc(cardNote(c)) + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table>' +
          '</section>';
      }).join('') + '</div>';
      this.sheet({
        eyebrow: '四副牌组 · 共 ' + total + ' 张',
        title: '卡牌大全',
        body: html,
        actions: [{
          label: back ? (from === 'start' ? '返回开局' : from === 'home' ? '返回首页' : '返回规则') : '关闭',
          kind: 'ghost',
          close: false,       // 关键：不能让它顺手把刚放回来的来源弹层也关掉
          onClick: back || function () { self.closeSheet(); }
        }],
        onDismiss: back || undefined   // ✕ / 点遮罩 / Esc 走同一条回头路
      });
    },

    openSettings: function () {
      var self = this, e = this.e;
      var body = el('div', 'settings');
      body.innerHTML =
        '<div class="row"><span>音效</span><button type="button" class="switch" id="swSound" role="switch"></button></div>' +
        '<div class="row"><span>背景音乐</span><button type="button" class="switch" id="swMusic" role="switch"></button></div>' +
        '<div class="row"><span>震动反馈</span><button type="button" class="switch" id="swHaptic" role="switch"></button></div>' +
        '<div class="row"><span>减少动画</span><button type="button" class="switch" id="swMotion" role="switch"></button></div>' +
        '<div class="row"><span>经典建房规则</span><button type="button" class="switch" id="swClassic" role="switch"></button></div>' +
        '<div class="row"><span>技能卡</span><button type="button" class="switch" id="swSkill" role="switch"></button></div>' +
        '<div class="row"><span>道具卡</span><button type="button" class="switch" id="swItem" role="switch"></button></div>' +
        '<div class="row"><span>动画速度</span><div class="seg" id="segSpeed">' +
          '<button type="button" data-v="0.65">慢</button><button type="button" data-v="1">标准</button><button type="button" data-v="1.7">快</button>' +
        '</div></div>' +
        '<div class="row"><span>主题</span><div class="seg" id="segTheme">' +
          '<button type="button" data-v="auto">跟随系统</button><button type="button" data-v="light">白天</button><button type="button" data-v="dark">黑夜</button>' +
        '</div></div>' +
        '<div class="row row--wide"><button class="btn btn--ghost btn--wide" id="btnNewGame">重新开局</button></div>';
      this.sheet({ eyebrow: '设置 · SETTINGS', title: '偏好', body: body, actions: [{ label: '关闭', kind: 'ghost' }] });

      var swS = document.getElementById('swSound');
      var swM = document.getElementById('swMusic');
      var swH = document.getElementById('swHaptic');
      var swR = document.getElementById('swMotion');
      var swC = document.getElementById('swClassic');
      var swK = document.getElementById('swSkill');
      var swI = document.getElementById('swItem');
      var sync = function () {
        swS.classList.toggle('is-on', e.settings.sound);
        swS.setAttribute('aria-checked', String(e.settings.sound));
        swM.classList.toggle('is-on', !!e.settings.music);
        swM.setAttribute('aria-checked', String(!!e.settings.music));
        swH.classList.toggle('is-on', e.settings.haptics);
        swH.setAttribute('aria-checked', String(e.settings.haptics));
        swR.classList.toggle('is-on', !!e.settings.reducedMotion);
        swR.setAttribute('aria-checked', String(!!e.settings.reducedMotion));
        swC.classList.toggle('is-on', e.settings.classicRules !== false);
        swC.setAttribute('aria-checked', String(e.settings.classicRules !== false));
        swK.classList.toggle('is-on', e.settings.skillCards !== false);
        swK.setAttribute('aria-checked', String(e.settings.skillCards !== false));
        swI.classList.toggle('is-on', e.settings.itemCards !== false);
        swI.setAttribute('aria-checked', String(e.settings.itemCards !== false));
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
      swC.addEventListener('click', function () {
        e.settings.classicRules = e.settings.classicRules === false;
        if (DC.saveSettings) DC.saveSettings();
        sync();
        self.toast(e.settings.classicRules
          ? '已开启经典建房规则：集齐整组才能建房'
          : '已关闭经典建房规则：单块地即可建房', 'info');
      });
      swK.addEventListener('click', function () {
        e.settings.skillCards = e.settings.skillCards === false;
        if (DC.saveSettings) DC.saveSettings();
        sync();
        self.toast(e.settings.skillCards
          ? '已开启技能卡：每绕完一圈抽一张'
          : '已关闭技能卡：绕圈不再发牌', 'info');
      });
      swI.addEventListener('click', function () {
        e.settings.itemCards = e.settings.itemCards === false;
        if (DC.saveSettings) DC.saveSettings();
        sync();
        self.renderHand();
        if (self.fitBoard) self.fitBoard();
        self.toast(e.settings.itemCards
          ? '已开启道具卡：机会 / 命运与每绕一圈都可能发到'
          : '已关闭道具卡：不再发牌，手牌入口一并隐藏', 'info');
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
      // 主题：auto 跟着系统走，light / dark 手动锁定；落地由 DC.theme 负责
      var segTheme = document.getElementById('segTheme');
      var themeNote = { auto: '主题跟随系统', light: '已切到白天', dark: '已切到黑夜' };
      segTheme.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('is-on', b.dataset.v === (e.settings.theme || 'auto'));
        b.addEventListener('click', function () {
          e.settings.theme = b.dataset.v;
          if (DC.theme) DC.theme.set(e.settings.theme);
          if (DC.saveSettings) DC.saveSettings();
          segTheme.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
          self.toast(themeNote[b.dataset.v] || '主题已切换', 'info');
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

    /* ---------------- 首页 ----------------
       进游戏先落在这一页上：人数、规则、存档入口全部铺在页面里，不再一进来就弹底部
       弹窗。首页是一层固定覆盖层（`.home`），棋盘与操作坞在它后面照常建好、量好尺寸
       —— 点「开始」只是把它淡出，不参与棋盘的高度预算，也不会把布局顶乱。 */
    hintsHtml: function () {
      var e = this.e;
      return '<ul class="start__hint">' +
        '<li>' + icon('i-coin') + '起步资金 ' + money(C.startCash) + '，经过起点领 ' + money(C.goSalary) + '</li>' +
        '<li>' + icon('i-house') + (e.settings.classicRules !== false
          ? '集齐同组地产后才能建房，再次停在自己的地上即可升级'
          : '再次停在自己的地上，可升级提高租金') + '</li>' +
        '<li>' + icon('i-jail') + '保释金 ' + money(C.jailFine) + '，也可以掷 6 出狱</li>' +
        (e.settings.skillCards !== false
          ? '<li>' + icon('i-bolt') + '每绕完一圈抽一张技能卡，效果当场结算</li>'
          : '') +
        (e.settings.itemCards !== false
          ? '<li>' + icon('i-list') + '道具卡进手牌（上限 3 张），摆在棋盘下方，掷骰前点它出牌</li>'
          : '') +
        '</ul>';
    },

    renderHome: function () {
      var self = this, e = this.e;
      var home = this.els.home;
      if (!home) return;
      var save = DC.Store.load();
      var count = this._startCount || 4;
      // 规则折叠默认收起，展开状态存在实例上，设置弹层关掉重画首页也不会被收回去
      var foldOpen = !!this._rulesOpen;
      home.innerHTML =
        '<div class="home__top">' +
          '<button class="icon-btn" id="homeTheme" type="button"></button>' +
          '<button class="icon-btn" id="homeSound" type="button" aria-label="音效开关"></button>' +
          '<button class="icon-btn" id="homeSettings" type="button" aria-label="设置">' + icon('i-gear') + '</button>' +
        '</div>' +
        // 太阳 / 月亮：用 --sun-* 令牌画，跟着主题走，不放进插画里
        '<span class="home__sun" aria-hidden="true"></span>' +
        '<div class="home__scroll">' +
          '<div class="home__inner">' +
            '<div class="home__hero">' +
              '<span class="home__mark" aria-hidden="true">' + icon('i-house') + '</span>' +
              '<h1 class="home__title">大富翁</h1>' +
              '<p class="home__sub">地产小镇 · CUTE TYCOON</p>' +
            '</div>' +
            // 两个按钮落在页面正中间，人数与规则放在它们下面
            '<div class="home__actions">' +
              (save ? '<button class="btn btn--ghost" id="homeResume" type="button">' + icon('i-restart') +
                '<span class="btn__label">继续上次对局</span></button>' : '') +
              '<button class="btn btn--primary" id="homeStart" type="button">' + icon('i-dice') +
                '<span class="btn__label">开始新对局</span></button>' +
            '</div>' +
            '<div class="home__panel">' +
              '<section class="home__sect">' +
                '<p class="home__label">选择人数 · PLAYERS</p>' +
                '<div class="seg seg--big" id="homeSeg">' +
                  '<button type="button" data-v="2">2 人</button>' +
                  '<button type="button" data-v="3">3 人</button>' +
                  '<button type="button" data-v="4">4 人</button>' +
                '</div>' +
              '</section>' +
              // 规则速览收进 <details>：原生折叠，键盘 / 读屏都不用额外接线
              '<details class="home__sect home__fold" id="homeFold"' + (foldOpen ? ' open' : '') + '>' +
                '<summary class="home__label">规则速览 · RULES' + icon('i-chev') + '</summary>' +
                self.hintsHtml() +
              '</details>' +
              '<p class="home__cards">' +
                '<button type="button" class="doclink" id="homeRules">完整规则说明<i aria-hidden="true">›</i></button>' +
                ' · ' + cardLink('卡牌大全', 'home') +
              '</p>' +
            '</div>' +
          '</div>' +
        '</div>';

      // 主题快切：一按就在白天 / 黑夜之间翻，「跟随系统」那一档留在设置里。
      // 图标画的是「按下去会变成什么」—— 白天里挂月亮，黑夜里挂太阳。
      var themeBtn = document.getElementById('homeTheme');
      self.syncHomeTheme();
      themeBtn.addEventListener('click', function () {
        var next = (DC.theme && DC.theme.effective() === 'dark') ? 'light' : 'dark';
        e.settings.theme = next;
        if (DC.theme) DC.theme.set(next);
        if (DC.saveSettings) DC.saveSettings();
        self.toast(next === 'dark' ? '已切到黑夜模式' : '已切到白天模式', 'info');
      });

      var sound = document.getElementById('homeSound');
      var syncSound = function () {
        sound.innerHTML = icon(e.settings.sound ? 'i-sound' : 'i-mute');
        sound.setAttribute('aria-label', e.settings.sound ? '关闭音效' : '开启音效');
        sound.setAttribute('aria-pressed', String(!!e.settings.sound));
      };
      syncSound();
      sound.addEventListener('click', function () {
        e.settings.sound = !e.settings.sound;
        DC.audio.setEnabled(e.settings.sound);
        if (DC.saveSettings) DC.saveSettings();
        self.syncSound();
        syncSound();
        self.toast(e.settings.sound ? '音效已开启' : '音效已静音', 'info');
      });
      document.getElementById('homeSettings').addEventListener('click', function () { self.openSettings(); });
      document.getElementById('homeRules').addEventListener('click', function () { self.openRules(); });
      var fold = document.getElementById('homeFold');
      fold.addEventListener('toggle', function () { self._rulesOpen = fold.open; });
      if (save) document.getElementById('homeResume').addEventListener('click', function () { self.resumeGame(); });

      var seg = document.getElementById('homeSeg');
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('is-on', +b.dataset.v === count);
        b.addEventListener('click', function () {
          count = +b.dataset.v;
          self._startCount = count;
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
        });
      });
      document.getElementById('homeStart').addEventListener('click', function () { self.startGame(count); });
    },

    openHome: function () {
      var home = this.els.home;
      if (!home) return;
      this._homeVisible = true;
      this.renderHome();
      home.hidden = false;
      home.classList.remove('is-out');
      // 首页盖住了游戏本体，别让读屏把后面的棋盘也念出来
      if (this.els.app) this.els.app.setAttribute('aria-hidden', 'true');
    },

    /* 游戏里点左上角品牌区回首页。对局还在跑就先把回合循环掐掉（`engine.abort`）：
       存档仍是最后一次「轮到你掷骰」，所以「继续上次对局」会退回那个干净的点，
       而不是停在一半的移动动画里。 */
    goHome: function () {
      if (this._homeVisible) return;
      var s = this.e.state;
      if (s && !s.over) this.e.abort();
      if (this._sheet) this.closeSheet();
      this.openHome();
    },

    hideHome: function () {
      if (!this._homeVisible) return;
      var self = this;
      this._homeVisible = false;
      var home = this.els.home;
      if (!home) return;
      home.classList.add('is-out');
      if (this.els.app) this.els.app.removeAttribute('aria-hidden');
      setTimeout(function () {
        if (self._homeVisible) return;   // 又开回来了，别把它藏掉
        home.hidden = true;
        home.classList.remove('is-out');
      }, 240);
    },

    /* ---------------- 开局 / 结算 ---------------- */
    openStart: function (fromMenu, initialCount) {
      var self = this;
      var save = DC.Store.load();
      var body = el('div', 'start');
      body.innerHTML =
        '<p class="start__lead">' + (fromMenu ? '当前对局将结束，' : '') + '选择人数，开始一局新的对局。</p>' +
        '<div class="seg seg--big" id="segCount">' +
          '<button type="button" data-v="2">2 人</button><button type="button" data-v="3">3 人</button><button type="button" data-v="4">4 人</button>' +
        '</div>' +
        this.hintsHtml() +
        '<p class="start__cards">' + cardLink('卡牌大全：四副牌组每一张牌的作用', 'start') + '</p>';
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
      // 从卡牌大全返回时带着上次选的人数，别退回默认 4 人
      var count = initialCount || this._startCount || 4;
      this._startCount = count;
      var seg = document.getElementById('segCount');
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('is-on', +b.dataset.v === count);
        b.addEventListener('click', function () {
          count = +b.dataset.v;
          self._startCount = count;
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
        });
      });
    },

    startGame: function (count) {
      this.e.newGame(count);
      this.hideHome();
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
      this.hideHome();
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
    /* label → 卡面配色与英文副标。机会走金色、命运走紫色、技能卡走青色。 */
    cardSkin: function (label) {
      if (label === '机会') return { key: 'chance', en: 'CHANCE' };
      if (label === '技能') return { key: 'skill', en: 'SKILL' };
      return { key: 'fate', en: 'FATE' };
    },
    showCard: function (p, card, label, isAI) {
      var self = this;
      var skin = this.cardSkin(label);
      var node = el('div', 'cardfx cardfx--' + skin.key);
      node.innerHTML =
        '<div class="cardfx__inner">' +
          '<div class="cardfx__band"><span>' + esc(label) + ' · ' + skin.en + '</span></div>' +
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
