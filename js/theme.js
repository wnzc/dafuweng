/* ============================================================
   主题：跟随系统 / 白天 / 黑夜
   ------------------------------------------------------------
   三档偏好存在设置里（dc.monopoly.settings.v1 的 theme 字段），这里把它解析成
   <html data-theme="light|dark"> —— 颜色全部在 styles.css 的 :root（白天）与
   html[data-theme="dark"]（黑夜）两套令牌里，换主题等于换那一百来个值。

   这个文件在 <head> 里同步执行（在 <link rel="stylesheet"> 之前），所以首屏
   不会先闪一下白天再变黑。

   谁负责持久化：设置弹层改的是 engine.settings.theme，仍由 main.js 的
   DC.saveSettings 统一写 localStorage；这里只读、不写，免得两处各写一份互相覆盖。
   ============================================================ */
(function (DC) {
  'use strict';

  var SETTINGS_KEY = 'dc.monopoly.settings.v1';
  var MODES = ['auto', 'light', 'dark'];

  /* 浏览器自己的 UI（地址栏、状态栏）跟着天空底色走 */
  var CHROME = { light: '#2E6FBE', dark: '#17233C' };

  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function isMode(v) { return MODES.indexOf(v) >= 0; }

  /* 只读设置，失败就当作「跟随系统」 */
  function storedMode() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      var s = raw ? JSON.parse(raw) : null;
      return s && isMode(s.theme) ? s.theme : 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  function currentMode() {
    var m = document.documentElement.getAttribute('data-theme-mode');
    return isMode(m) ? m : 'auto';
  }

  /* auto -> 看系统；light / dark -> 直接就是它 */
  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return mq && mq.matches ? 'dark' : 'light';
  }

  /* 主题变了要通知一声：首页那颗太阳 / 月亮按钮、设置里的分段器都得跟着改 */
  var listeners = [];

  function emit(theme, mode) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](theme, mode); } catch (e) { /* 单个监听器出错不影响换肤 */ }
    }
  }

  function apply(mode) {
    var m = isMode(mode) ? mode : storedMode();
    var theme = resolve(m);
    var root = document.documentElement;
    root.setAttribute('data-theme-mode', m);
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', CHROME[theme]);
    emit(theme, m);
    return theme;
  }

  DC.theme = {
    MODES: MODES,
    /* 切档并立刻生效；持久化交给调用方（DC.saveSettings） */
    set: apply,
    apply: apply,
    mode: currentMode,
    /* 当前实际看到的是白天还是黑夜 */
    effective: function () { return resolve(currentMode()); },
    /* 系统偏好是否会影响到当前主题（设置页拿来写说明文字） */
    followsSystem: function () { return currentMode() === 'auto'; },
    /* 注册主题变化回调（只在 init 里注册一次，所以不做注销） */
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

  /* 系统换主题时，只有「跟随系统」这一档需要跟着动 */
  if (mq) {
    var onChange = function () { if (currentMode() === 'auto') apply('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  apply(storedMode());
})(window.DC = window.DC || {});
