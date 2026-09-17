/* ============================================================
   大富翁 · 地产小镇   —  棋盘与卡组数据
   纯数据 + 小工具，无副作用，供 engine / ui 共享。
   ============================================================ */
window.DC = window.DC || {};

(function (DC) {
  'use strict';

  DC.CONFIG = {
    version: '1.1.0',
    boardSize: 24,
    startCash: 15000,
    goSalary: 2000,
    jailFine: 500,
    jailPos: 6,
    goPos: 0,
    maxHouses: 5,            // 5 = 酒店
    mortgageRate: 0.5,       // 抵押得半价
    unmortgageRate: 1.1,     // 赎回付 110%
    houseSellRate: 0.5,      // 卖房得半价
    stepMs: 300,            // 每走一格的间隔（毫秒，会被动画速度倍率缩放）
    rollPauseMs: 200,       // 掷骰结束后、开始移动前的停顿
    taxRate: 0.1,
    taxMin: 1000,
    maxLog: 200
  };

  /* ---------- 玩家 ---------- */
  DC.PLAYER_PRESETS = [
    { name: '你',     short: '你',   color: '#FF4D6D', isAI: false },
    { name: '顾老板', short: '顾',   color: '#2FB8F0', isAI: true  },
    { name: '白掌柜', short: '白',   color: '#FFB020', isAI: true  },
    { name: '周小姐', short: '周',   color: '#A96BFF', isAI: true  }
  ];

  /* ---------- 地产分组 ---------- */
  DC.GROUPS = {
    A: { name: '沪西',     color: '#FF5C8A' },
    B: { name: '法租界',   color: '#FF9A3D' },
    C: { name: '市中心',   color: '#4CD964' },
    D: { name: '北四川路', color: '#35C1F0' },
    E: { name: '老城厢',   color: '#A96BFF' }
  };
  DC.TYPE_COLOR = {
    rail: '#8FA6C4',
    util: '#FFC93C',
    go: '#FFC93C',
    jail: '#A96BFF',
    gotojail: '#A96BFF',
    parking: '#4CD964',
    chance: '#FFC93C',
    fate: '#A96BFF',
    tax: '#FF8A3D'
  };
  DC.TYPE_LABEL = {
    prop: '地产', rail: '车站', util: '公用事业', go: '起点', jail: '监狱',
    gotojail: '入狱', parking: '免费停车', chance: '机会', fate: '命运', tax: '税收'
  };

  function prop(i, name, short, group, price, houseCost, rents) {
    return { i: i, name: name, short: short, type: 'prop', group: group, price: price, houseCost: houseCost, rents: rents };
  }

  /* ---------- 24 格 ---------- */
  DC.CELLS = [
    { i: 0,  name: '起点',     short: '起点',   type: 'go',       desc: '经过或停留领取 ¥2,000' },
    prop(1,  '大西路', '大西路', 'A', 600,  500,  [20, 100, 300, 900, 1600, 2500]),
    { i: 2,  name: '命运',     short: '命运',   type: 'fate',     desc: '抽一张命运卡' },
    prop(3,  '静安寺', '静安寺', 'A', 600,  500,  [20, 100, 300, 900, 1600, 2500]),
    { i: 4,  name: '所得税',   short: '所得税', type: 'tax',      rate: 0.1, min: 1000, desc: '缴纳现金的 10%' },
    { i: 5,  name: '北站',     short: '北站',   type: 'rail',     price: 2000, houseCost: 1000, rents: [250, 500, 1000, 2000] },
    { i: 6,  name: '监狱',     short: '监狱',   type: 'jail',     desc: '探监 / 关押' },
    prop(7,  '霞飞路', '霞飞路', 'B', 1000, 500,  [60, 300, 900, 2700, 4000, 5500]),
    { i: 8,  name: '机会',     short: '机会',   type: 'chance',   desc: '抽一张机会卡' },
    prop(9,  '复兴路', '复兴路', 'B', 1000, 500,  [60, 300, 900, 2700, 4000, 5500]),
    { i: 10, name: '自来水厂', short: '水厂',   type: 'util',     price: 1500, houseCost: 1000, mult: [80, 200] },
    prop(11, '南京路', '南京路', 'C', 1400, 1000, [100, 500, 1500, 4500, 6250, 7500]),
    { i: 12, name: '免费停车', short: '停车场', type: 'parking',  desc: '领取罚款池' },
    prop(13, '外滩',   '外滩',   'C', 1400, 1000, [100, 500, 1500, 4500, 6250, 7500]),
    { i: 14, name: '命运',     short: '命运',   type: 'fate',     desc: '抽一张命运卡' },
    { i: 15, name: '电力公司', short: '电厂',   type: 'util',     price: 1500, houseCost: 1000, mult: [80, 200] },
    { i: 16, name: '西站',     short: '西站',   type: 'rail',     price: 2000, houseCost: 1000, rents: [250, 500, 1000, 2000] },
    prop(17, '淮海路', '淮海路', 'D', 1800, 1000, [140, 700, 2000, 5500, 7500, 9500]),
    { i: 18, name: '入狱',     short: '入狱',   type: 'gotojail', desc: '直接送往监狱' },
    prop(19, '四川路', '四川路', 'D', 1800, 1000, [140, 700, 2000, 5500, 7500, 9500]),
    { i: 20, name: '机会',     short: '机会',   type: 'chance',   desc: '抽一张机会卡' },
    { i: 21, name: '东站',     short: '东站',   type: 'rail',     price: 2000, houseCost: 1000, rents: [250, 500, 1000, 2000] },
    prop(22, '城隍庙', '城隍庙', 'E', 2200, 1500, [180, 900, 2500, 7000, 8750, 10500]),
    prop(23, '愚园路', '愚园路', 'E', 2200, 1500, [180, 900, 2500, 7000, 8750, 10500])
  ];

  DC.GROUP_CELLS = (function () {
    var map = {};
    DC.CELLS.forEach(function (c) {
      if (c.type === 'prop') (map[c.group] = map[c.group] || []).push(c.i);
    });
    return map;
  })();

  /* ---------- 7x7 环上的行列坐标 ---------- */
  DC.CELL_POS = (function () {
    var pos = new Array(24);
    var i, c, r;
    for (i = 0; i <= 6; i++) pos[i] = [6, 6 - i];              // 0..6  底行 右→左
    for (i = 0; i <= 5; i++) pos[7 + i] = [5 - i, 0];          // 7..12 左列 下→上
    for (i = 0; i <= 5; i++) pos[13 + i] = [0, 1 + i];         // 13..18 顶行 左→右
    for (i = 0; i <= 4; i++) pos[19 + i] = [1 + i, 6];         // 19..23 右列 上→下
    return pos;
  })();

  /* 格心在棋盘上的百分比坐标（0..100） */
  DC.CELL_CENTER = DC.CELL_POS.map(function (p) {
    return { x: (p[1] + 0.5) / 7 * 100, y: (p[0] + 0.5) / 7 * 100 };
  });

  DC.CORNER_CELLS = [0, 6, 12, 18];

  /* ---------- 卡组 ---------- */
  DC.CHANCE = [
    { text: '直达起点，领取 ¥2,000',                 kind: 'moveTo', target: 0, salary: true },
    { text: '银行派发股息，收取 ¥500',                kind: 'gain', amount: 500 },
    { text: '房产升值，收取 ¥1,500',                  kind: 'gain', amount: 1500 },
    { text: '前往最近的车站',                          kind: 'nearest', of: 'rail' },
    { text: '违章罚款，缴纳 ¥300',                     kind: 'pay', amount: 300 },
    { text: '后退三格',                                kind: 'move', steps: -3 },
    { text: '涉嫌逃税，直接入狱',                       kind: 'jail' },
    { text: '获得「出狱许可证」，可留用一次',            kind: 'jailCard' },
    { text: '房屋修缮，每栋房屋缴纳 ¥250',              kind: 'payPerHouse', amount: 250 },
    { text: '前往外滩',                                kind: 'moveTo', target: 13 },
    { text: '前进五格',                                kind: 'move', steps: 5 },
    { text: '各位业主向您致意，每人付 ¥200',             kind: 'collectAll', amount: 200 }
  ];

  DC.FATE = [
    { text: '医疗费用，缴纳 ¥500',                     kind: 'pay', amount: 500 },
    { text: '生日礼金，每位玩家送您 ¥200',              kind: 'collectAll', amount: 200 },
    { text: '继承遗产，收取 ¥1,000',                    kind: 'gain', amount: 1000 },
    { text: '前往监狱，不得经过起点',                    kind: 'jail' },
    { text: '获得「出狱许可证」，可留用一次',             kind: 'jailCard' },
    { text: '前往南京路',                              kind: 'moveTo', target: 11 },
    { text: '缴纳所得税 ¥1,000',                       kind: 'pay', amount: 1000 },
    { text: '股票崩盘，损失 ¥1,500',                    kind: 'pay', amount: 1500 },
    { text: '房屋维修，每栋房屋 ¥400',                  kind: 'payPerHouse', amount: 400 },
    { text: '回到起点，领取 ¥2,000',                    kind: 'moveTo', target: 0, salary: true },
    { text: '前进两格',                                kind: 'move', steps: 2 },
    { text: '银行退回手续费 ¥800',                      kind: 'gain', amount: 800 }
  ];

  /* ---------- 工具 ---------- */
  DC.util = {
    money: function (n) {
      var neg = n < 0;
      var s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return (neg ? '−' : '') + '¥' + s;
    },
    shortMoney: function (n) {
      var a = Math.abs(n);
      if (a >= 10000) return (n / 10000).toFixed(a % 10000 === 0 ? 0 : 1) + '万';
      return DC.util.money(n).replace('¥', '');
    },
    clamp: function (v, a, b) { return v < a ? a : v > b ? b : v; },
    rand: function (a, b) { return a + Math.floor(Math.random() * (b - a + 1)); },
    shuffle: function (arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    },
    roundTo: function (n, step) { return Math.round(n / step) * step; }
  };
})(window.DC);
