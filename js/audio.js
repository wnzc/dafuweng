/* ============================================================
   音效 + 背景音乐：全部用 WebAudio 现场合成，不加载任何音频文件。
   双总线：sfx 总线（事件音） / music 总线（循环 BGM）
   ============================================================ */
window.DC = window.DC || {};

(function (DC) {
  'use strict';

  var ctx = null;
  var master = null;
  var sfxBus = null;
  var musicBus = null;
  var enabled = true;
  var musicOn = true;

  /* 音量：整体偏响，但不过载 */
  var MASTER = 0.9;
  var SFX_VOL = 1.0;
  var MUSIC_VOL = 0.22;

  /* ---------- 上下文 ---------- */
  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(ctx.destination);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_VOL;
    sfxBus.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = 0;
    musicBus.connect(master);
    return ctx;
  }

  function now() { return ctx.currentTime; }

  function resume() {
    if (!ensure()) return false;
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  /* ---------- 合成基元 ---------- */
  function tone(opt) {
    if (!enabled || !resume()) return;
    var t0 = now() + (opt.delay || 0);
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    var dest = opt.bus || sfxBus;
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.f0, t0);
    if (opt.f1 && opt.f1 !== opt.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opt.f1), t0 + opt.dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, opt.vol || 0.28), t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
    osc.connect(g); g.connect(dest);
    osc.start(t0); osc.stop(t0 + opt.dur + 0.03);
  }

  function noise(opt) {
    if (!enabled || !resume()) return;
    var t0 = now() + (opt.delay || 0);
    var dur = opt.dur || 0.14;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var flt = ctx.createBiquadFilter();
    flt.type = opt.filter || 'bandpass';
    flt.frequency.value = opt.freq || 1800;
    flt.Q.value = opt.q || 0.9;
    var g = ctx.createGain();
    var dest = opt.bus || sfxBus;
    g.gain.setValueAtTime(opt.vol || 0.3, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt); flt.connect(g); g.connect(dest);
    src.start(t0); src.stop(t0 + dur + 0.03);
  }

  /* 简易和弦：多个正弦叠在一起 */
  function chord(freqs, opt) {
    freqs.forEach(function (f, i) {
      tone({
        type: opt.type || 'triangle',
        f0: f,
        dur: opt.dur || 0.35,
        vol: (opt.vol || 0.18) * (i === 0 ? 1 : 0.72),
        delay: (opt.delay || 0) + i * 0.012,
        bus: opt.bus
      });
    });
  }

  /* ---------- 背景音乐引擎 ---------- */
  var music = {
    timer: null,
    nextTime: 0,
    bar: 0,
    playing: false,
    /* 1930s 沪上轻爵士感：Cmaj7 - Am7 - Dm7 - G7，两小节一循环，再变奏 */
    chords: [
      [261.63, 329.63, 392.00, 493.88],  // Cmaj7
      [220.00, 261.63, 329.63, 392.00],  // Am7
      [146.83, 174.61, 220.00, 261.63],  // Dm7
      [196.00, 246.94, 293.66, 349.23]   // G7
    ],
    bass: [130.81, 110.00, 73.42, 98.00],
    melody: [
      [523.25, 0.35], [587.33, 0.2], [659.25, 0.45], [0, 0.2],
      [587.33, 0.35], [523.25, 0.2], [440.00, 0.5], [0, 0.2],
      [466.16, 0.3], [523.25, 0.25], [587.33, 0.35], [0, 0.25],
      [493.88, 0.3], [440.00, 0.25], [392.00, 0.55], [0, 0.35]
    ],

    scheduleBar: function (t, barIdx) {
      var ch = this.chords[barIdx % 4];
      var b = this.bass[barIdx % 4];
      var beat = 0.42; // 略慢的摇摆感
      var bus = musicBus;

      // 低音：根音 + 五度走句
      tone({ type: 'triangle', f0: b, dur: beat * 0.9, vol: 0.28, delay: t - now(), bus: bus });
      tone({ type: 'triangle', f0: b * 1.5, dur: beat * 0.7, vol: 0.18, delay: t - now() + beat * 1.5, bus: bus });

      // 和弦垫：每拍轻轻一击
      [0, 1, 2, 3].forEach(function (i) {
        chord(ch, { type: 'sine', dur: 0.28, vol: 0.09, delay: t - now() + i * beat, bus: bus });
      });

      // 轻打点：噪声踩镲
      [0.5, 1.5, 2.5, 3.5].forEach(function (i) {
        noise({
          filter: 'highpass', freq: 5000, dur: 0.04, vol: 0.035, q: 0.5,
          delay: t - now() + i * beat, bus: bus
        });
      });

      // 旋律：隔小节弹一句
      if (barIdx % 2 === 1) {
        var mt = t;
        this.melody.forEach(function (n) {
          if (n[0] > 0) {
            tone({ type: 'triangle', f0: n[0], dur: n[1] * 0.85, vol: 0.12, delay: mt - now(), bus: bus });
          }
          mt += n[1] * beat * 2;
        });
      }
    },

    start: function () {
      if (this.playing || !musicOn || !resume()) return;
      this.playing = true;
      this.nextTime = now() + 0.08;
      this.bar = 0;
      var self = this;
      var tick = function () {
        if (!self.playing) return;
        var horizon = now() + 0.9;
        while (self.nextTime < horizon) {
          self.scheduleBar(self.nextTime, self.bar);
          self.nextTime += 0.42 * 4;
          self.bar++;
        }
        self.timer = setTimeout(tick, 180);
      };
      // 淡入
      musicBus.gain.cancelScheduledValues(now());
      musicBus.gain.setValueAtTime(0.0001, now());
      musicBus.gain.linearRampToValueAtTime(MUSIC_VOL, now() + 1.2);
      tick();
    },

    stop: function () {
      if (!this.playing) return;
      this.playing = false;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (ctx && musicBus) {
        musicBus.gain.cancelScheduledValues(now());
        musicBus.gain.setValueAtTime(musicBus.gain.value, now());
        musicBus.gain.linearRampToValueAtTime(0.0001, now() + 0.45);
      }
    }
  };

  /* ---------- 触觉反馈 ---------- */
  function canVibrate() {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  function doVibrate(pattern) {
    if (!canVibrate()) return false;
    try {
      return !!navigator.vibrate(pattern);
    } catch (e) {
      return false;
    }
  }

  /* ---------- 对外 API ---------- */
  DC.haptics = {
    supported: canVibrate,
    /* 轻触：按钮点击。时长 ≥28ms 才容易被感知 */
    tap: function () { return doVibrate(28); },
    soft: function () { return doVibrate(16); },
    medium: function () { return doVibrate([20, 40, 20]); },
    strong: function () { return doVibrate([40, 50, 40]); },
    jail: function () { return doVibrate([30, 70, 30, 70, 50]); },
    vibrate: doVibrate
  };

  DC.audio = {
    setEnabled: function (v) {
      enabled = !!v;
      if (!enabled) {
        if (sfxBus && ctx) sfxBus.gain.setTargetAtTime(0.0001, now(), 0.05);
        return;
      }
      // 已有上下文才恢复，避免页面加载时抢建 AudioContext
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume();
        sfxBus.gain.setTargetAtTime(SFX_VOL, now(), 0.05);
      }
    },
    isEnabled: function () { return enabled; },

    setMusic: function (v) {
      musicOn = !!v;
      if (!musicOn) { music.stop(); return; }
      // 仅在已经解锁后才真正起播
      if (ctx && ctx.state === 'running') music.start();
    },
    isMusic: function () { return musicOn; },
    startMusic: function () { if (musicOn && ctx && ctx.state === 'running') music.start(); },
    stopMusic: function () { music.stop(); },

    unlock: function () {
      if (!resume()) return;
      if (musicOn) music.start();
    },

    /* ===== 事件音效（音量已整体上调） ===== */

    click: function () {
      tone({ type: 'sine', f0: 820, f1: 540, dur: 0.055, vol: 0.26 });
      noise({ freq: 2600, dur: 0.035, vol: 0.12, q: 2.2 });
      tone({ type: 'triangle', f0: 1240, dur: 0.04, vol: 0.08, delay: 0.01 });
    },

    dice: function () {
      for (var i = 0; i < 5; i++) {
        noise({ freq: 900 + Math.random() * 2400, dur: 0.07, vol: 0.28, delay: i * 0.05, q: 2 });
      }
      noise({ filter: 'lowpass', freq: 320, dur: 0.2, vol: 0.4, q: 0.8, delay: 0.24 });
      tone({ type: 'triangle', f0: 240, f1: 80, dur: 0.18, vol: 0.2, delay: 0.24 });
    },

    step: function () {
      noise({ freq: 1400, dur: 0.055, vol: 0.16, q: 3 });
      tone({ type: 'sine', f0: 420, f1: 280, dur: 0.05, vol: 0.06 });
    },

    coin: function () {
      // 收钱：清脆上行
      tone({ type: 'square', f0: 988, dur: 0.05, vol: 0.22 });
      tone({ type: 'square', f0: 1319, dur: 0.05, vol: 0.2, delay: 0.05 });
      tone({ type: 'square', f0: 1760, dur: 0.12, vol: 0.18, delay: 0.1 });
      tone({ type: 'sine', f0: 2637, dur: 0.18, vol: 0.08, delay: 0.12 });
    },

    cash: function () {
      // 大额进账 / 罚款池
      for (var i = 0; i < 6; i++) {
        tone({ type: 'square', f0: 880 + i * 180, dur: 0.07, vol: 0.16, delay: i * 0.04 });
      }
      chord([523, 659, 784], { type: 'triangle', dur: 0.35, vol: 0.14, delay: 0.28 });
    },

    pay: function () {
      // 付钱：下行 + 叹息
      tone({ type: 'sawtooth', f0: 480, f1: 160, dur: 0.28, vol: 0.22 });
      noise({ freq: 650, dur: 0.14, vol: 0.14, delay: 0.04 });
      tone({ type: 'sine', f0: 180, f1: 90, dur: 0.2, vol: 0.1, delay: 0.1 });
    },

    rent: function () {
      tone({ type: 'square', f0: 340, f1: 200, dur: 0.16, vol: 0.18 });
      tone({ type: 'square', f0: 280, f1: 140, dur: 0.2, vol: 0.16, delay: 0.12 });
      noise({ filter: 'lowpass', freq: 500, dur: 0.18, vol: 0.16, delay: 0.08 });
    },

    tax: function () {
      noise({ filter: 'bandpass', freq: 400, dur: 0.25, vol: 0.28, q: 1.2 });
      tone({ type: 'sawtooth', f0: 220, f1: 110, dur: 0.35, vol: 0.16 });
    },

    stamp: function () {
      // 买地盖章
      noise({ filter: 'lowpass', freq: 280, dur: 0.2, vol: 0.55, q: 0.7 });
      tone({ type: 'sine', f0: 160, f1: 55, dur: 0.22, vol: 0.28 });
      tone({ type: 'triangle', f0: 520, f1: 780, dur: 0.12, vol: 0.12, delay: 0.12 });
    },

    buy: function () {
      this.stamp();
      tone({ type: 'square', f0: 660, dur: 0.08, vol: 0.16, delay: 0.18 });
      tone({ type: 'square', f0: 880, dur: 0.14, vol: 0.14, delay: 0.26 });
    },

    bid: function () {
      tone({ type: 'square', f0: 523, dur: 0.06, vol: 0.18 });
      tone({ type: 'square', f0: 659, dur: 0.06, vol: 0.16, delay: 0.06 });
      tone({ type: 'square', f0: 784, dur: 0.1, vol: 0.14, delay: 0.12 });
    },

    auction: function () {
      // 拍卖槌
      noise({ filter: 'lowpass', freq: 350, dur: 0.16, vol: 0.5, q: 0.6 });
      tone({ type: 'sine', f0: 120, f1: 50, dur: 0.22, vol: 0.3 });
    },

    mortgage: function () {
      tone({ type: 'triangle', f0: 392, f1: 294, dur: 0.22, vol: 0.18 });
      noise({ filter: 'lowpass', freq: 900, dur: 0.18, vol: 0.14 });
    },

    unmortgage: function () {
      tone({ type: 'triangle', f0: 294, f1: 440, dur: 0.2, vol: 0.18 });
      tone({ type: 'sine', f0: 587, dur: 0.18, vol: 0.12, delay: 0.12 });
    },

    sell: function () {
      noise({ filter: 'bandpass', freq: 800, dur: 0.22, vol: 0.3, q: 1 });
      tone({ type: 'sawtooth', f0: 300, f1: 150, dur: 0.25, vol: 0.14 });
    },

    card: function () {
      noise({ filter: 'highpass', freq: 2800, dur: 0.18, vol: 0.22, q: 0.6 });
      tone({ type: 'sine', f0: 880, f1: 1480, dur: 0.16, vol: 0.12, delay: 0.04 });
      tone({ type: 'sine', f0: 1760, dur: 0.12, vol: 0.08, delay: 0.12 });
    },

    chance: function () {
      this.card();
      [660, 880, 1100].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 0.12, vol: 0.1, delay: 0.16 + i * 0.07 });
      });
    },

    fate: function () {
      this.card();
      [880, 660, 440].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 0.14, vol: 0.1, delay: 0.16 + i * 0.08 });
      });
    },

    jail: function () {
      // 铁门
      noise({ filter: 'bandpass', freq: 420, dur: 0.45, vol: 0.45, q: 1.5 });
      noise({ filter: 'bandpass', freq: 180, dur: 0.5, vol: 0.35, q: 2, delay: 0.05 });
      tone({ type: 'square', f0: 95, f1: 40, dur: 0.55, vol: 0.22, delay: 0.02 });
    },

    free: function () {
      // 出狱：开锁轻快
      noise({ freq: 2200, dur: 0.08, vol: 0.2, q: 3 });
      tone({ type: 'triangle', f0: 392, f1: 523, dur: 0.14, vol: 0.16, delay: 0.05 });
      tone({ type: 'triangle', f0: 659, dur: 0.18, vol: 0.14, delay: 0.14 });
    },

    build: function () {
      // 盖房：锤击 + 上行
      noise({ filter: 'lowpass', freq: 400, dur: 0.1, vol: 0.35, q: 0.8 });
      tone({ type: 'triangle', f0: 520, dur: 0.08, vol: 0.18, delay: 0.08 });
      tone({ type: 'triangle', f0: 780, dur: 0.09, vol: 0.16, delay: 0.16 });
      tone({ type: 'triangle', f0: 1040, dur: 0.14, vol: 0.15, delay: 0.25 });
    },

    hotel: function () {
      // 酒店：更华丽
      noise({ filter: 'lowpass', freq: 350, dur: 0.14, vol: 0.45, q: 0.7 });
      [523, 659, 784, 1047, 1319, 1568].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 0.22, vol: 0.14, delay: 0.1 + i * 0.07 });
      });
      chord([262, 330, 392, 523], { type: 'sine', dur: 0.55, vol: 0.12, delay: 0.55 });
    },

    turn: function () {
      tone({ type: 'sine', f0: 660, dur: 0.08, vol: 0.16 });
      tone({ type: 'sine', f0: 990, dur: 0.12, vol: 0.14, delay: 0.07 });
    },

    start: function () {
      // 开局小 fanfare
      [392, 523, 659, 784].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 0.2, vol: 0.16, delay: i * 0.09 });
      });
      chord([262, 330, 392], { type: 'sine', dur: 0.5, vol: 0.12, delay: 0.4 });
    },

    win: function () {
      [523, 659, 784, 1047, 1319, 1568].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 0.36, vol: 0.2, delay: i * 0.1 });
      });
      chord([262, 330, 392, 523], { type: 'sine', dur: 0.9, vol: 0.16, delay: 0.7 });
    },

    lose: function () {
      [392, 330, 262, 196, 147].forEach(function (f, i) {
        tone({ type: 'sawtooth', f0: f, dur: 0.32, vol: 0.16, delay: i * 0.13 });
      });
    },

    bankrupt: function () {
      this.lose();
      noise({ filter: 'lowpass', freq: 200, dur: 0.6, vol: 0.3, delay: 0.2 });
    }
  };
})(window.DC);
