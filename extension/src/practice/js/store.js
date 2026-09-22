/*!
 * store.js —— 存储适配层
 *
 * 两套运行环境共用同一个刷题站：
 *
 *   A) 作为扩展内置页面打开（chrome-extension://<id>/src/practice/index.html）
 *      → 题库从 chrome.storage.local 读，与 content script 实时共享，无需导入导出。
 *   B) 作为独立网站打开（http(s):// 或 file://）
 *      → 题库从 localStorage 读，靠用户在扩展里「导出 JSON」再导入。
 *
 * 进度数据（做过没有、错题、收藏）永远放 localStorage：
 * 它是「这个人的练习记录」，跟题库来源无关，也不需要跨设备同步。
 */
(function (global) {
  'use strict';

  var BANKS_KEY = 'banks';
  var SUBJECTS_KEY = 'subjects';
  var LS_BANKS_KEY = 'cqb:banks';
  var LS_SUBJECTS_KEY = 'cqb:subjects';
  var LS_PROGRESS_KEY = 'cqb:progress';
  var LS_SETTINGS_KEY = 'cqb:settings';

  /** 是否跑在扩展页面里 */
  var IN_EXTENSION = typeof chrome !== 'undefined' &&
    !!chrome.storage && !!chrome.storage.local &&
    String(location.protocol).indexOf('chrome-extension') === 0;

  /* ---------------------------- 题库 ---------------------------- */

  function loadBanks() {
    if (IN_EXTENSION) {
      return chrome.storage.local.get(BANKS_KEY).then(function (res) {
        return global.CQB.dedupeBanks(res[BANKS_KEY] || {});
      });
    }
    try {
      var raw = localStorage.getItem(LS_BANKS_KEY);
      return Promise.resolve(global.CQB.dedupeBanks(raw ? JSON.parse(raw) : {}));
    } catch (e) {
      console.warn('[CQB] 题库解析失败，已重置', e);
      return Promise.resolve({});
    }
  }

  function saveBanks(banks) {
    if (IN_EXTENSION) {
      var o = {}; o[BANKS_KEY] = banks;
      return chrome.storage.local.set(o);
    }
    localStorage.setItem(LS_BANKS_KEY, JSON.stringify(banks));
    return Promise.resolve();
  }

  /**
   * 合并一批题库进存储。扩展页面和独立站都走这条路径，
   * 保证「导入 JSON」和「扩展实时抓取」产生的结果完全一致。
   */
  function importBankPayload(payload, banks) {
    banks = banks || {};
    var list = payload && payload.banks ? payload.banks
             : (Array.isArray(payload) ? payload : [payload]);
    // bankIds 要报回去：导入时如果用户指定了学科，得知道该给哪些题库打标记
    var report = { banks: 0, added: 0, updated: 0, bankIds: [] };

    list.forEach(function (b) {
      if (!b || !Array.isArray(b.questions)) return;
      var bankId = b.id || [b.courseId || 'unknown', b.workId || 'default'].join('::');
      var r = global.CQB.mergeIntoBank(banks, Object.assign({}, b, { bankId: bankId }));
      banks = r.banks;
      report.banks++;
      report.added += r.added;
      report.updated += r.updated;
      if (report.bankIds.indexOf(bankId) < 0) report.bankIds.push(bankId);
    });

    return saveBanks(banks).then(function () {
      return { banks: banks, report: report };
    });
  }

  function clearBanks() {
    if (IN_EXTENSION) {
      var o = {}; o[BANKS_KEY] = {};
      return chrome.storage.local.set(o);
    }
    localStorage.removeItem(LS_BANKS_KEY);
    return Promise.resolve();
  }

  /** 学科映射也要能被监听 —— 在另一个标签页改完名字，这边得跟着刷新 */
  function onSubjectsChanged(cb) {
    if (IN_EXTENSION && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes[SUBJECTS_KEY]) {
          cb(changes[SUBJECTS_KEY].newValue || {});
        }
      });
    }
    if (!IN_EXTENSION && global.addEventListener) {
      global.addEventListener('storage', function (e) {
        if (e.key === LS_SUBJECTS_KEY) {
          try { cb(JSON.parse(e.newValue || '{}')); } catch (err) {}
        }
      });
    }
  }

  /* ---------------------------- 学科 ---------------------------- */

  /**
   * 学科数据是一张 `courseId → 学科名` 的映射表。
   *
   * 不把学科名写进题库本身，是因为同一门课会不断抓来新题库，
   * 映射表能让新抓到的自动归位，不用每来一次就改一次名。
   */
  function loadSubjects() {
    if (IN_EXTENSION) {
      return chrome.storage.local.get(SUBJECTS_KEY).then(function (res) {
        var m = res[SUBJECTS_KEY];
        return (m && typeof m === 'object') ? m : {};
      });
    }
    try {
      var raw = localStorage.getItem(LS_SUBJECTS_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return Promise.resolve(parsed && typeof parsed === 'object' ? parsed : {});
    } catch (e) {
      return Promise.resolve({});
    }
  }

  function saveSubjects(map) {
    if (IN_EXTENSION) {
      var o = {}; o[SUBJECTS_KEY] = map;
      return chrome.storage.local.set(o);
    }
    localStorage.setItem(LS_SUBJECTS_KEY, JSON.stringify(map));
    return Promise.resolve();
  }

  /**
   * 给一组题库（通常是一个学科下的全部题库）改名。
   * @param {object} group   CQB.groupBySubject() 产生的一组
   * @param {string} newName 新名字；传空字符串表示恢复自动识别
   */
  function renameSubject(group, newName) {
    return loadSubjects().then(function (map) {
      var next = global.CQB.renameSubject(map, group, newName);
      return saveSubjects(next).then(function () { return next; });
    });
  }

  /** 库变化时自动刷新界面（扩展页面才有事件，独立站靠手动刷新） */
  function onBanksChanged(cb) {
    if (IN_EXTENSION && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes[BANKS_KEY]) {
          cb(global.CQB.dedupeBanks(changes[BANKS_KEY].newValue || {}));
        }
      });
    }
    // 独立站：监听同源其他标签页的写入
    if (!IN_EXTENSION && global.addEventListener) {
      global.addEventListener('storage', function (e) {
        if (e.key === LS_BANKS_KEY) cb(JSON.parse(e.newValue || '{}'));
      });
    }
  }

  /* ---------------------------- 进度 ---------------------------- */

  /**
   * progress 结构：
   * {
   *   "<questionId>": {
   *     attempts: 3,          // 作答次数
   *     wrong: 2,             // 答错次数
   *     lastCorrect: false,
   *     starred: true,        // 手动收藏
   *     wrongBooked: true,    // 是否在错题本里（答对一次后自动移出，可手动保留）
   *     lastAnswer: { keys: [], text: [] },
   *     updatedAt: "..."
   *   }
   * }
   */
  function loadProgress() {
    try {
      return JSON.parse(localStorage.getItem(LS_PROGRESS_KEY) || '{}');
    } catch (e) { return {}; }
  }

  var saveTimer = null;
  function saveProgress(progress) {
    // 写 localStorage 是同步的，答题时每题都写会卡；
    // 用 150ms 防抖合并写入。
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(LS_PROGRESS_KEY, JSON.stringify(progress)); } catch (e) {
        console.warn('[CQB] 进度写入失败（可能超出配额）', e);
      }
    }, 150);
  }

  function recordAnswer(progress, questionId, isCorrect, userAnswer) {
    var p = progress[questionId] || {
      attempts: 0, wrong: 0, lastCorrect: null, starred: false, wrongBooked: false
    };
    p.attempts += 1;
    if (!isCorrect) {
      p.wrong += 1;
      p.wrongBooked = true;          // 答错自动进错题本
    } else if (p.wrongBooked) {
      p.wrongBooked = false;         // 答对自动移出（可在设置里关掉这个行为）
    }
    p.lastCorrect = !!isCorrect;
    p.lastAnswer = userAnswer || null;
    p.updatedAt = new Date().toISOString();
    progress[questionId] = p;
    saveProgress(progress);
    return p;
  }

  function toggleStar(progress, questionId) {
    var p = progress[questionId] || { attempts: 0, wrong: 0, starred: false, wrongBooked: false };
    p.starred = !p.starred;
    progress[questionId] = p;
    saveProgress(progress);
    return p;
  }

  function resetProgress() {
    localStorage.removeItem(LS_PROGRESS_KEY);
  }

  /* ---------------------------- 设置 ---------------------------- */

  var DEFAULT_SETTINGS = {
    theme: 'light',
    shuffleOptions: false,   // 打乱选项顺序（注意：会连带打乱答案键）
    autoNext: false,         // 答对后自动跳下一题
    showAnswerImmediately: true,
    keepWrongAfterCorrect: false
  };

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_SETTINGS_KEY) || '{}'));
    } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }

  function saveSettings(s) {
    localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(s));
  }

  global.CQBStore = {
    IN_EXTENSION: IN_EXTENSION,
    loadBanks: loadBanks,
    saveBanks: saveBanks,
    importBankPayload: importBankPayload,
    clearBanks: clearBanks,
    onBanksChanged: onBanksChanged,
    loadSubjects: loadSubjects,
    saveSubjects: saveSubjects,
    renameSubject: renameSubject,
    onSubjectsChanged: onSubjectsChanged,
    loadProgress: loadProgress,
    saveProgress: saveProgress,
    recordAnswer: recordAnswer,
    toggleStar: toggleStar,
    resetProgress: resetProgress,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };
})(window);
