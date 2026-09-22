/*!
 * core.js —— 题库数据格式规范与纯函数工具
 *
 * 这一份代码是「唯一真理来源」(single source of truth)：
 * 扩展的 content script、扩展的 service worker、刷题站三处都依赖同一套字段语义。
 * 修改字段必须同步改扩展里的 content/extractor.js，以及 README 的数据格式章节。
 *
 * 挂载到 window.CQB
 */
(function (global) {
  'use strict';

  /** 数据格式版本号。字段发生破坏性变更时 +1，导入器据此做迁移。 */
  var SCHEMA = 'chaoxing-quiz/v1';

  /** 题型枚举 → 中文名 */
  var TYPE_LABEL = {
    single: '单选题',
    multiple: '多选题',
    judge: '判断题',
    fill: '填空题',
    short: '简答题',
    other: '其他'
  };

  /** 题型排序权重（用于界面里按题型分组时的展示顺序） */
  var TYPE_ORDER = ['single', 'multiple', 'judge', 'fill', 'short', 'other'];

  var LETTERS = 'ABCDEFGHIJKLMNOP'.split('');

  /* ------------------------------------------------------------------ *
   * 字符串与哈希
   * ------------------------------------------------------------------ */

  /**
   * 归一化题干文本，用于生成稳定 ID 和做去重比对。
   * 去掉空白、全角空格、题号前缀、以及超星题干里常见的零宽字符。
   */
  function normalizeText(s) {
    if (!s) return '';
    return String(s)
      .replace(/[\u200b-\u200f\ufeff]/g, '')       // 零宽字符
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, '')
      .replace(/^\d+[、.．,，)）]\s*/, '')          // 开头的「1、」
      .trim();
  }

  /** 32 位 FNV-1a，同步、无依赖，足够做本地去重键 */
  function fnv1a(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * 64 位哈希（两个不同种子的 FNV 拼接）。
   * 刻意不用 crypto.subtle.digest：那是异步的，会让同步渲染路径变得很啰嗦，
   * 而本地题库量级（几千题）用 64 位碰撞概率可以忽略。
   */
  function hash64(str) {
    var a = fnv1a(str, 0x811c9dc5);
    var b = fnv1a(str, 0x9e3779b9);
    return ('00000000' + a.toString(16)).slice(-8) +
           ('00000000' + b.toString(16)).slice(-8);
  }

  /**
   * 生成题目稳定 ID。
   * 关键点：ID 不能依赖题目在卷子里的序号 —— 超星作业经常一页一题、分页加载，
   * 序号在不同次抓取里会漂移（尤其乱序出题时）。所以用「课程 + 题干 + 题型」做键。
   */
  function makeQuestionId(q) {
    return 'q_' + hash64([
      q.courseId || '',
      q.type || '',
      normalizeText(q.stem)
    ].join('|'));
  }

  /* ------------------------------------------------------------------ *
   * 选项 / 答案的规范化
   * ------------------------------------------------------------------ */

  /**
   * 把各种形态的答案统一成 { keys: string[], text: string[] }。
   * - "A"          → { keys: ['A'], text: [] }
   * - "ABD"        → { keys: ['A','B','D'], text: [] }
   * - "A、B"       → 同上
   * - "对" / "正确"  → { keys: ['对'], text: [] }  —— 判断题由调用方按选项文本映射成 A/B
   * - "第一空：foo 第二空：bar" → { keys: [], text: ['foo','bar'] }
   */
  function normalizeAnswer(raw, type) {
    var out = { keys: [], text: [] };
    if (raw == null) return out;

    if (Array.isArray(raw)) {
      raw.forEach(function (item) {
        var sub = normalizeAnswer(item, type);
        out.keys = out.keys.concat(sub.keys);
        out.text = out.text.concat(sub.text);
      });
      return dedupe(out);
    }

    var s = String(raw).trim();
    if (!s) return out;

    if (type === 'fill' || type === 'short') {
      out.text = splitFillAnswer(s);
      return out;
    }

    // 判断题：把「对/错/正确/错误/√/×/T/F」统一成统一词表，
    // 后面 mapJudgeToOptionKey 会再映射到实际选项键。
    var judgeWord = pickJudgeWord(s);
    if (judgeWord) {
      out.keys = [judgeWord];
      return out;
    }

    // 选择/多选题：抽出所有 A-H 字母
    var letters = s.toUpperCase().match(/[A-H]/g);
    if (letters && letters.length) {
      out.keys = dedupeKeys(letters);
      // 顺带保留原文，填空题以外的题型里 text 一般用不到，但导出时留着方便人工核对
      if (!/^[A-H\s、,，;；]+$/.test(s.toUpperCase())) out.text = [s];
      return out;
    }

    // 兜底：既不是字母也不是判断词，当文本答案处理
    out.text = [s];
    return out;
  }

  function pickJudgeWord(s) {
    var t = s.replace(/\s/g, '');
    if (/^(对|正确|√|✓|T|TRUE|是)$/i.test(t)) return '对';
    if (/^(错|错误|×|✗|X|F|FALSE|否)$/i.test(t)) return '错';
    return '';
  }

  /**
   * 拆填空题答案。
   * 超星导出的形态有好几种：
   *   "第一空：alpha 第二空：beta"
   *   "alpha；beta"
   *   "alpha;;beta"
   *   只有一空时就是纯文本
   */
  function splitFillAnswer(s) {
    var t = String(s).trim();
    // 形态一：带「第N空」标记
    if (/第\s*[一二三四五六七八九十\d]+\s*空/.test(t)) {
      var parts = t.split(/第\s*[一二三四五六七八九十\d]+\s*空\s*[：:]\s*/);
      return parts.map(function (p) { return p.trim(); }).filter(Boolean);
    }
    // 形态二：分号 / 双分号分隔
    var bySemi = t.split(/\s*;;\s*|\s*；\s*|\s*;\s*/).map(function (p) { return p.trim(); }).filter(Boolean);
    if (bySemi.length > 1) return bySemi;
    return [t];
  }

  function dedupeKeys(keys) {
    var seen = {}, out = [];
    keys.forEach(function (k) {
      k = String(k).toUpperCase();
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out.sort();
  }

  function dedupe(o) {
    o.keys = dedupeKeys(o.keys);
    var seen = {}, t = [];
    o.text.forEach(function (x) {
      var k = normalizeText(x);
      if (!seen[k]) { seen[k] = 1; t.push(x); }
    });
    o.text = t;
    return o;
  }

  /**
   * 判断题答案 → 选项键。
   * 超星的判断题选项一般是 A.对 / B.错，但有些课程写成 A.正确 / B.错误，
   * 甚至颠倒顺序。所以不能硬编码 A=对，必须拿选项文本去比对。
   */
  function mapJudgeToOptionKey(answerWord, options) {
    if (!answerWord || !options || !options.length) return [];
    var want = pickJudgeWord(answerWord) || answerWord;
    for (var i = 0; i < options.length; i++) {
      var optWord = pickJudgeWord(options[i].text);
      if (optWord && optWord === want) return [options[i].key];
    }
    // 选项文本认不出来（可能是「T/F」以外的奇怪写法），退回位置约定
    var idx = want === '对' ? 0 : 1;
    return options[idx] ? [options[idx].key] : [];
  }

  /* ------------------------------------------------------------------ *
   * 题目校验 / 清洗
   * ------------------------------------------------------------------ */

  /**
   * 把裸对象规范成合法 Question。导入外部 JSON 时也要过这一遍，
   * 免得刷题站被畸形数据搞崩。
   */
  function normalizeQuestion(raw, ctx) {
    ctx = ctx || {};
    var q = {
      id: raw.id || '',
      type: TYPE_LABEL[raw.type] ? raw.type : 'other',
      index: Number(raw.index) || 0,
      stem: String(raw.stem == null ? '' : raw.stem).trim(),
      stemHtml: String(raw.stemHtml || ''),
      options: [],
      answer: { keys: [], text: [] },
      answerRaw: String(raw.answerRaw || ''),
      analysis: String(raw.analysis || ''),
      score: raw.score == null || raw.score === '' ? null : Number(raw.score),
      hasAnswer: !!raw.hasAnswer,
      chapter: String(raw.chapter || ctx.chapter || ''),
      courseId: String(raw.courseId || ctx.courseId || ''),
      courseName: String(raw.courseName || ctx.courseName || ''),
      workId: String(raw.workId || ctx.workId || ''),
      workTitle: String(raw.workTitle || ctx.workTitle || ''),
      sourceUrl: String(raw.sourceUrl || ctx.sourceUrl || ''),
      origin: String(raw.origin || (ctx.sourceUrl ? getOrigin(ctx.sourceUrl) : '')),
      capturedAt: raw.capturedAt || ctx.capturedAt || new Date().toISOString()
    };

    if (Array.isArray(raw.options)) {
      q.options = raw.options.map(function (o, i) {
        if (typeof o === 'string') {
          return { key: LETTERS[i] || String(i + 1), text: o, html: '' };
        }
        return {
          key: String(o.key || LETTERS[i] || String(i + 1)).toUpperCase(),
          text: String(o.text == null ? '' : o.text).trim(),
          html: String(o.html || ''),
          correct: !!o.correct
        };
      });
    }

    // answer 可能是已经规范好的对象，也可能是裸字符串
    if (raw.answer && typeof raw.answer === 'object' && !Array.isArray(raw.answer)) {
      q.answer = {
        keys: dedupeKeys(raw.answer.keys || []),
        text: (raw.answer.text || []).map(String)
      };
    } else {
      q.answer = normalizeAnswer(raw.answerRaw || raw.answer, q.type);
    }

    // 判断题补映射：把「对/错」翻成真实选项键
    if (q.type === 'judge' && q.answer.keys.length && q.options.length) {
      var word = q.answer.keys[0];
      if (word === '对' || word === '错') {
        var mapped = mapJudgeToOptionKey(word, q.options);
        if (mapped.length) q.answer.keys = mapped;
      }
    }

    // 有选项却没有答案键时，若选项自带 correct 标记则补上（部分院校页面这么标）
    if (!q.answer.keys.length && !q.answer.text.length && q.options.some(function (o) { return o.correct; })) {
      q.answer.keys = q.options.filter(function (o) { return o.correct; }).map(function (o) { return o.key; });
    }

    if (!q.hasAnswer && (q.answer.keys.length || q.answer.text.length)) q.hasAnswer = true;
    if (!q.id) q.id = makeQuestionId(q);
    if (!q.index) q.index = ctx.index || 0;

    return q;
  }

  function getOrigin(url) {
    try { return new URL(url).origin; } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------------ *
   * 题库（Bank）操作
   * ------------------------------------------------------------------ */

  /** 题目「信息量」评分，用于同 ID 撞车时决定保留哪一份 */
  function richness(q) {
    var n = 0;
    if (q.hasAnswer) n += 100;
    if (q.answer.keys.length || q.answer.text.length) n += 50;
    if (q.analysis) n += 20;
    if (q.options.length) n += 5;
    if (q.stemHtml) n += 2;
    n += Math.min(q.stem.length, 200) / 200;
    return n;
  }

  /**
   * 合并单题。同 ID 时保留信息量更大的那份，但把缺失的字段补齐 ——
   * 典型场景：第一次抓取时答案还没公布，第二次（老师放答案后）抓到了，要覆盖。
   */
  function mergeQuestion(oldQ, newQ) {
    if (!oldQ) return newQ;
    if (!newQ) return oldQ;
    var win = richness(newQ) >= richness(oldQ) ? newQ : oldQ;
    var lose = win === newQ ? oldQ : newQ;
    var merged = Object.assign({}, lose, win);
    // 补齐空字段
    if (!merged.analysis && lose.analysis) merged.analysis = lose.analysis;
    if (!merged.stemHtml && lose.stemHtml) merged.stemHtml = lose.stemHtml;
    if ((!merged.options || !merged.options.length) && lose.options && lose.options.length) merged.options = lose.options;
    if (!merged.chapter && lose.chapter) merged.chapter = lose.chapter;
    if (!merged.workTitle && lose.workTitle) merged.workTitle = lose.workTitle;
    return merged;
  }

  /** 题干指纹，用于 ID 之外的二次去重 */
  function stemKey(q) {
    return hash64(normalizeText(q.stem));
  }

  /** 内容签名：用来判断一次合并到底有没有带来新信息 */
  function contentSig(q) {
    return [
      q.type, normalizeText(q.stem), q.answerRaw,
      (q.answer.keys || []).join(''), (q.answer.text || []).join('|'),
      q.analysis, q.options.length, q.chapter
    ].join('\u0001');
  }

  /**
   * 把一批题目合并进题库。
   * bankId 由「课程 + 作业/考试」决定，所以分页抓取会自然累积到同一个题库。
   *
   * 去重做了两道保险：
   *   1. 题目 ID（课程 + 题型 + 题干哈希）
   *   2. 题干指纹 —— 防的是「同一次作业的不同抓取批次里，有一批 payload 没带
   *      courseId」这种情况。没有这道保险，ID 会漂移，题库里就会出现重复题。
   *      真实场景：content script 从 iframe 上报时上下文不完整。
   */
  function mergeIntoBank(banks, payload) {
    if (!banks || typeof banks !== 'object') banks = {};
    var bankId = payload.bankId;
    if (!bankId) throw new Error('payload.bankId 必填');

    var bank = banks[bankId] || {
      id: bankId,
      courseId: payload.courseId || '',
      courseName: payload.courseName || '',
      workId: payload.workId || '',
      workTitle: payload.workTitle || '',
      kind: payload.kind || 'work',
      createdAt: new Date().toISOString(),
      updatedAt: '',
      questions: []
    };

    // 元数据总是用最新的（老师可能改了作业标题）
    ['courseName', 'workTitle', 'kind'].forEach(function (k) {
      if (payload[k]) bank[k] = payload[k];
    });

    // 题库自身的 course/work 作为兜底上下文。
    // 这样即使某次 payload 缺字段，同一题库里的题目 ID 也是稳定的。
    var ctx = Object.assign({}, payload, {
      courseId: payload.courseId || bank.courseId || '',
      workId: payload.workId || bank.workId || '',
      courseName: payload.courseName || bank.courseName || '',
      workTitle: payload.workTitle || bank.workTitle || ''
    });

    var indexById = {};
    var indexByStem = {};
    bank.questions.forEach(function (q) {
      indexById[q.id] = q;
      indexByStem[stemKey(q)] = q;
    });

    var added = 0, updated = 0;
    (payload.questions || []).forEach(function (rawQ) {
      var q = normalizeQuestion(rawQ, ctx);
      if (!q.stem) return;                       // 空题干直接丢，多半是解析噪音

      var sk = stemKey(q);
      var hit = indexById[q.id] || indexByStem[sk];

      if (hit) {
        var before = contentSig(hit);
        var merged = mergeQuestion(hit, q);
        merged.id = hit.id;                      // 保留原 ID，否则练习进度会失联
        if (merged.id !== q.id) delete indexById[q.id];
        indexById[merged.id] = merged;
        indexByStem[sk] = merged;
        if (contentSig(merged) !== before) updated++;
      } else {
        indexById[q.id] = q;
        indexByStem[sk] = q;
        added++;
      }
    });

    bank.questions = Object.keys(indexById).map(function (k) { return indexById[k]; });
    bank.questions.sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
    bank.updatedAt = new Date().toISOString();
    banks[bankId] = bank;

    return { banks: banks, added: added, updated: updated, total: bank.questions.length };
  }

  /**
   * 读盘后的兜底清理：按 ID + 题干指纹双重去重。
   * 老版本存下来的数据可能已经带了重复题，这里顺手清掉，
   * 顺带修好那些 ID 漂移的历史条目。
   */
  function dedupeBanks(banks) {
    var out = {};
    Object.keys(banks || {}).forEach(function (k) {
      var b = banks[k];
      var seenId = {}, seenStem = {}, kept = [];
      (b.questions || []).forEach(function (q) {
        var sk = stemKey(q);
        if (seenId[q.id]) {
          // 同 ID：保留信息量大的那份
          var i = kept.findIndex(function (x) { return x.id === q.id; });
          if (i >= 0) { kept[i] = mergeQuestion(kept[i], q); return; }
        }
        if (seenStem[sk]) return;   // 题干重复但 ID 不同 → 丢掉后来者
        seenId[q.id] = 1;
        seenStem[sk] = 1;
        kept.push(q);
      });
      b.questions = kept;
      out[k] = b;
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 判分
   * ------------------------------------------------------------------ */

  /**
   * 判分。返回 { correct, needManual, expected, got }。
   * 选择题：集合相等才算对（多选少选都算错，和超星一致）。
   * 判断题：同上，但 key 已经映射过了。
   * 填空题/简答题：去空白后不区分大小写比对；关键词匹配策略留待后续按课程开关。
   */
  function grade(question, userAnswer) {
    var expected = question.answer || { keys: [], text: [] };
    var got = userAnswer || { keys: [], text: [] };

    if (!expected.keys.length && !expected.text.length) {
      return { correct: false, needManual: false, expected: expected, got: got, ungraded: true };
    }

    if (question.type === 'fill' || question.type === 'short') {
      var exp = (expected.text || []).map(cmpKey);
      var act = (got.text || []).map(cmpKey);
      if (!exp.length) return { correct: false, needManual: false, expected: expected, got: got, ungraded: true };
      var ok = exp.length === act.length && exp.every(function (e, i) { return e === act[i]; });
      return { correct: ok, expected: expected, got: got, partial: partialFill(exp, act) };
    }

    var e1 = dedupeKeys(expected.keys || []).join('');
    var a1 = dedupeKeys(got.keys || []).join('');
    return { correct: e1 !== '' && e1 === a1, expected: expected, got: got };
  }

  function cmpKey(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  }

  function partialFill(exp, act) {
    var hit = 0;
    exp.forEach(function (e, i) { if (e && e === act[i]) hit++; });
    return exp.length ? hit / exp.length : 0;
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  function buildExport(banks) {
    var arr = Object.keys(banks || {}).map(function (k) { return banks[k]; });
    var total = arr.reduce(function (n, b) { return n + b.questions.length; }, 0);
    return {
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      generator: 'chaoxing-quiz-tool',
      stats: { banks: arr.length, questions: total },
      banks: arr
    };
  }

  /* ================================================================== *
   * 学科分类
   *
   * 一个人可能同时在上好几门课，全都堆在一起根本没法练。
   * 分类的原始依据是题库自带的 courseName，但超星的课程名往往长得没法看
   * （「2024-2025-1-高等数学(上)-0001」这种），所以还得能改名。
   *
   * 改名不写在题库上，而是记一张 courseId → 学科名 的映射表：
   * 这样下次从同一门课抓来的题会自动归到同一个学科，不用再改一遍。
   * ================================================================== */

  var UNCLASSIFIED = '未分类';

  /**
   * 学科映射的键。
   *
   * 优先用 courseId —— 同一门课会不断抓来新题库，用 courseId 才能自动归位。
   * 抓不到 courseId 时退回题库自己的 id，否则这些题库永远改不了名
   * （映射表里没有它们的键）。
   */
  function subjectKeyOf(bank) {
    if (!bank) return '';
    return String(bank.courseId || '').trim() || String(bank.id || '').trim();
  }

  /** 某个题库属于哪个学科 */
  function subjectNameOf(bank, subjectMap) {
    if (!bank) return UNCLASSIFIED;

    var key = subjectKeyOf(bank);
    var explicit = key ? (subjectMap || {})[key] : '';
    if (explicit) return String(explicit).trim();

    var auto = String(bank.courseName || '').trim();
    return auto || UNCLASSIFIED;
  }

  /**
   * 按学科把题库归组。
   *
   * 按「名字」而不是键归组 —— 同一门课可能有多个 courseId
   * （高数上 / 高数下），用户把它们改成同一个名字之后就该合成一组。
   */
  function groupBySubject(banks, subjectMap) {
    var groups = {};

    Object.keys(banks || {}).forEach(function (id) {
      var b = banks[id];
      if (!b) return;
      var name = subjectNameOf(b, subjectMap);

      if (!groups[name]) {
        groups[name] = { name: name, bankIds: [], keys: [], courseIds: [], questions: 0 };
      }
      var g = groups[name];
      g.bankIds.push(id);

      var key = subjectKeyOf(b);
      if (key && g.keys.indexOf(key) < 0) g.keys.push(key);
      if (b.courseId && g.courseIds.indexOf(b.courseId) < 0) g.courseIds.push(b.courseId);

      g.questions += (b.questions || []).length;
    });

    return Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) {
        // 「未分类」永远垫底，其余的按题量从多到少
        if (a.name === UNCLASSIFIED) return 1;
        if (b.name === UNCLASSIFIED) return -1;
        return (b.questions - a.questions) || a.name.localeCompare(b.name, 'zh');
      });
  }

  /**
   * 把一组题库改名到某个学科。
   * 只管「键 → 名字」的映射，不动题库本身。
   */
  function renameSubject(subjectMap, group, newName) {
    var map = Object.assign({}, subjectMap || {});
    var name = String(newName == null ? '' : newName).trim();

    (group && group.keys || []).forEach(function (k) {
      if (name) map[k] = name;
      else delete map[k];
    });

    return map;
  }

  global.CQB = {
    SCHEMA: SCHEMA,
    TYPE_LABEL: TYPE_LABEL,
    TYPE_ORDER: TYPE_ORDER,
    LETTERS: LETTERS,
    UNCLASSIFIED: UNCLASSIFIED,
    subjectKeyOf: subjectKeyOf,
    subjectNameOf: subjectNameOf,
    groupBySubject: groupBySubject,
    renameSubject: renameSubject,
    normalizeText: normalizeText,
    hash64: hash64,
    makeQuestionId: makeQuestionId,
    normalizeAnswer: normalizeAnswer,
    mapJudgeToOptionKey: mapJudgeToOptionKey,
    normalizeQuestion: normalizeQuestion,
    mergeQuestion: mergeQuestion,
    mergeIntoBank: mergeIntoBank,
    dedupeBanks: dedupeBanks,
    grade: grade,
    buildExport: buildExport,
    getOrigin: getOrigin,
    dedupeKeys: dedupeKeys
  };
})(typeof window !== 'undefined' ? window : self);
