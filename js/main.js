/* ============================================================
   启动：装配引擎与界面，恢复偏好设置
   ============================================================ */
(function (DC) {
  'use strict';

  var SETTINGS_KEY = 'dc.monopoly.settings.v1';

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      var s = raw ? JSON.parse(raw) : {};
      // 旧版本的「快 / 慢」倍率标反了，做一次迁移
      if (s.speed === 0.6) s.speed = 1.7;
      else if (s.speed === 1.5) s.speed = 0.65;
      return s;
    } catch (e) { return {}; }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        sound: s.sound, haptics: s.haptics, speed: s.speed
      }));
    } catch (e) {}
  }

  function boot() {
    var saved = loadSettings();
    var engine = new DC.Engine(null, saved);
    var ui = new DC.UI(engine);
    engine.ui = ui;
    window.DC.game = { engine: engine, ui: ui };

    ui.init();
    DC.audio.setEnabled(engine.settings.sound);
    ui.syncSound();

    // 供 UI 在设置变化时持久化
    DC.saveSettings = function () { saveSettings(engine.settings); };

    // 首次交互解锁音频
    var unlock = function () {
      DC.audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // 防止双指缩放与双击缩放（保留系统无障碍缩放开关）
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

    ui.openStart(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.DC);
