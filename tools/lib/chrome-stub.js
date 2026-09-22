/*!
 * chrome-stub.js —— 假的 chrome 扩展 API
 *
 * 让 content.js 能在普通网页里跑起来，方便做端到端测试。
 * 只实现 content.js 真正用到的那几个：runtime.sendMessage / onMessage、
 * storage.local.get / set。
 *
 * 所有发出去的消息类型都记进 window.__sent，方便断言「该发的发了没有」。
 */
(function () {
  'use strict';

  var MODE = window.__MODE || 'chapter';

  window.__sent = [];
  window.__captures = 0;

  // 测试用的设置。'off' 模式用来验证「关掉自动开标签后绝不点」
  var SETTINGS = {
    autoCapture: true,
    openQuizTab: MODE !== 'off',
    showBadge: true
  };
  window.__settings = SETTINGS;

  function respond(msg) {
    switch (msg && msg.type) {
      case 'GET_SUMMARY':
        return { ok: true, totalQuestions: 0, totalBanks: 0 };
      case 'GET_BANKS':
        return { ok: true, banks: {} };
      case 'SCAN_ALL_FRAMES':
        // 单帧页面，永远扫不到东西 —— 这样才能逼出「该不该去点章节测验标签」
        return { ok: true, count: 0, questions: [], context: null, signature: 'stub' };
      case 'CAPTURE':
        window.__captures++;
        // 记下实际提交了多少题，测试要拿它对数
        window.__capturedQuestions =
          (window.__capturedQuestions || 0) + ((msg.payload && msg.payload.questions || []).length);
        return { ok: true, added: (msg.payload && msg.payload.questions || []).length, updated: 0, total: 1 };
      case 'TOAST':
      case 'OPEN_PRACTICE':
      case 'DIAGNOSE':
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: function (msg, cb) {
        window.__sent.push((msg && msg.type) || '?');
        var res = respond(msg);
        // content.js 是按回调风格调的，必须异步回，否则执行顺序和真实环境不一样
        if (typeof cb === 'function') setTimeout(function () { cb(res); }, 0);
        return Promise.resolve(res);
      },
      onMessage: {
        addListener: function () { /* 测试里不需要收后台消息 */ }
      }
    },
    storage: {
      local: {
        get: function (key, cb) {
          var out = {};
          if (key === 'settings' || (Array.isArray(key) && key.indexOf('settings') >= 0)) {
            out.settings = SETTINGS;
          }
          if (typeof cb === 'function') setTimeout(function () { cb(out); }, 0);
          return Promise.resolve(out);
        },
        set: function () { return Promise.resolve(); }
      }
    }
  };
})();
