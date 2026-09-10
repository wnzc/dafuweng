/* ============================================================
   规则引擎：回合循环 + 全部规则 + AI + 存档
   与 UI 解耦：状态变化走 emit('state')，动画/弹层走 this.ui.*
   ============================================================ */
window.DC = window.DC || {};

(function (DC) {
  'use strict';

  var C = DC.CONFIG;
  var U = DC.util;
  var CELLS = DC.CELLS;
  var money = U.money;

  var SAVE_KEY = 'dc.monopoly.save.v1';

  /* ---------------- 存档 ---------------- */
  DC.Store = {
    save: function (state) {
      try {
        var snap = JSON.parse(JSON.stringify({
          v: C.version, players: state.players, current: state.current, round: state.round,
          dice: state.dice, owners: state.owners, houses: state.houses, mortgaged: state.mortgaged,
          pot: state.pot, log: state.log.slice(-40), chance: state.chance, chanceIdx: state.chanceIdx,
          fate: state.fate, fateIdx: state.fateIdx, over: state.over
        }));
        localStorage.setItem(SAVE_KEY, JSON.stringify(snap));
        return true;
      } catch (e) { return false; }
    },
    load: function () {
      try {
        var raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || s.v !== C.version || !s.players || s.over) return null;
        return s;
      } catch (e) { return null; }
    },
    clear: function () { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }
  };

  /* ---------------- 引擎 ---------------- */
  function Engine(ui, settings) {
    this.ui = ui || {};
    this.settings = Object.assign({
      sound: true,
      haptics: true,
      speed: 1,
      reducedMotion: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    }, settings || {});
    this.state = null;
    this._loopId = 0;
    this._rollResolve = null;
    this._askResolve = null;
    this._listeners = {};
  }

  Engine.prototype = {
    constructor: Engine,

    /* ---------- 事件 ---------- */
    on: function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); return this; },
    emit: function (t, p) { (this._listeners[t] || []).forEach(function (f) { f(p); }); },

    /* ---------- 工具 ---------- */
    delay: function (ms) {
      var f = this.settings.reducedMotion ? 0.15 : 1;
      var s = this.settings.speed || 1;
      var d = Math.max(0, Math.round(ms * f / s));
      if (d === 0) return Promise.resolve();
      return new Promise(function (r) { setTimeout(r, d); });
    },
    sfx: function (name) { if (this.settings.sound && this.ui.sfx) this.ui.sfx(name); },
    buzz: function (pattern) {
      if (!this.settings.haptics) return;
      if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
    },
    log: function (text, kind) {
      if (!this.state) return;
      var e = { text: text, kind: kind || 'info', round: this.state.round };
      this.state.log.push(e);
      if (this.state.log.length > C.maxLog) this.state.log.shift();
      this.emit('log', e);
    },
    player: function (id) {
      return this.state.players.filter(function (p) { return p.id === id; })[0];
    },
    get currentPlayer() { return this.state.players[this.state.current]; },
    alive: function () { return this.state.players.filter(function (p) { return !p.bankrupt; }); },

    /* ---------- 开局 ---------- */
    newGame: function (count) {
      var presets = DC.PLAYER_PRESETS.slice(0, count || 4);
      var players = presets.map(function (p, i) {
        return {
          id: i, name: p.name, short: p.short, color: p.color, isAI: p.isAI,
          cash: C.startCash, pos: 0, inJail: false, jailTurns: 0, jailCards: 0,
          doubles: 0, bankrupt: false, props: [], laps: 0
        };
      });
      this._loopId++;
      this._rollResolve = null;
      this._askResolve = null;
      this.state = {
        players: players, current: 0, round: 1, dice: [0, 0],
        owners: {}, houses: {}, mortgaged: {}, pot: 0, log: [],
        chance: U.shuffle(DC.CHANCE), chanceIdx: 0,
        fate: U.shuffle(DC.FATE), fateIdx: 0,
        ask: null, over: false, ranking: null, awaitingRoll: false,
        justJailed: false, busy: false, lastDeed: null
      };
      this.log('开局：' + players.map(function (p) { return p.name; }).join('、') + ' 各持 ' + money(C.startCash), 'info');
      this.emit('state');
      return this.state;
    },

    restore: function (snap) {
      this._loopId++;
      this._rollResolve = null;
      this._askResolve = null;
      this.state = Object.assign({
        ask: null, awaitingRoll: false, justJailed: false, busy: false, ranking: null, lastDeed: null
      }, snap);
      this.state.log = snap.log || [];
      this.state.players.forEach(function (p) { p.props = p.props || []; });
      this.log('已恢复上次对局', 'info');
      this.emit('state');
      return this.state;
    },

    start: function () {
      var self = this;
      var id = this._loopId;
      this.emit('state');
      return this.gameLoop(id).then(function () {
        if (self.state.over && id === self._loopId) self.finish();
      });
    },

    async gameLoop(id) {
      while (!this.state.over && id === this._loopId) {
        var p = this.currentPlayer;
        if (p && !p.bankrupt) {
          if (p.isAI) await this.delay(650);
          var again = true, guard = 0;
          while (again && !this.state.over && id === this._loopId && guard++ < 12) {
            again = await this.runTurn(p, id);
          }
        }
        if (this.state.over || id !== this._loopId) break;
        this.advance();
      }
    },

    advance: function () {
      var n = this.state.current, total = this.state.players.length, guard = 0;
      do {
        n = (n + 1) % total;
        if (n === this.state.current) break;
      } while (this.state.players[n].bankrupt && guard++ < total * 2);
      if (n <= this.state.current) this.state.round++;
      this.state.current = n;
      this.state.dice = [0, 0];
      this.emit('state');
    },

    /* ---------- 一个回合 ---------- */
    async runTurn(p, id) {
      var dice, extra = false;
      this.state.awaitingRoll = false;
      this.emit('state');

      if (p.inJail) {
        var jr = await this.handleJail(p);
        if (id !== this._loopId || p.bankrupt) return false;
        if (!jr.freed) return false;
        if (jr.dice) {
          this.setDice(jr.dice);
          if (this.ui.dice) await this.ui.dice(p, jr.dice, this);
          await this.moveBy(p, jr.dice[0] + jr.dice[1], id);
          if (id !== this._loopId) return false;
          await this.resolveLanding(p, id, 0);
          return false;
        }
      }

      if (!p.isAI) {
        this.state.awaitingRoll = true;
        this.emit('state');
        DC.Store.save(this.state);
        await this.waitRoll();
        this.state.awaitingRoll = false;
        this.emit('state');
      }
      if (id !== this._loopId || p.bankrupt) return false;

      dice = [U.rand(1, 6), U.rand(1, 6)];
      this.setDice(dice);
      this.sfx('dice');
      this.buzz(12);
      if (this.ui.dice) await this.ui.dice(p, dice, this);
      if (id !== this._loopId) return false;

      if (dice[0] === dice[1]) {
        p.doubles++;
        if (p.doubles >= 3) {
          this.log(p.name + ' 连掷三次双数，被警察带走', 'jail');
          await this.sendToJail(p);
          p.doubles = 0;
          return false;
        }
        extra = true;
        this.log(p.name + ' 掷出双 ' + dice[0] + '，可再掷一次', 'info');
      } else {
        p.doubles = 0;
      }

      this.log(p.name + ' 掷出 ' + dice[0] + ' + ' + dice[1] + ' = ' + (dice[0] + dice[1]), 'dice');
      await this.moveBy(p, dice[0] + dice[1], id);
      if (id !== this._loopId) return false;
      await this.resolveLanding(p, id, 0);
      if (this.state.over || p.bankrupt) return false;
      if (this.state.justJailed) { this.state.justJailed = false; return false; }
      return extra;
    },

    setDice: function (d) { this.state.dice = d.slice(); this.emit('state'); },

    waitRoll: function () {
      var self = this;
      return new Promise(function (res) { self._rollResolve = res; });
    },
    pressRoll: function () {
      if (!this.state || !this.state.awaitingRoll) return;
      var r = this._rollResolve; this._rollResolve = null;
      if (r) r();
    },

    /* ---------- 移动 ---------- */
    async moveBy(p, steps, id) {
      var dir = steps >= 0 ? 1 : -1, n = Math.abs(steps), passedGo = false, i;
      if (n > 0) await this.delay(C.rollPauseMs);   // 先让玩家看清骰子点数
      for (i = 0; i < n; i++) {
        if (id !== this._loopId) return;
        var prev = p.pos;
        p.pos = (p.pos + dir + 24) % 24;
        if (dir > 0 && p.pos < prev) { passedGo = true; p.laps++; }
        this.emit('move', { player: p, pos: p.pos });
        this.emit('step', { player: p, pos: p.pos });
        this.sfx('step');
        await this.delay(C.stepMs);
      }
      if (passedGo) {
        p.cash += C.goSalary;
        this.log(p.name + ' 经过起点，领取 ' + money(C.goSalary), 'money');
        this.sfx('coin');
        if (this.ui.float) this.ui.float('+' + money(C.goSalary), C.goPos, 'gain');
        if (this.ui.coinFly) this.ui.coinFly(C.goPos, p.id);
        this.emit('state');
      }
    },

    async moveToCell(p, target, opts) {
      opts = opts || {};
      var steps = (target - p.pos + 24) % 24;
      if (steps === 0) steps = 24;
      if (opts.backward) steps = -((p.pos - target + 24) % 24 || 24);
      if (opts.salary === false && steps === 24) { /* 直达起点不发薪 */ }
      await this.moveBy(p, steps, this._loopId);
      if (opts.salary) { /* 已在经过起点时发放 */ }
      this.emit('state');
    },

    /* ---------- 落格结算 ---------- */
    async resolveLanding(p, id, depth) {
      if (id !== this._loopId) return;
      var cell = CELLS[p.pos];
      this.emit('land', { player: p, cell: cell });
      if (cell.type === 'prop' || cell.type === 'rail' || cell.type === 'util') {
        await this.landOnProperty(p, cell, id, depth);
        return;
      }
      switch (cell.type) {
        case 'go':
          this.log(p.name + ' 停在起点', 'info');
          break;
        case 'tax': {
          var amt = Math.max(C.taxMin, U.roundTo(p.cash * C.taxRate, 100));
          this.log(p.name + ' 缴纳所得税 ' + money(amt), 'pay');
          if (this.ui.float) this.ui.float('−' + money(amt), p.pos, 'pay');
          if (this.ui.shake) this.ui.shake();
          await this.pay(p, null, amt, '所得税');
          break;
        }
        case 'parking':
          if (this.state.pot > 0) {
            this.log(p.name + ' 领取罚款池 ' + money(this.state.pot), 'money');
            if (this.ui.float) this.ui.float('+' + money(this.state.pot), p.pos, 'gain');
            if (this.ui.coinFly) this.ui.coinFly(p.pos, p.id);
            p.cash += this.state.pot;
            this.state.pot = 0;
            this.sfx('coin');
            this.emit('state');
          } else {
            this.log(p.name + ' 在免费停车场歇脚', 'info');
          }
          break;
        case 'gotojail':
          this.log(p.name + ' 被送入监狱', 'jail');
          await this.sendToJail(p);
          break;
        case 'chance':
          await this.drawCard(p, 'chance', '机会', depth);
          break;
        case 'fate':
          await this.drawCard(p, 'fate', '命运', depth);
          break;
        default:
          break;
      }
    },

    async landOnProperty(p, cell, id, depth) {
      var ownerId = this.state.owners[cell.i];
      if (ownerId === undefined || ownerId === null) {
        if (p.cash >= cell.price) {
          var choice = await this.offerPurchase(p, cell);
          if (id !== this._loopId) return;
          if (choice === 'buy') this.buy(p, cell, cell.price);
          else await this.runAuction(cell, p, id);
        } else {
          this.log(p.name + ' 现金不足，' + cell.name + ' 转入拍卖', 'info');
          await this.runAuction(cell, p, id);
        }
        return;
      }
      if (ownerId === p.id) { this.log(cell.name + ' 是 ' + p.name + ' 自己的产业', 'info'); return; }
      var owner = this.player(ownerId);
      if (!owner) return;
      if (this.state.mortgaged[cell.i]) { this.log(cell.name + ' 已抵押，本次免租', 'info'); return; }
      var rent = this.calcRent(cell);
      this.log(p.name + ' 踩到 ' + owner.name + ' 的 ' + cell.name + '，付租 ' + money(rent), 'rent');
      this.sfx('pay');
      if (this.ui.float) this.ui.float('−' + money(rent), cell.i, 'pay');
      if (this.ui.shake) this.ui.shake();
      await this.pay(p, owner, rent, cell.name + ' 租金');
    },

    calcRent: function (cell) {
      if (this.state.mortgaged[cell.i]) return 0;
      var ownerId = this.state.owners[cell.i];
      var p = this.player(ownerId);
      if (!p) return 0;
      if (cell.type === 'rail') {
        var n = this.countType(p, 'rail');
        return cell.rents[Math.min(n, 4) - 1] || 0;
      }
      if (cell.type === 'util') {
        var m = this.countType(p, 'util');
        var d = (this.state.dice[0] || 0) + (this.state.dice[1] || 0);
        return d * cell.mult[Math.min(m, 2) - 1];
      }
      var houses = this.state.houses[cell.i] || 0;
      if (houses > 0) return cell.rents[houses];
      return cell.rents[0] * (this.ownsGroup(p, cell.group) ? 2 : 1);
    },

    countType: function (p, type) {
      return p.props.filter(function (i) { return CELLS[i].type === type; }).length;
    },
    countHouses: function (p) {
      var self = this;
      return p.props.reduce(function (n, i) { return n + (self.state.houses[i] || 0); }, 0);
    },
    ownsGroup: function (p, group) {
      var cells = DC.GROUP_CELLS[group] || [];
      var self = this;
      return cells.length > 0 && cells.every(function (i) { return self.state.owners[i] === p.id; });
    },
    groupMax: function (group) {
      var self = this;
      return (DC.GROUP_CELLS[group] || []).reduce(function (m, i) { return Math.max(m, self.state.houses[i] || 0); }, 0);
    },
    groupMin: function (group) {
      var self = this;
      return (DC.GROUP_CELLS[group] || []).reduce(function (m, i) { return Math.min(m, self.state.houses[i] || 0); }, 99);
    },
    groupHasMortgage: function (group) {
      var self = this;
      return (DC.GROUP_CELLS[group] || []).some(function (i) { return !!self.state.mortgaged[i]; });
    },

    /* ---------- 购买 / 拍卖 ---------- */
    async offerPurchase(p, cell) {
      if (p.isAI) {
        await this.delay(520);
        var want = this.aiWantsToBuy(p, cell);
        if (!want) this.log(p.name + ' 放弃购买 ' + cell.name, 'info');
        return want ? 'buy' : 'auction';
      }
      var res = await this.ask({ type: 'buy', cellId: cell.i, playerId: p.id, price: cell.price });
      return res === 'buy' ? 'buy' : 'auction';
    },

    buy: function (p, cell, price) {
      p.cash -= price;
      this.state.owners[cell.i] = p.id;
      if (p.props.indexOf(cell.i) < 0) p.props.push(cell.i);
      this.state.lastDeed = cell.i;
      this.log(p.name + ' 买下 ' + cell.name + '（' + money(price) + '）', 'buy');
      this.sfx('stamp');
      this.buzz(18);
      if (this.ui.stamp) this.ui.stamp(cell);
      this.emit('state');
    },

    async runAuction(cell, initiator, id) {
      var self = this;
      var others = this.state.players.filter(function (p) { return !p.bankrupt && p !== initiator; });
      if (!others.length) { this.log('无人参与拍卖，' + cell.name + ' 流拍', 'info'); return; }
      var step = Math.max(100, U.roundTo(cell.price * 0.1, 100));
      var bid = 0, high = null, guard = 0, turnIdx = 0;
      var active = others.slice();
      this.log('开始拍卖 ' + cell.name + '，加价单位 ' + money(step), 'info');
      if (this.ui.auctionStart) this.ui.auctionStart(cell, initiator);
      this.emit('state');
      while (active.length > 1 && guard++ < 80) {
        if (id !== this._loopId) return;
        var idx = turnIdx % active.length;
        var p = active[idx];
        if (p === high) { turnIdx++; continue; }
        var nextBid = bid + step;
        var ok;
        if (p.isAI) {
          await this.delay(480);
          ok = this.aiBid(p, cell, nextBid);
        } else {
          var res = await this.ask({
            type: 'auction', cellId: cell.i, bid: bid, nextBid: nextBid, step: step,
            highId: high ? high.id : null, playerId: p.id, last: false
          });
          ok = res === 'bid';
        }
        if (id !== this._loopId) return;
        if (ok) {
          bid = nextBid; high = p; turnIdx++;
          this.log(p.name + ' 出价 ' + money(bid), 'info');
          this.sfx('coin');
          if (this.ui.auctionBid) this.ui.auctionBid(p, bid);
          this.emit('state');
        } else {
          this.log(p.name + ' 放弃竞拍', 'info');
          active.splice(idx, 1);
          turnIdx = active.length ? turnIdx % active.length : 0;
        }
      }
      if (active.length === 1 && active[0] !== high && id === this._loopId) {
        var last = active[0];
        var ok2;
        if (last.isAI) { await this.delay(420); ok2 = this.aiBid(last, cell, bid + step); }
        else {
          var res2 = await this.ask({
            type: 'auction', cellId: cell.i, bid: bid, nextBid: bid + step, step: step,
            highId: high ? high.id : null, playerId: last.id, last: true
          });
          ok2 = res2 === 'bid';
        }
        if (ok2) { bid += step; high = last; }
      }
      if (id !== this._loopId) return;
      if (this.ui.auctionEnd) this.ui.auctionEnd(high, bid, cell);
      if (high) {
        this.buy(high, cell, bid);
        this.log(high.name + ' 以 ' + money(bid) + ' 拍得 ' + cell.name, 'buy');
      } else {
        this.log(cell.name + ' 流拍，仍归银行', 'info');
      }
      this.emit('state');
    },

    aiBid: function (p, cell, amount) {
      var limit = Math.min(p.cash * 0.8, cell.price * (0.65 + Math.random() * 0.6));
      if (this.groupAlmostOwned(p, cell.group)) limit = Math.min(p.cash * 0.9, limit * 1.35);
      return amount <= limit && amount <= p.cash;
    },

    /* ---------- 收付 ---------- */
    transfer: function (from, to, amount) {
      amount = Math.max(0, Math.round(amount));
      from.cash -= amount;
      if (to) to.cash += amount; else this.state.pot += amount;
      return amount;
    },

    async pay(from, to, amount, reason) {
      if (!from || amount <= 0) return true;
      if (from.cash >= amount) {
        this.transfer(from, to, amount);
        this.emit('state');
        return true;
      }
      this.log(from.name + ' 现金不足，还差 ' + money(amount - from.cash), 'danger');
      if (from.isAI) {
        await this.aiRaise(from, amount);
      } else {
        var res = await this.ask({
          type: 'raise', amount: amount, reason: reason || '', playerId: from.id,
          need: amount - from.cash, toId: to ? to.id : null
        });
        if (res === 'bankrupt') { this.declareBankrupt(from, to); return false; }
      }
      if (from.bankrupt) return false;
      if (from.cash < amount) {
        this.transfer(from, to, from.cash);
        this.log(from.name + ' 资不抵债，宣告破产', 'danger');
        this.declareBankrupt(from, to);
        return false;
      }
      this.transfer(from, to, amount);
      this.emit('state');
      return true;
    },

    aiRaise: async function (p, amount) {
      var self = this, guard = 0;
      while (p.cash < amount && guard++ < 80) {
        var houseCells = Object.keys(this.state.houses).filter(function (i) {
          return self.state.houses[i] > 0 && self.state.owners[i] === p.id;
        }).map(Number);
        if (houseCells.length) {
          houseCells.sort(function (a, b) { return CELLS[a].houseCost - CELLS[b].houseCost; });
          var sold = false;
          for (var k = 0; k < houseCells.length; k++) {
            if (this.sellHouse(p, houseCells[k], true)) { sold = true; break; }
          }
          if (sold) continue;
        }
        var free = p.props.filter(function (i) { return !self.state.mortgaged[i]; });
        if (free.length) {
          free.sort(function (a, b) { return CELLS[a].price - CELLS[b].price; });
          var done = false;
          for (var j = 0; j < free.length; j++) {
            if (this.mortgage(p, free[j], true)) { done = true; break; }
          }
          if (done) continue;
        }
        break;
      }
      await this.delay(220);
    },

    declareBankrupt: function (p, creditor) {
      p.bankrupt = true;
      var self = this;
      p.props.forEach(function (i) {
        if (creditor) {
          self.state.owners[i] = creditor.id;
          if (creditor.props.indexOf(i) < 0) creditor.props.push(i);
        } else {
          delete self.state.owners[i];
          delete self.state.houses[i];
          delete self.state.mortgaged[i];
        }
      });
      p.props = [];
      if (creditor) {
        this.log(p.name + ' 的产业全部转给 ' + creditor.name, 'danger');
      } else {
        this.log(p.name + ' 的产业被银行收回', 'danger');
      }
      this.sfx('lose');
      this.emit('state');
      if (this.alive().length <= 1) this.endGame();
    },

    endGame: function () {
      if (this.state.over) return;
      this.state.over = true;
      var ranking = this.state.players.slice().sort(function (a, b) {
        if (a.bankrupt !== b.bankrupt) return a.bankrupt ? 1 : -1;
        return b.cash - a.cash;
      });
      this.state.ranking = ranking.map(function (p) { return p.id; });
      this.emit('state');
    },

    finish: function () {
      var self = this;
      var ranking = (this.state.ranking || this.state.players.map(function (p) { return p.id; }))
        .map(function (id) { return self.player(id); });
      DC.Store.clear();
      this.sfx('win');
      if (this.ui.result) this.ui.result(ranking, this);
      this.emit('over', ranking);
    },

    netWorth: function (p) {
      var self = this;
      var total = p.cash;
      p.props.forEach(function (i) {
        var c = CELLS[i];
        var base = self.state.mortgaged[i] ? c.price * 0.5 : c.price;
        total += base + (self.state.houses[i] || 0) * (c.houseCost || 0);
      });
      return total;
    },

    /* ---------- 地产经营 ---------- */
    canBuild: function (p, i) {
      var c = CELLS[i];
      if (!c || c.type !== 'prop') return false;
      if (this.state.owners[i] !== p.id) return false;
      if (!this.ownsGroup(p, c.group)) return false;
      if (this.groupHasMortgage(c.group)) return false;
      if ((this.state.houses[i] || 0) >= C.maxHouses) return false;
      if ((this.state.houses[i] || 0) > this.groupMin(c.group)) return false;
      return p.cash >= c.houseCost;
    },
    canSellHouse: function (p, i) {
      var c = CELLS[i];
      if (!c || c.type !== 'prop') return false;
      if (this.state.owners[i] !== p.id) return false;
      var h = this.state.houses[i] || 0;
      return h > 0 && h >= this.groupMax(c.group);
    },
    canMortgage: function (p, i) {
      var c = CELLS[i];
      if (!c || (c.type !== 'prop' && c.type !== 'rail' && c.type !== 'util')) return false;
      if (this.state.owners[i] !== p.id || this.state.mortgaged[i]) return false;
      if (c.type === 'prop' && this.groupMax(c.group) > 0) return false;
      return true;
    },
    canUnmortgage: function (p, i) {
      var c = CELLS[i];
      if (!c || !this.state.mortgaged[i] || this.state.owners[i] !== p.id) return false;
      return p.cash >= Math.round(c.price * C.mortgageRate * C.unmortgageRate);
    },

    buyHouse: function (p, i) {
      if (!this.canBuild(p, i)) return false;
      var c = CELLS[i];
      p.cash -= c.houseCost;
      this.state.houses[i] = (this.state.houses[i] || 0) + 1;
      this.log(p.name + ' 在 ' + c.name + ' 建造' + (this.state.houses[i] === 5 ? '酒店' : '第 ' + this.state.houses[i] + ' 栋房屋') + '（' + money(c.houseCost) + '）', 'build');
      this.sfx('build');
      this.buzz(14);
      this.emit('state');
      return true;
    },

    sellHouse: function (p, i, silent) {
      if (!this.canSellHouse(p, i)) return false;
      var c = CELLS[i];
      var gain = Math.round(c.houseCost * C.houseSellRate);
      this.state.houses[i] -= 1;
      if (this.state.houses[i] <= 0) delete this.state.houses[i];
      p.cash += gain;
      if (!silent) {
        this.log(p.name + ' 拆除 ' + c.name + ' 的房屋，收回 ' + money(gain), 'build');
        this.sfx('pay');
        this.emit('state');
      }
      return true;
    },

    mortgage: function (p, i, silent) {
      if (!this.canMortgage(p, i)) return false;
      var c = CELLS[i];
      var amount = Math.round(c.price * C.mortgageRate);
      this.state.mortgaged[i] = true;
      p.cash += amount;
      if (!silent) {
        this.log(p.name + ' 抵押 ' + c.name + '，获得 ' + money(amount), 'mortgage');
        this.sfx('pay');
        this.emit('state');
      }
      return true;
    },

    unmortgage: function (p, i) {
      if (!this.canUnmortgage(p, i)) return false;
      var c = CELLS[i];
      var cost = Math.round(c.price * C.mortgageRate * C.unmortgageRate);
      p.cash -= cost;
      delete this.state.mortgaged[i];
      this.log(p.name + ' 赎回 ' + c.name + '，支付 ' + money(cost), 'mortgage');
      this.sfx('coin');
      this.emit('state');
      return true;
    },

    /* ---------- 监狱 ---------- */
    async sendToJail(p) {
      p.pos = C.jailPos;
      p.inJail = true;
      p.jailTurns = 0;
      p.doubles = 0;
      this.state.justJailed = true;
      this.sfx('jail');
      this.buzz([14, 60, 14]);
      this.emit('state');
      await this.delay(420);
    },

    async handleJail(p) {
      var d;
      if (p.isAI) {
        await this.delay(520);
        if (p.jailCards > 0 && p.cash < 4000) {
          p.jailCards--; p.inJail = false;
          this.log(p.name + ' 使用出狱许可证离开监狱', 'jail');
          this.emit('state');
          return { freed: true };
        }
        if (p.cash >= 6000) {
          await this.pay(p, null, C.jailFine, '保释金');
          if (p.bankrupt) return { freed: false };
          p.inJail = false;
          this.log(p.name + ' 缴纳保释金出狱', 'jail');
          return { freed: true };
        }
        d = [U.rand(1, 6), U.rand(1, 6)];
        this.setDice(d);
        this.sfx('dice');
        if (this.ui.dice) await this.ui.dice(p, d, this);
        if (d[0] === d[1]) {
          p.inJail = false;
          this.log(p.name + ' 掷出双 ' + d[0] + '，出狱并前进', 'jail');
          return { freed: true, dice: d };
        }
        p.jailTurns++;
        if (p.jailTurns >= 3) {
          this.log(p.name + ' 三回合未掷出双数，强制保释', 'jail');
          await this.pay(p, null, C.jailFine, '强制保释');
          if (p.bankrupt) return { freed: false };
          p.inJail = false;
          return { freed: true };
        }
        this.log(p.name + ' 仍在狱中（第 ' + p.jailTurns + ' 回合）', 'jail');
        return { freed: false };
      }

      var choice = await this.ask({
        type: 'jail', playerId: p.id, fine: C.jailFine,
        cards: p.jailCards, turns: p.jailTurns, maxTurns: 3
      });
      if (choice === 'pay') {
        await this.pay(p, null, C.jailFine, '保释金');
        if (p.bankrupt) return { freed: false };
        p.inJail = false;
        this.log(p.name + ' 缴纳保释金出狱', 'jail');
        this.emit('state');
        return { freed: true };
      }
      if (choice === 'card' && p.jailCards > 0) {
        p.jailCards--;
        p.inJail = false;
        this.log(p.name + ' 使用出狱许可证离开监狱', 'jail');
        this.emit('state');
        return { freed: true };
      }
      d = [U.rand(1, 6), U.rand(1, 6)];
      this.setDice(d);
      this.sfx('dice');
      if (this.ui.dice) await this.ui.dice(p, d, this);
      if (d[0] === d[1]) {
        p.inJail = false;
        this.log(p.name + ' 掷出双 ' + d[0] + '，出狱并前进', 'jail');
        this.emit('state');
        return { freed: true, dice: d };
      }
      p.jailTurns++;
      if (p.jailTurns >= 3) {
        this.log(p.name + ' 三回合未掷出双数，强制保释', 'jail');
        await this.pay(p, null, C.jailFine, '强制保释');
        if (p.bankrupt) return { freed: false };
        p.inJail = false;
        this.emit('state');
        return { freed: true };
      }
      this.log(p.name + ' 没掷出双数，留在狱中（第 ' + p.jailTurns + ' 回合）', 'jail');
      this.emit('state');
      return { freed: false };
    },

    /* ---------- 卡牌 ---------- */
    async drawCard(p, deckKey, label, depth) {
      if (this.state[deckKey + 'Idx'] >= this.state[deckKey].length) {
        this.state[deckKey] = U.shuffle(this.state[deckKey]);
        this.state[deckKey + 'Idx'] = 0;
      }
      var card = this.state[deckKey][this.state[deckKey + 'Idx']];
      this.state[deckKey + 'Idx']++;
      this.log(p.name + ' 抽到' + label + '卡：' + card.text, 'card');
      this.sfx('card');
      if (this.ui.showCard) await this.ui.showCard(p, card, label, p.isAI);
      await this.applyCard(p, card, depth || 0);
    },

    async applyCard(p, card, depth) {
      var i, amt;
      switch (card.kind) {
        case 'gain':
          p.cash += card.amount;
          this.log(p.name + ' 收取 ' + money(card.amount), 'money');
          this.sfx('coin');
          if (this.ui.float) this.ui.float('+' + money(card.amount), p.pos, 'gain');
          if (this.ui.coinFly) this.ui.coinFly(p.pos, p.id);
          this.emit('state');
          break;
        case 'pay':
          await this.pay(p, null, card.amount, '卡牌支出');
          break;
        case 'payPerHouse':
          amt = this.countHouses(p) * card.amount;
          if (amt > 0) {
            this.log(p.name + ' 有 ' + this.countHouses(p) + ' 栋房屋，需付 ' + money(amt), 'pay');
            await this.pay(p, null, amt, '房屋维修');
          } else {
            this.log(p.name + ' 名下没有房屋，免付', 'info');
          }
          break;
        case 'collectAll': {
          var others = this.state.players.filter(function (o) { return o !== p && !o.bankrupt; });
          for (i = 0; i < others.length; i++) {
            await this.pay(others[i], p, card.amount, '卡牌收款');
          }
          break;
        }
        case 'moveTo':
          await this.moveToCell(p, card.target, { salary: card.salary });
          if (depth < 3) await this.resolveLanding(p, this._loopId, depth + 1);
          break;
        case 'nearest': {
          var target = this.nearestOfType(p, card.of);
          await this.moveToCell(p, target, { salary: true });
          if (depth < 3) await this.resolveLanding(p, this._loopId, depth + 1);
          break;
        }
        case 'move':
          await this.moveBy(p, card.steps, this._loopId);
          if (depth < 3) await this.resolveLanding(p, this._loopId, depth + 1);
          break;
        case 'jail':
          await this.sendToJail(p);
          break;
        case 'jailCard':
          p.jailCards++;
          this.log(p.name + ' 获得一张出狱许可证', 'card');
          this.emit('state');
          break;
        default:
          break;
      }
    },

    nearestOfType: function (p, type) {
      for (var k = 1; k <= 24; k++) {
        var idx = (p.pos + k) % 24;
        if (CELLS[idx].type === type) return idx;
      }
      return p.pos;
    },

    /* ---------- AI 决策 ---------- */
    groupAlmostOwned: function (p, group) {
      var cells = DC.GROUP_CELLS[group] || [];
      var self = this;
      if (!cells.length) return false;
      var mine = cells.filter(function (i) { return self.state.owners[i] === p.id; }).length;
      return mine === cells.length - 1;
    },
    rivalThreat: function (p, cell) {
      if (cell.type !== 'prop') return false;
      var cells = DC.GROUP_CELLS[cell.group] || [];
      var self = this;
      return cells.some(function (i) {
        var o = self.state.owners[i];
        return o !== undefined && o !== p.id && self.groupAlmostOwned(self.player(o), cell.group);
      });
    },
    aiWantsToBuy: function (p, cell) {
      if (p.cash < cell.price) return false;
      var left = p.cash - cell.price;
      if (this.groupAlmostOwned(p, cell.group)) return left >= 300;
      if (this.rivalThreat(p, cell)) return left >= 200;
      if (cell.type === 'rail') return left >= 900;
      if (cell.type === 'util') return left >= 1500;
      return left >= 1200;
    },
    aiShouldBuild: function (p) {
      var self = this;
      if (p.cash < 4000) return null;
      var cands = p.props.filter(function (i) { return self.canBuild(p, i); });
      if (!cands.length) return null;
      cands.sort(function (a, b) {
        return (CELLS[b].rents[1] / CELLS[b].houseCost) - (CELLS[a].rents[1] / CELLS[a].houseCost);
      });
      return cands[0];
    },

    /* ---------- 人类交互 ---------- */
    ask: function (payload) {
      var self = this;
      this.state.ask = payload;
      this.emit('ask', payload);
      this.emit('state');
      return new Promise(function (res) { self._askResolve = res; });
    },
    answer: function (value) {
      var r = this._askResolve; this._askResolve = null;
      var a = this.state.ask; this.state.ask = null;
      this.emit('askEnd', a);
      this.emit('state');
      if (r) r(value);
    },

    /* AI 回合中自动建房：在每个 AI 回合开始时调用 */
    async aiTurnUpkeep(p) {
      var guard = 0;
      while (guard++ < 8) {
        var i = this.aiShouldBuild(p);
        if (i === null) break;
        if (!this.buyHouse(p, i)) break;
        await this.delay(260);
      }
      var self = this;
      var un = p.props.filter(function (i) { return self.canUnmortgage(p, i) && p.cash > 6000; });
      if (un.length) { this.unmortgage(p, un[0]); await this.delay(200); }
    }
  };

  /* 把 AI 建房挂进回合开始 */
  var _runTurn = Engine.prototype.runTurn;
  Engine.prototype.runTurn = async function (p, id) {
    if (p.isAI && !p.inJail) { await this.aiTurnUpkeep(p); }
    return _runTurn.call(this, p, id);
  };

  DC.Engine = Engine;
})(window.DC);
