/* ============================================================
   规则回归测试（无头，不需要浏览器）
   ------------------------------------------------------------
   engine.js 完全没有 DOM 依赖（零处 document.，window / localStorage /
   navigator 都有守卫），所以给它一个最小的 window 桩就能在 Node 里
   整局跑完对局。

   跑法：
     node tools/smoke.mjs                   默认 12 局，回合上限 400
     node tools/smoke.mjs --games=40        加大随机对局数
     node tools/smoke.mjs --rounds=800      放宽回合上限
     node tools/smoke.mjs --seed=7          换一组种子（复现失败用）
     node tools/smoke.mjs --verbose         打印每局收尾状态

   断言的是「规则不变量」而不是「某局谁赢」：
   改规则改崩了会立刻红，正常的数值调整不会误报。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = (f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const GAMES = +arg('games', 12);
const MAX_ROUNDS = +arg('rounds', 400);
const SEED0 = +arg('seed', 1);
const VERBOSE = argv.includes('--verbose');

/* ---------------- 种子随机 ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 最小世界：只给引擎它真需要的东西 ---------------- */
function createWorld(seed) {
  const store = new Map();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    navigator: {},                    // 没有 vibrate → 震动走优雅降级分支
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    },
    __rand: mulberry32(seed)
  };
  sandbox.window = sandbox;           // 浏览器里 window 就是全局对象
  const ctx = vm.createContext(sandbox);
  vm.runInContext('Math.random = __rand;', ctx);
  vm.runInContext(JS('data.js'), ctx, { filename: 'js/data.js' });
  vm.runInContext(JS('engine.js'), ctx, { filename: 'js/engine.js' });
  return { DC: sandbox.DC, sandbox, store };
}

/* speed 拉高 + reducedMotion，让 delay() 全部归零：
   对局退化成纯微任务，上千回合也只要几百毫秒。 */
const FAST = { sound: false, music: false, haptics: false, reducedMotion: true, speed: 1000 };

function makeEngine(DC, { humanPolicy, onState, settings }) {
  const eng = new DC.Engine({}, Object.assign({}, FAST, settings || {}));
  eng.__DC = DC;                       // 测试用：把数据表挂回引擎
  const stats = { asks: 0, byType: {} };
  const cov = {};                      // 路径覆盖：证明这些规则分支真被跑到了

  ['runAuction', 'drawCard', 'declareBankrupt', 'sendToJail', 'buyHouse', 'sellHouse',
    'mortgage', 'unmortgage', 'buy'].forEach((name) => {
    const orig = eng[name];
    eng[name] = function () { cov[name] = (cov[name] || 0) + 1; return orig.apply(this, arguments); };
  });
  eng.on('land', (e) => { const k = 'land:' + e.cell.type; cov[k] = (cov[k] || 0) + 1; });

  // 人类回合在等「掷骰子」按钮。真浏览器里用户是过一会儿才点的，
  // 这里必须等 waitRoll() 把 resolver 装好再按，否则 promise 永不兑现。
  function autoRoll() {
    if (eng.__rollTimer) return;
    const tick = () => {
      if (!eng.state || eng.state.over || !eng.state.awaitingRoll) { eng.__rollTimer = null; return; }
      if (eng._rollResolve) { eng.__rollTimer = null; eng.pressRoll(); return; }
      eng.__rollTimer = setTimeout(tick, 0);
    };
    eng.__rollTimer = setTimeout(tick, 0);
  }

  eng.on('state', () => {
    if (onState) onState(eng);
    if (eng.state && eng.state.ask) return;   // 弹层挂着时不抢按钮
    if (eng.state && eng.state.awaitingRoll) autoRoll();
  });

  eng.on('ask', (a) => {
    stats.asks++;
    stats.byType[a.type] = (stats.byType[a.type] || 0) + 1;
    queueMicrotask(() => {                  // 不在 emit 里同步递归
      if (eng.state && eng.state.ask === a) eng.answer(humanPolicy(a, eng));
    });
  });

  return { eng, stats, cov };
}

/* ---------------- 人类侧自动策略 ----------------
   三种风格，各自覆盖不同的规则分支。
   注意：拍卖出价必须自己守住「出价 ≤ 现金」——
   engine.runAuction 信任 UI 层（ui.js 用 disabled 按钮拦），
   引擎本身不会替你把出价压回现金以内。                      */
const POLICIES = {
  normal(a, eng) {
    const p = eng.player(a.playerId);
    switch (a.type) {
      case 'buy':
        return p.cash - a.price >= 1200 ? 'buy' : 'auction';
      case 'upgrade':
        return (p.cash - a.cost >= 2500 && eng.state.round >= 2) ? 'upgrade' : 'skip';
      case 'auction':
        return a.nextBid <= Math.min(p.cash, cellOf(eng, a.cellId).price * 1.25) ? 'bid' : 'pass';
      case 'raise':
        return raiseMoney(eng, p, a.amount) ? 'pay' : 'bankrupt';
      case 'jail':
        if (p.cash >= a.fine + 800) return 'pay';
        return a.cards > 0 ? 'card' : 'roll';
      default:
        return 'skip';
    }
  },
  cautious(a, eng) {
    const p = eng.player(a.playerId);
    switch (a.type) {
      case 'buy':
        // 留够现金才买，钱不够就转拍卖 —— 这样才压得到拍卖流程
        return p.cash - a.price >= 8000 ? 'buy' : 'auction';
      case 'upgrade':
        return 'skip';
      case 'auction':
        return a.nextBid <= p.cash * 0.3 ? 'bid' : 'pass';
      case 'raise':
        return raiseMoney(eng, p, a.amount) ? 'pay' : 'bankrupt';
      case 'jail':
        return p.cash >= a.fine + 3000 ? 'pay' : 'roll';
      default:
        return 'skip';
    }
  },
  reckless(a, eng) {
    const p = eng.player(a.playerId);
    switch (a.type) {
      case 'buy':
        return 'buy';
      case 'upgrade':
        return 'upgrade';
      case 'auction':
        return a.nextBid <= p.cash ? 'bid' : 'pass';
      case 'raise':
        return 'bankrupt';       // 专门压测清算路径
      case 'jail':
        return 'roll';
      default:
        return 'skip';
    }
  }
};

const cellOf = (eng, i) => eng.__DC.CELLS[i];

/* 复刻 UI 里「变卖家产」的交互：先拆房，再抵押，凑够就还钱 */
function raiseMoney(eng, p, amount) {
  let guard = 0;
  while (p.cash < amount && guard++ < 60) {
    const houses = Object.keys(eng.state.houses)
      .map(Number)
      .filter((i) => eng.state.owners[i] === p.id && eng.state.houses[i] > 0)
      .sort((a, b) => eng.state.houses[b] - eng.state.houses[a]);
    if (houses.length && eng.sellHouse(p, houses[0], true)) continue;
    const free = p.props.filter((i) => eng.canMortgage(p, i));
    if (free.length && eng.mortgage(p, free[0], true)) continue;
    break;
  }
  return p.cash >= amount;
}

/* ---------------- 不变量 ---------------- */
function makeChecker(world) {
  const DC = world.DC, C = DC.CONFIG;
  return function check(eng, where, fail) {
    const s = eng.state;
    if (!s) return;
    const P = s.players;

    P.forEach((p) => {
      if (!Number.isInteger(p.pos) || p.pos < 0 || p.pos >= C.boardSize)
        fail(`${where}: ${p.name} 位置越界 (${p.pos})`);
      if (!Number.isFinite(p.cash))
        fail(`${where}: ${p.name} 现金非数值 (${p.cash})`);
      if (p.cash < 0)
        fail(`${where}: ${p.name} 现金为负 (${p.cash})`);
      if (p.props.length !== new Set(p.props).size)
        fail(`${where}: ${p.name} 地产列表有重复项`);
      if (p.bankrupt && p.props.length)
        fail(`${where}: 已破产的 ${p.name} 仍持有 ${p.props.length} 处地产`);
    });

    // owners ↔ props 双向一致
    Object.keys(s.owners).forEach((k) => {
      const i = Number(k), ownerId = s.owners[k];
      if (!(i >= 0 && i < C.boardSize)) { fail(`${where}: owners 键越界 (${i})`); return; }
      const cell = DC.CELLS[i];
      if (!cell || cell.price === undefined)
        fail(`${where}: 第 ${i} 格（${cell ? cell.name : '?'}）本不可拥有，却登记了 owner`);
      const owner = P[ownerId];
      if (!owner) fail(`${where}: 第 ${i} 格 owner=${ownerId} 不存在`);
      else if (owner.props.indexOf(i) < 0)
        fail(`${where}: 第 ${i} 格 owner 是 ${owner.name}，但不在其 props 里`);
      else if (owner.bankrupt)
        fail(`${where}: 第 ${i} 格属于已破产的 ${owner.name}`);
    });
    P.forEach((p) => p.props.forEach((i) => {
      if (s.owners[i] !== p.id)
        fail(`${where}: ${p.name}.props 含第 ${i} 格，但 owners[${i}]=${s.owners[i]}`);
    }));

    const owned = Object.keys(s.owners).length;
    const summed = P.reduce((n, p) => n + p.props.length, 0);
    if (owned !== summed)
      fail(`${where}: owners 有 ${owned} 处地产，各玩家 props 合计 ${summed} 处`);

    Object.keys(s.houses).forEach((k) => {
      const i = Number(k), h = s.houses[k];
      if (!(h >= 1 && h <= C.maxHouses))
        fail(`${where}: 第 ${i} 格房屋数 ${h} 超出 1..${C.maxHouses}`);
      if (s.owners[i] === undefined)
        fail(`${where}: 第 ${i} 格无主却有 ${h} 栋房屋`);
      if (s.mortgaged[i])
        fail(`${where}: 第 ${i} 格抵押中却仍有 ${h} 栋房屋`);
    });

    Object.keys(s.mortgaged).forEach((k) => {
      const i = Number(k);
      if (s.owners[i] === undefined)
        fail(`${where}: 第 ${i} 格无主却被标记为已抵押`);
      if ((s.houses[i] || 0) > 0)
        fail(`${where}: 第 ${i} 格有房屋却被抵押`);
    });

    if (s.pot < 0) fail(`${where}: 罚款池为负 (${s.pot})`);
    if (s.log.length > C.maxLog) fail(`${where}: 战报长度 ${s.log.length} 超过上限 ${C.maxLog}`);

    if (s.__capped) return;                 // 触顶收尾是测试主动打断的，跳过终局断言
    if (!s.over) {
      // current 只在「稳定的决策点」上断言。
      // declareBankrupt() 会先把还指在破产者身上的 current 广播一次，
      // 紧接着 gameLoop 才 advance() 跳到下一位 —— 这是同一批微任务内的
      // 瞬时状态，浏览器根本来不及绘制，不算缺陷。
      if (s.awaitingRoll || s.ask) {
        const cur = P[s.current];
        if (!cur) fail(`${where}: current=${s.current} 指向不存在的玩家`);
        else if (cur.bankrupt)
          fail(`${where}: 等人类决策时 current 仍是已破产的 ${cur.name}`);
      }
    } else {
      const alive = P.filter((p) => !p.bankrupt).length;
      if (alive > 1) fail(`${where}: 对局已结束但仍有 ${alive} 名玩家在场`);
      if (!Array.isArray(s.ranking) || s.ranking.length !== P.length)
        fail(`${where}: 排名缺失或不完整`);
      else {
        const first = P[s.ranking[0]];
        if (first && first.bankrupt) fail(`${where}: 排名第一的 ${first.name} 已破产`);
      }
    }
  };
}

/* ---------------- 跑一局 ---------------- */
async function playGame(seed, policyName, checker, world, rounds, classic = true) {
  const { DC } = world;
  const policy = POLICIES[policyName];
  const fails = [];

  const { eng, stats, cov } = makeEngine(DC, {
    humanPolicy: (a, e) => policy(a, e),
    settings: { classicRules: classic },
    onState: (e) => {
      if (e.state.__capped) return;
      checker(e, `第 ${e.state.round} 回合`, (m) => fails.push(m));
    }
  });

  // 回合上限：不算失败，但记下来 —— 长尾对局会拖慢测试
  eng.on('state', () => {
    if (!eng.state.over && eng.state.round > rounds) {
      eng.state.__capped = true;
      eng.state.over = true;              // 让 gameLoop 收尾并走 finish()
    }
  });

  eng.newGame(4);
  await eng.start();
  const s = eng.state;

  return {
    seed, policy: policyName, over: s.over, capped: !!s.__capped, classic,
    round: s.round, asks: stats.asks, byType: stats.byType,
    alive: s.players.filter((p) => !p.bankrupt).length,
    winner: (s.over && !s.__capped && s.ranking) ? s.players[s.ranking[0]].name : null,
    hash: hashState(s),
    cov,
    owned: Object.keys(s.owners).length,
    houses: Object.values(s.houses).reduce((a, b) => a + b, 0),
    _fails: fails
  };
}

function hashState(s) {
  const core = {
    round: s.round, over: s.over, current: s.current, pot: s.pot,
    ranking: s.ranking, owners: s.owners, houses: s.houses, mortgaged: s.mortgaged,
    players: s.players.map((p) => ({
      id: p.id, cash: p.cash, pos: p.pos, inJail: p.inJail, jailCards: p.jailCards,
      bankrupt: p.bankrupt, props: p.props.slice(), laps: p.laps
    }))
  };
  const str = JSON.stringify(core);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/* ---------------- 输出 ---------------- */
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`
};
const groups = [];
const group = (name) => { const g = { name, pass: 0, fail: [], notes: [] }; groups.push(g); return g; };

/* ============================================================
   A. 规则单元断言（确定性，直接调引擎方法）
   ============================================================ */
{
  const g = group('规则单元');
  const world = createWorld(1);
  const { DC } = world;
  const mk = (n) => { const { eng } = makeEngine(DC, { humanPolicy: POLICIES.normal }); eng.newGame(n || 4); return eng; };
  const ok = (cond, msg) => { if (cond) g.pass++; else g.fail.push(msg); };
  // 默认开启经典建房规则，建房前需集齐整组 —— 测试里直接发放整组地产
  const grant = (e, p, cells) => cells.forEach((i) => {
    e.state.owners[i] = p.id;
    if (p.props.indexOf(i) < 0) p.props.push(i);
  });

  // 集齐同组，基础租金翻倍
  {
    const e = mk(), p0 = e.player(0);
    e.state.owners[1] = p0.id; p0.props.push(1);
    const solo = e.calcRent(DC.CELLS[1]);
    e.state.owners[3] = p0.id; p0.props.push(3);
    const full = e.calcRent(DC.CELLS[1]);
    ok(solo === 20, `单块 A 组地租应为 20，实得 ${solo}`);
    ok(full === 40, `集齐 A 组后租应翻倍为 40，实得 ${full}`);
  }

  // 车站：按持有数量递增，升级再叠加
  {
    const e = mk(), p0 = e.player(0);
    [5, 16, 21].forEach((i) => { e.state.owners[i] = p0.id; p0.props.push(i); });
    const r1 = e.calcRent(DC.CELLS[5]);
    e.state.houses[5] = 2;
    const r2 = e.calcRent(DC.CELLS[5]);
    ok(r1 === 1000, `持有 3 座车站时租应为 1,000，实得 ${r1}`);
    ok(r2 === 1600, `车站升 2 级后租应为 1000+2×300=1,600，实得 ${r2}`);
  }

  // 公用事业：点数 × 倍率
  {
    const e = mk(), p0 = e.player(0);
    e.state.owners[10] = p0.id; p0.props.push(10);
    e.state.die = 5;
    const r1 = e.calcRent(DC.CELLS[10]);
    e.state.owners[15] = p0.id; p0.props.push(15);
    const r2 = e.calcRent(DC.CELLS[10]);
    ok(r1 === 400, `持有 1 家公用事业、点数 5 时应为 5×80=400，实得 ${r1}`);
    ok(r2 === 1000, `持有 2 家公用事业、点数 5 时应为 5×200=1,000，实得 ${r2}`);
  }

  // 抵押地块免租
  {
    const e = mk(), p0 = e.player(0);
    e.state.owners[1] = p0.id; p0.props.push(1); e.state.mortgaged[1] = true;
    ok(e.calcRent(DC.CELLS[1]) === 0, '抵押地块应收 0 租');
  }

  // 升级前置条件
  {
    const e = mk(), p0 = e.player(0), p1 = e.player(1);
    ok(!e.canUpgradeLevel(p1, 1), '不是自己的地不应允许升级');
    grant(e, p0, DC.GROUP_CELLS.A);        // 经典规则：先集齐整组才能建房
    ok(e.canUpgradeLevel(p0, 1), '集齐整组后自有未满级地应允许升级');
    e.state.houses[1] = DC.CONFIG.maxHouses;
    ok(!e.canUpgradeLevel(p0, 1), `已到 ${DC.CONFIG.maxHouses} 级不应允许继续升级`);
    e.state.houses[1] = 1; e.state.mortgaged[1] = true;
    ok(!e.canUpgradeLevel(p0, 1), '抵押中的地不应允许升级');
    ok(!e.canUpgradeLevel(p0, 0), '起点不应允许升级');
  }

  // 经典建房规则：集齐整组 / 均级建造 / 同组无抵押
  {
    const e = mk(), p0 = e.player(0);
    e.state.owners[1] = p0.id; p0.props.push(1);
    ok(e.upgradeBlock(p0, 1) === 'need-group', '未集齐整组时应禁止建房');

    grant(e, p0, DC.GROUP_CELLS.A);
    ok(e.upgradeBlock(p0, 1) === null, '集齐整组后应允许建房');

    ok(e.buyHouse(p0, 1) && e.state.houses[1] === 1, '同组拉平时第一次建房应成功');
    ok(e.upgradeBlock(p0, 1) === 'even-build', '同组房屋不均衡时应禁止继续升同一块');
    ok(e.buyHouse(p0, 3) && e.state.houses[3] === 1, '应允许升同组房屋较少的那块');
    ok(e.upgradeBlock(p0, 1) === null, '同组拉平后应恢复可建');

    delete e.state.houses[1]; delete e.state.houses[3];    // 清空房屋后再测抵押约束
    e.mortgage(p0, 3);
    ok(e.upgradeBlock(p0, 1) === 'group-mortgaged', '同组有抵押地时应禁止建房');
    e.unmortgage(p0, 3);
    ok(e.upgradeBlock(p0, 1) === null, '同组赎回后应恢复可建');
  }

  // 车站与公用事业没有分组，不套经典建房规则
  {
    const e = mk(), p0 = e.player(0);
    e.state.owners[16] = p0.id; p0.props.push(16);
    ok(e.upgradeBlock(p0, 16) === null, '只持有一座车站也应能升级');
  }

  // 关掉 classicRules → 退回「单块地即可建房」
  {
    const e = mk(2);
    e.settings.classicRules = false;
    const p0 = e.player(0);
    e.state.owners[1] = p0.id; p0.props.push(1);
    ok(e.canUpgradeLevel(p0, 1), '关闭经典规则后单块地应可建房');
    for (let k = 0; k < 8; k++) e.buyHouse(p0, 1);
    ok(e.state.houses[1] === DC.CONFIG.maxHouses,
      `宽松规则下应能升到 ${DC.CONFIG.maxHouses} 级，实得 ${e.state.houses[1]}`);
    ok(!e.canUpgradeLevel(p0, 3), '未持有的地始终不能建房');
  }

  // 升级扣款、拆房回款
  {
    const e = mk(), p0 = e.player(0);
    grant(e, p0, DC.GROUP_CELLS.A);
    const before = p0.cash;
    e.buyHouse(p0, 1);
    ok(p0.cash === before - DC.CELLS[1].houseCost && e.state.houses[1] === 1,
      `升级后现金/房屋数不对：${p0.cash}, ${e.state.houses[1]}`);
    e.sellHouse(p0, 1);
    ok(p0.cash === before - DC.CELLS[1].houseCost + DC.CELLS[1].houseCost * DC.CONFIG.houseSellRate,
      `拆房回款不是 ${DC.CONFIG.houseSellRate * 100}%：${p0.cash}`);
    ok(e.state.houses[1] === undefined, '房屋拆到 0 后应从 houses 表里移除');
  }

  // 抵押得半价、赎回付 110%
  {
    const e = mk(), p0 = e.player(0);
    e.state.owners[1] = p0.id; p0.props.push(1);
    const before = p0.cash;
    e.mortgage(p0, 1);
    const got = p0.cash - before;
    ok(got === Math.round(DC.CELLS[1].price * DC.CONFIG.mortgageRate) && e.state.mortgaged[1] === true,
      `抵押应得半价 ${DC.CELLS[1].price / 2}，实得 ${got}`);
    p0.cash += 10000;
    const mid = p0.cash;
    e.unmortgage(p0, 1);
    const cost = Math.round(DC.CELLS[1].price * DC.CONFIG.mortgageRate * DC.CONFIG.unmortgageRate);
    ok(e.state.mortgaged[1] === undefined, '赎回后不应再被标记为抵押');
    ok(mid - p0.cash === cost, `赎回应付 ${cost}（110%），实付 ${mid - p0.cash}`);
  }

  // 有房抵押、抵押中再抵押
  {
    const e = mk(), p0 = e.player(0);
    e.state.owners[1] = p0.id; p0.props.push(1);
    e.state.houses[1] = 1;
    ok(!e.canMortgage(p0, 1), '有房屋的地不应允许抵押');
    delete e.state.houses[1];
    e.mortgage(p0, 1);
    ok(!e.canMortgage(p0, 1), '已抵押的地不应允许重复抵押');
    ok(!e.canSellHouse(p0, 1), '没有房屋时不应允许拆房');
  }

  // 经过起点发薪
  {
    const e = mk(), p0 = e.player(0);
    const before = p0.cash;
    await e.moveBy(p0, 24, e._loopId);
    ok(p0.cash === before + DC.CONFIG.goSalary && p0.pos === 0,
      `绕行一圈应 +${DC.CONFIG.goSalary} 并回到起点，实得 ${p0.cash - before} @${p0.pos}`);
  }

  // 所得税：10%，下限 1,000
  {
    const e = mk(), p0 = e.player(0);
    p0.pos = 4; p0.cash = 1000;
    await e.resolveLanding(p0, e._loopId, 0);
    ok(p0.cash === 0, `1,000 现金缴税后应为 0（税率 10%、下限 ${DC.CONFIG.taxMin}），实得 ${p0.cash}`);
    ok(e.state.pot === 1000, `税款应进罚款池，实得 ${e.state.pot}`);
  }

  // 免费停车领走罚款池
  {
    const e = mk(), p0 = e.player(0);
    p0.pos = 12; p0.cash = 0; e.state.pot = 777;
    await e.resolveLanding(p0, e._loopId, 0);
    ok(p0.cash === 777 && e.state.pot === 0, `免费停车未领走罚款池：cash=${p0.cash}, pot=${e.state.pot}`);
  }

  // 入狱：位置强制到监狱、不经过起点、不发薪
  {
    const e = mk(), p0 = e.player(0);
    p0.pos = 23; const before = p0.cash;
    await e.sendToJail(p0);
    ok(p0.pos === DC.CONFIG.jailPos && p0.inJail && p0.cash === before,
      `入狱后状态不对：pos=${p0.pos}, inJail=${p0.inJail}, 现金变化=${p0.cash - before}`);
  }

  // 破产清算：2 人局，资产转给债权人、对局随之结束、排名合法
  {
    const e = mk(2);
    const victim = e.player(0), creditor = e.player(1);
    e.state.owners[1] = victim.id; victim.props.push(1);
    e.state.owners[3] = creditor.id; creditor.props.push(3);
    e.state.houses[1] = 2;
    victim.cash = 100;
    await e.pay(victim, creditor, 5000);
    ok(victim.bankrupt && e.state.over,
      `2 人局一人破产后对局应结束：bankrupt=${victim.bankrupt}, over=${e.state.over}`);
    ok(e.state.owners[1] === creditor.id && creditor.props.indexOf(1) >= 0,
      '破产者的地产应全部转给债权人');
    ok(e.state.ranking && e.state.ranking[0] === creditor.id && victim.props.length === 0,
      `排名或资产清空不对：ranking=${e.state.ranking}, victim.props=${victim.props}`);
  }

  // 4 人局里一人破产：其他三人继续，轮到破产者的顺序会被跳过
  {
    const e = mk(4);
    const victim = e.player(0);
    victim.cash = 100;
    e.state.current = 3;
    await e.pay(victim, null, 5000);
    const alive = e.state.players.filter((p) => !p.bankrupt).length;
    ok(victim.bankrupt && !e.state.over && alive === 3,
      `4 人局一人破产不应结束对局：over=${e.state.over}, alive=${alive}`);
    e.advance();
    ok(!e.state.players[e.state.current].bankrupt && e.state.current === 1,
      `advance 应跳过已破产的 0 号位，落到 ${e.state.current}`);
  }

  // 踩到别人的地：按 calcRent 扣款，且钱确实进了房东口袋
  {
    const e = mk(2);
    const me = e.player(0), other = e.player(1);
    e.state.owners[1] = other.id; other.props.push(1);
    me.pos = 1;
    const before = me.cash, landlordBefore = other.cash;
    const rent = e.calcRent(DC.CELLS[1]);
    await e.resolveLanding(me, e._loopId, 0);
    ok(me.cash === before - rent, `付租金额不对：应扣 ${rent}，实扣 ${before - me.cash}`);
    ok(other.cash === landlordBefore + rent, `房东未收到租金：期望 +${rent}，实得 ${other.cash - landlordBefore}`);
  }

  // 停在无主地：现金够 → 询问购买 → 买下后归属正确
  {
    const e = mk(2);
    const me = e.player(0);
    me.cash = 15000; me.pos = 1;
    await e.resolveLanding(me, e._loopId, 0);
    ok(e.state.owners[1] === me.id && me.props.indexOf(1) >= 0,
      '现金充足时应能买下无主地');
    ok(me.cash === 15000 - DC.CELLS[1].price,
      `买地扣款不对：应扣 ${DC.CELLS[1].price}，实扣 ${15000 - me.cash}`);
  }

  // 停在自己的地：询问升级 → 同意后房屋 +1
  {
    const e = mk(2);
    const me = e.player(0);
    grant(e, me, DC.GROUP_CELLS.A);
    me.cash = 15000; me.pos = 1;
    e.state.round = 5;                       // normal 策略第 2 回合后才升
    await e.resolveLanding(me, e._loopId, 0);
    ok(e.state.houses[1] === 1, `踩到自有地同意升级后房屋应为 1，实得 ${e.state.houses[1]}`);
    ok(me.cash === 15000 - DC.CELLS[1].houseCost, `升级扣款不对：${15000 - me.cash}`);
  }

  // 拍卖：人类唯一出价 → 以最低加价成交
  {
    const e = mk(3);
    e.aiBid = () => false;                   // 让 AI 全部弃拍，专测人类出价路径
    const human = e.player(0);
    human.cash = 5000;
    const cell = DC.CELLS[1];
    await e.runAuction(cell, e.player(1), e._loopId);
    const step = Math.max(100, DC.util.roundTo(cell.price * 0.1, 100));
    ok(e.state.owners[1] === human.id && human.props.indexOf(1) >= 0,
      `人类出价后应拍得该地块，实际 owner=${e.state.owners[1]}`);
    ok(human.cash === 5000 - step, `成交价应为一次加价 ${step}，实付 ${5000 - human.cash}`);
  }

  // 拍卖：全员弃拍 → 流拍，地块仍归银行
  {
    const e = mk(3);
    e.aiBid = () => false;
    const human = e.player(0);
    human.cash = 0;                          // 出价上限 = 现金×0.3 = 0 → 必弃拍
    await e.runAuction(DC.CELLS[1], e.player(1), e._loopId);
    ok(e.state.owners[1] === undefined, `流拍后地块不应有主，实际 owner=${e.state.owners[1]}`);
    ok(human.cash === 0, '流拍不应产生任何扣款');
  }

  // 卡牌：抽到「收取 ¥500」应真的进账，并推进牌堆指针
  {
    const e = mk(2);
    const p = e.player(0);
    const card = DC.CHANCE.filter((c) => c.kind === 'gain')[0];
    e.state.chance = [card]; e.state.chanceIdx = 0;
    p.pos = 8; p.cash = 1000;                // 机会格
    await e.resolveLanding(p, e._loopId, 0);
    ok(p.cash === 1000 + card.amount, `抽到「${card.text}」后现金应为 ${1000 + card.amount}，实得 ${p.cash}`);
    ok(e.state.chanceIdx === 1, `抽牌后指针应前进，实为 ${e.state.chanceIdx}`);
  }

  // 卡牌：被「直接入狱」应停止按原路继续结算
  {
    const e = mk(2);
    const p = e.player(0);
    const card = DC.FATE.filter((c) => c.kind === 'jail')[0];
    e.state.fate = [card]; e.state.fateIdx = 0;
    p.pos = 14;                              // 命运格
    p.cash = 5000;
    await e.resolveLanding(p, e._loopId, 0);
    ok(p.inJail && p.pos === DC.CONFIG.jailPos && p.cash === 5000,
      `「${card.text}」后应入狱且不产生费用：inJail=${p.inJail}, pos=${p.pos}, cash=${p.cash}`);
  }

  // 现金不足时自动变卖家产，凑够则不破产
  {
    const e = mk(2);
    const victim = e.player(0);
    e.state.owners[1] = victim.id; victim.props.push(1);
    e.state.houses[1] = 4;
    victim.cash = 100;
    const amount = victim.cash + Math.round(DC.CELLS[1].houseCost * 0.5) * 2;   // 拆两栋就够
    await e.pay(victim, null, amount);
    ok(!victim.bankrupt && e.state.houses[1] === 2 && victim.cash >= 0,
      `拆房凑钱失败：bankrupt=${victim.bankrupt}, houses=${e.state.houses[1]}, cash=${victim.cash}`);
  }
}

/* ============================================================
   B. 随机对局：逐回合不变量
   ============================================================ */
{
  const g = group('对局不变量');
  const policies = ['normal', 'cautious', 'reckless'];
  let totalAsks = 0, totalRounds = 0, capped = 0, ended = 0, totalHouses = 0, totalOwned = 0;
  const byType = {}, cov = {};
  // 两种建房规则各跑一半：既覆盖两条分支，也能量化对局长度差异
  const byRules = { classic: { n: 0, rounds: 0, houses: 0 }, simple: { n: 0, rounds: 0, houses: 0 } };

  for (let i = 0; i < GAMES; i++) {
    const seed = SEED0 + i;
    const policy = policies[i % policies.length];
    const classic = i % 2 === 0;
    const world = createWorld(seed);
    const checker = makeChecker(world);
    const r = await playGame(seed, policy, checker, world, MAX_ROUNDS, classic);
    totalAsks += r.asks; totalRounds += r.round; totalHouses += r.houses; totalOwned += r.owned;
    if (r.capped) capped++; else if (r.over) ended++;
    const b = byRules[classic ? 'classic' : 'simple'];
    b.n++; b.rounds += r.round; b.houses += r.houses;
    Object.entries(r.byType).forEach(([k, v]) => { byType[k] = (byType[k] || 0) + v; });
    Object.entries(r.cov).forEach(([k, v]) => { cov[k] = (cov[k] || 0) + v; });
    if (r._fails.length) {
      g.fail.push(`种子 ${seed}（${policy}）出现 ${r._fails.length} 处不变量违背`);
      r._fails.slice(0, 3).forEach((m) => g.fail.push(`    · ${m}`));
    } else g.pass++;
    if (VERBOSE) {
      console.log(C.dim(
        `  种子 ${String(seed).padEnd(4)} ${policy.padEnd(9)} ${classic ? '经典' : '宽松'} 回合 ${String(r.round).padStart(4)} ` +
        `存活 ${r.alive} 地产 ${String(r.owned).padStart(2)} 房 ${String(r.houses).padStart(3)} ` +
        `${r.over ? (r.capped ? '触及回合上限' : '自然结束 → ' + r.winner) : '未结束'} ` +
        `决策 ${String(r.asks).padStart(4)} hash=${r.hash}`
      ));
    }
  }
  g.notes.push(`${GAMES} 局 · 合计 ${totalRounds} 回合 / ${totalAsks} 次人类决策 · 自然结束 ${ended} 局、触顶收尾 ${capped} 局`);
  g.notes.push(`终局平均：地产 ${(totalOwned / GAMES).toFixed(1)} 处、房屋 ${(totalHouses / GAMES).toFixed(1)} 栋`);
  g.notes.push('建房规则对比 ' + ['classic', 'simple'].map((k) => {
    const x = byRules[k];
    if (!x.n) return '';
    return `${k === 'classic' ? '经典' : '宽松'} ${x.n} 局：平均 ${(x.rounds / x.n).toFixed(0)} 回合、`
      + `${(x.houses / x.n).toFixed(1)} 栋房屋`;
  }).filter(Boolean).join(' · '));
  g.notes.push('决策分布 ' + Object.entries(byType).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`).join(' '));

  // 路径覆盖：确认关键分支真的被跑到，而不是「碰巧没错」
  const expected = [
    'land:prop', 'land:rail', 'land:util', 'land:tax', 'land:parking',
    'land:chance', 'land:fate', 'land:gotojail', 'land:go', 'land:jail',
    'runAuction', 'drawCard', 'buyHouse', 'sellHouse', 'mortgage',
    'unmortgage', 'declareBankrupt', 'sendToJail', 'buy'
  ];
  const missed = expected.filter((k) => !cov[k]);
  g.notes.push('路径覆盖 ' + expected.filter((k) => cov[k]).map((k) => `${k.replace('land:', '')}:${cov[k]}`).join(' '));
  if (missed.length) g.notes.push('未覆盖（加大 --games 或换 --seed 试试）：' + missed.join(' '));
  if (!byType.auction)
    g.notes.push('人类在随机对局里从未被问到「是否加价」：拍卖基本由人类自己放弃购买触发，而发起人按规则不参与竞拍；'
      + '拍卖的出价分支由上面两条拍卖单元用例覆盖');

  if (ended === 0) g.notes.push('注意：没有任何一局自然结束，说明对局时长偏长（不是错误，但值得留意）');
}

/* ============================================================
   C. 确定性：同种子两跑必须完全一致
   ============================================================ */
{
  const g = group('确定性');
  for (let i = 0; i < Math.min(3, GAMES); i++) {
    const seed = SEED0 + i;
    const policy = ['normal', 'cautious', 'reckless'][i % 3];
    const run = async () => {
      const w = createWorld(seed);
      return playGame(seed, policy, makeChecker(w), w, MAX_ROUNDS);
    };
    const a = await run(), b = await run();
    const same = a.hash === b.hash && a.round === b.round && a.over === b.over && a.owned === b.owned;
    if (same) g.pass++;
    else g.fail.push(`种子 ${seed}（${policy}）两次结果不一致：${a.hash}/${a.round} vs ${b.hash}/${b.round}`);
  }
  g.notes.push('同种子重跑终局哈希一致：引擎没有时间 / 外部 I/O 之类的隐性依赖');
}

/* ============================================================
   D. 存档往返
   ============================================================ */
{
  const g = group('存档往返');
  const world = createWorld(SEED0);
  const { DC } = world;
  const { eng } = makeEngine(DC, { humanPolicy: POLICIES.normal });
  const ok = (cond, msg) => { if (cond) g.pass++; else g.fail.push(msg); };

  eng.newGame(4);
  // 先手动推进一阵，让局面有内容（有主的地、房屋、抵押）
  for (let i = 0; i < 60 && !eng.state.over; i++) {
    const p = eng.currentPlayer;
    if (!p || p.bankrupt) { eng.advance(); continue; }
    await eng.moveBy(p, 1 + (i % 6), eng._loopId);
    if (eng.state.over) break;
    await eng.resolveLanding(p, eng._loopId, 0);
    if (eng.state.over) break;
    eng.advance();
  }

  ok(DC.Store.save(eng.state) === true, '存档写入失败');
  const snap = DC.Store.load();
  ok(!!snap && snap.players.length === 4 && snap.owners !== undefined, '存档读回失败或字段缺失');

  if (snap) {
    const sig = (s) => s.players.map((p) => `${p.name}:${p.cash}:${p.pos}:${p.props.join('.')}`).join('|');
    ok(sig(snap) === sig(eng.state), '存档内容与当前状态不一致');
    ok(JSON.stringify(snap.owners) === JSON.stringify(eng.state.owners), '存档中的地产归属不一致');
    ok(snap.round === eng.state.round, `存档回合数不一致：${snap.round} vs ${eng.state.round}`);

    // 恢复后引擎能继续推进
    const { eng: eng2 } = makeEngine(DC, { humanPolicy: POLICIES.cautious });
    eng2.restore(DC.Store.load());
    ok(eng2.state.players.length === 4 && eng2.state.round === snap.round, 'restore 后状态不对');
    const p2 = eng2.currentPlayer;
    await eng2.moveBy(p2, 3, eng2._loopId);
    ok(Number.isInteger(p2.pos) && p2.pos >= 0 && p2.pos < 24, '恢复后无法继续移动');
  }

  // 版本不符的存档必须被拒绝
  world.store.set('dc.monopoly.save.v1', JSON.stringify({ v: '0.0.1', players: [{}] }));
  ok(DC.Store.load() === null, '旧版本存档未被拒绝');

  // 旧版双骰存档必须被拒绝
  world.store.set('dc.monopoly.save.v1', JSON.stringify({ v: DC.CONFIG.version, players: [{}], dice: [1, 2] }));
  ok(DC.Store.load() === null, '旧版双骰存档未被拒绝');

  // 已结束的对局不应被恢复
  world.store.set('dc.monopoly.save.v1', JSON.stringify({ v: DC.CONFIG.version, players: [{}], over: true }));
  ok(DC.Store.load() === null, '已结束的对局不应被恢复');

  // 存档里 log 只保留尾部 40 条
  const kept = DC.Store.load();
  if (kept) ok(kept.log.length <= 40, `存档应只保留 40 条战报，实存 ${kept.log.length}`);
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + '─'.repeat(64));
let failed = 0;
groups.forEach((g) => {
  failed += g.fail.length;
  const bad = g.fail.length;
  console.log(`${bad ? C.bad('✗') : C.ok('✓')} ${g.name.padEnd(12)} ${C.dim(`${g.pass} 项通过`)}${bad ? ' ' + C.bad(`${bad} 项失败`) : ''}`);
  g.fail.slice(0, 10).forEach((m) => console.log('    ' + C.bad('→ ' + m)));
  if (g.fail.length > 10) console.log(C.dim(`    … 另有 ${g.fail.length - 10} 条`));
  g.notes.forEach((m) => console.log('    ' + C.dim(m)));
});
console.log('─'.repeat(64));
if (failed) {
  console.log(C.bad(`FAIL  ${failed} 项断言未通过（种子 ${SEED0}，用 --seed=${SEED0} 复现）`));
  process.exit(1);
}
console.log(C.ok('PASS  规则不变量全部成立'));
