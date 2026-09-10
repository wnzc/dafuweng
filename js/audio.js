/* ============================================================
   音效：全部用 WebAudio 现场合成，不加载任何音频文件。
   ============================================================ */
window.DC = window.DC || {};

(function (DC) {
  'use strict';

  var ctx = null;
  var master = null;
  var enabled = true;

  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    return ctx;
  }

  function now() { return ctx.currentTime; }

  function tone(opt) {
    if (!enabled) return;
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    var t0 = now() + (opt.delay || 0);
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.f0, t0);
    if (opt.f1 && opt.f1 !== opt.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opt.f1), t0 + opt.dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opt.vol || 0.2, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + opt.dur + 0.02);
  }

  function noise(opt) {
    if (!enabled) return;
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
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
    g.gain.setValueAtTime(opt.vol || 0.22, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt); flt.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  DC.audio = {
    setEnabled: function (v) {
      enabled = !!v;
      if (enabled) { if (!ensure()) return; if (ctx.state === 'suspended') ctx.resume(); }
    },
    isEnabled: function () { return enabled; },
    unlock: function () { if (!ensure()) return; if (ctx.state === 'suspended') ctx.resume(); },

    dice: function () {
      for (var i = 0; i < 4; i++) {
        noise({ freq: 900 + Math.random() * 2200, dur: 0.07, vol: 0.16, delay: i * 0.055, q: 2 });
      }
      tone({ type: 'triangle', f0: 220, f1: 90, dur: 0.16, vol: 0.1, delay: 0.2 });
    },
    step: function () { noise({ freq: 1500, dur: 0.05, vol: 0.09, q: 3 }); },
    coin: function () {
      tone({ type: 'square', f0: 1180, dur: 0.06, vol: 0.12 });
      tone({ type: 'square', f0: 1720, dur: 0.1, vol: 0.1, delay: 0.06 });
    },
    pay: function () {
      tone({ type: 'sawtooth', f0: 420, f1: 180, dur: 0.22, vol: 0.11 });
      noise({ freq: 700, dur: 0.12, vol: 0.08, delay: 0.03 });
    },
    stamp: function () {
      noise({ filter: 'lowpass', freq: 260, dur: 0.18, vol: 0.4, q: 0.7 });
      tone({ type: 'sine', f0: 150, f1: 62, dur: 0.2, vol: 0.16 });
    },
    card: function () {
      noise({ filter: 'highpass', freq: 2600, dur: 0.16, vol: 0.13, q: 0.6 });
      tone({ type: 'sine', f0: 880, f1: 1320, dur: 0.14, vol: 0.07, delay: 0.04 });
    },
    jail: function () {
      noise({ filter: 'bandpass', freq: 480, dur: 0.4, vol: 0.3, q: 1.4 });
      tone({ type: 'square', f0: 90, f1: 44, dur: 0.5, vol: 0.16, delay: 0.02 });
    },
    build: function () {
      tone({ type: 'triangle', f0: 520, dur: 0.07, vol: 0.12 });
      tone({ type: 'triangle', f0: 780, dur: 0.09, vol: 0.11, delay: 0.07 });
      tone({ type: 'triangle', f0: 1040, dur: 0.12, vol: 0.1, delay: 0.15 });
    },
    turn: function () {
      tone({ type: 'sine', f0: 660, dur: 0.09, vol: 0.09 });
      tone({ type: 'sine', f0: 990, dur: 0.13, vol: 0.08, delay: 0.08 });
    },
    win: function () {
      [523, 659, 784, 1047, 1319].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 0.34, vol: 0.14, delay: i * 0.11 });
      });
    },
    lose: function () {
      [392, 330, 262, 196].forEach(function (f, i) {
        tone({ type: 'sawtooth', f0: f, dur: 0.3, vol: 0.11, delay: i * 0.13 });
      });
    }
  };
})(window.DC);
