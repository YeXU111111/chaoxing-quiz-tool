/*!
 * engine.js —— 练习会话引擎
 *
 * 只负责「题目序列 + 筛选 + 判分 + 状态推进」，不碰 DOM。
 * 这样 UI 层可以随便换，逻辑层测试起来也简单。
 *
 * 支持的模式：
 *   sequential  顺序练习（按题库原始题号）
 *   random      随机练习（Fisher-Yates，一次会话内固定序列）
 *   recite      背题模式（不判分，直接展示答案，只看不答）
 *   wrong       错题复习（只筛错题本）
 *   starred     收藏复习（只筛收藏）
 */
(function (global) {
  'use strict';

  var CQB = global.CQB;

  function Session(bank, questions, options) {
    options = options || {};
    this.bank = bank;
    this.mode = options.mode || 'sequential';
    this.questions = questions || [];
    this.cursor = 0;
    this.answers = {};        // questionId -> { keys, text }
    this.results = {};        // questionId -> grade() 的返回值
    this.revealed = {};       // questionId -> true 表示已点开过答案
    this.progress = options.progress || {};
  }

  /* ------------------------------------------------------------------ *
   * 题目池筛选
   * ------------------------------------------------------------------ */

  /**
   * 从一个或多个题库里抽出题目池。
   * filter 支持：
   *   { bankIds: [], chapter: '', types: [], subjects: [],
   *     subjectMap: {}, status: 'all'|'undone'|'wrong'|'starred' }
   *
   * progress 必须由调用方传进来。
   * 不要在这里回读 storage —— store 的写入有 150ms 防抖，
   * 刚答完题立刻按「错题」筛选会读到还没落盘的旧数据，
   * 表现就是「答错了但错题本是空的」。
   */
  Session.buildPool = function (banks, filter, progress) {
    filter = filter || {};
    var pool = [];

    var bankIds = filter.bankIds && filter.bankIds.length
      ? filter.bankIds
      : Object.keys(banks || {});

    bankIds.forEach(function (id) {
      var b = banks[id];
      if (!b) return;
      (b.questions || []).forEach(function (q) {
        pool.push({
          q: q,
          bankId: id,
          bankTitle: b.workTitle || b.courseName || id,
          courseName: b.courseName || '',
          subject: global.CQB.subjectNameOf(b, filter.subjectMap),
          chapter: q.chapter || ''
        });
      });
    });

    // 学科筛选。传名字数组而不是 id —— 用户是按「高等数学」这个概念选的，
    // 同一门课可能有多个 courseId
    if (filter.subjects && filter.subjects.length) {
      var subjSet = {};
      filter.subjects.forEach(function (s) { subjSet[s] = 1; });
      pool = pool.filter(function (it) { return subjSet[it.subject]; });
    }

    if (filter.chapter) {
      pool = pool.filter(function (it) { return it.chapter === filter.chapter; });
    }
    if (filter.types && filter.types.length) {
      var typeSet = {};
      filter.types.forEach(function (t) { typeSet[t] = 1; });
      pool = pool.filter(function (it) { return typeSet[it.q.type]; });
    }
    if (filter.onlyWithAnswer) {
      pool = pool.filter(function (it) { return it.q.hasAnswer; });
    }

    // 状态筛选依赖 progress。调用方没传才回退到 storage（仅用于脚本化调用场景）
    if (!progress) progress = global.CQBStore.loadProgress();
    var status = filter.status || 'all';
    if (status !== 'all') {
      pool = pool.filter(function (it) {
        var p = progress[it.q.id] || {};
        if (status === 'undone') return !p.attempts;
        if (status === 'wrong') return !!p.wrongBooked;
        if (status === 'starred') return !!p.starred;
        if (status === 'done') return !!p.attempts;
        return true;
      });
    }

    return pool;
  };

  Session.prototype.load = function (pool, mode) {
    if (mode) this.mode = mode;
    var qs = pool.slice();
    if (this.mode === 'random') shuffle(qs);
    this.questions = qs;
    this.cursor = 0;
    return this;
  };

  Session.prototype.current = function () {
    return this.questions[this.cursor] || null;
  };

  Session.prototype.currentQuestion = function () {
    var it = this.current();
    return it ? it.q : null;
  };

  Session.prototype.count = function () { return this.questions.length; };
  Session.prototype.isFirst = function () { return this.cursor === 0; };
  Session.prototype.isLast = function () { return this.cursor >= this.questions.length - 1; };

  Session.prototype.next = function () {
    if (this.isLast()) return false;
    this.cursor++;
    return true;
  };
  Session.prototype.prev = function () {
    if (this.isFirst()) return false;
    this.cursor--;
    return true;
  };
  Session.prototype.goto = function (i) {
    if (i < 0 || i >= this.questions.length) return false;
    this.cursor = i;
    return true;
  };

  /** 定位到某个 questionId（从题号网格跳题时用） */
  Session.prototype.indexOfId = function (qid) {
    for (var i = 0; i < this.questions.length; i++) {
      if (this.questions[i].q.id === qid) return i;
    }
    return -1;
  };

  /* ------------------------------------------------------------------ *
   * 作答 / 判分
   * ------------------------------------------------------------------ */

  /** 暂存答案（还没提交），存到 this.answers 里，切题不丢 */
  Session.prototype.setAnswer = function (qid, answer) {
    this.answers[qid] = answer;
  };

  Session.prototype.getAnswer = function (qid) {
    return this.answers[qid] || { keys: [], text: [] };
  };

  /**
   * 提交当前题。返回 grade 结果 + 进度条目。
   * 幂等：已经提交过的题再提交会重新判分（允许改答案重做）。
   */
  Session.prototype.submit = function (qid) {
    var q = this._find(qid);
    if (!q) return null;
    var userAnswer = this.getAnswer(qid);
    var res = CQB.grade(q.q, userAnswer);
    this.results[qid] = res;

    // 未公布答案的题不计入进度，否则错题本会被一堆「没法判」的题污染
    if (res.ungraded) {
      res.progress = this.progress[qid] || null;
      return res;
    }

    var p = global.CQBStore.recordAnswer(this.progress, qid, res.correct, userAnswer);
    if (res.correct && !global.CQBStore.loadSettings().keepWrongAfterCorrect) {
      p.wrongBooked = false;
      global.CQBStore.saveProgress(this.progress);
    }
    res.progress = p;
    return res;
  };

  Session.prototype._find = function (qid) {
    for (var i = 0; i < this.questions.length; i++) {
      if (this.questions[i].q.id === qid) return this.questions[i];
    }
    return null;
  };

  Session.prototype.result = function (qid) { return this.results[qid] || null; };
  Session.prototype.isSubmitted = function (qid) { return !!this.results[qid]; };

  Session.prototype.reveal = function (qid) { this.revealed[qid] = true; };
  Session.prototype.isRevealed = function (qid) { return !!this.revealed[qid] || this.mode === 'recite'; };

  /* ------------------------------------------------------------------ *
   * 统计
   * ------------------------------------------------------------------ */

  Session.prototype.stats = function () {
    var done = 0, correct = 0, wrong = 0, ungraded = 0;
    var self = this;
    this.questions.forEach(function (it) {
      var r = self.results[it.q.id];
      if (!r) return;
      if (r.ungraded) { ungraded++; return; }
      done++;
      if (r.correct) correct++; else wrong++;
    });
    return {
      total: this.questions.length,
      done: done,
      correct: correct,
      wrong: wrong,
      ungraded: ungraded,
      accuracy: done ? Math.round(correct / done * 100) : 0,
      position: this.cursor + 1
    };
  };

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * 打乱选项。必须同时重写答案键，否则判分会错。
   * 返回新题目对象，不改原题。
   */
  Session.shuffleOptions = function (question) {
    var q = JSON.parse(JSON.stringify(question));
    var idx = q.options.map(function (o, i) { return i; });
    shuffle(idx);
    var newOpts = idx.map(function (origI, newI) {
      return Object.assign({}, q.options[origI], { key: CQB.LETTERS[newI] });
    });
    var keyMap = {};
    idx.forEach(function (origI, newI) {
      keyMap[q.options[origI].key] = CQB.LETTERS[newI];
    });
    q.options = newOpts;
    q.answer = {
      keys: (q.answer.keys || []).map(function (k) { return keyMap[k] || k; }).sort(),
      text: q.answer.text || []
    };
    return q;
  };

  global.CQBSession = Session;
})(window);
