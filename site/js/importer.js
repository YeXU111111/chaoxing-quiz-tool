/*!
 * importer.js —— 题库导入
 *
 * 支持的输入：
 *   1. 本工具导出的 JSON（schema = chaoxing-quiz/v1）
 *   2. 裸 JSON 数组 / 单个 bank 对象（手动整理的、从别处来的都行）
 *   3. 纯文本题库（每行一题，格式宽松）—— 用于同事之间用微信发题库的场景
 *   4. 扩展页面里直接从 chrome.storage 拉取（不经过文件）
 *
 * 文本格式约定（尽量宽松，识别不出来就跳过那一行并计数）：
 *
 *   1、HTTP 协议默认端口是？|A.80|B.443|C.8080|D.3306|答案:A
 *   2、判断题：TCP 是面向连接的。|A.对|B.错|答案:A
 *   3、填空题：OSI 共___层。|答案:7
 *
 * 也支持多行块格式（题面与选项分行，题与题之间空行分隔）：
 *
 *   1、题干...
 *   A.选项一
 *   B.选项二
 *   答案：B
 */
(function (global) {
  'use strict';

  var CQB = global.CQB;
  var LETTERS = CQB.LETTERS;

  /* ------------------------------------------------------------------ *
   * JSON
   * ------------------------------------------------------------------ */

  function parseJSON(text) {
    var data = JSON.parse(text);
    return normalizeAny(data);
  }

  /** 把任意形态的 JSON 归一成 { banks: [...] } */
  function normalizeAny(data) {
    if (!data) throw new Error('内容为空');

    // 本工具的标准导出格式
    if (data.schema && Array.isArray(data.banks)) {
      if (data.schema !== CQB.SCHEMA) {
        console.warn('[CQB] schema 版本不一致：' + data.schema + '，当前 ' + CQB.SCHEMA + '，将尽力兼容');
      }
      return { banks: data.banks, warnings: data.schema !== CQB.SCHEMA ? ['题库 schema 版本为 ' + data.schema + '，已按当前版本尽力解析'] : [] };
    }

    // 裸数组
    if (Array.isArray(data)) {
      // 是题目数组还是题库数组？
      if (data.length && (data[0].questions || data[0].banks)) {
        return { banks: data.map(toBank), warnings: [] };
      }
      return { banks: [toBank({ id: 'bank::imported', workTitle: '导入题库', questions: data })], warnings: [] };
    }

    // 单个题库 / 单条题目
    if (data.questions) return { banks: [toBank(data)], warnings: [] };
    if (data.stem) return { banks: [toBank({ id: 'bank::imported', workTitle: '导入题库', questions: [data] })], warnings: [] };

    throw new Error('无法识别的 JSON 结构');
  }

  function toBank(b) {
    var id = b.id || [b.courseId || 'imported', b.workId || CQB.hash64(b.workTitle || 'bank')].join('::');
    return Object.assign({}, b, {
      id: id,
      workTitle: b.workTitle || b.courseName || '导入题库',
      questions: (b.questions || []).map(function (q) {
        return CQB.normalizeQuestion(q, { sourceUrl: b.sourceUrl, chapter: b.chapter });
      })
    });
  }

  /* ------------------------------------------------------------------ *
   * 纯文本
   * ------------------------------------------------------------------ */

  function parseText(text) {
    var lines = text.split(/\r?\n/);
    var blocks = [];
    var buf = [];

    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) {
        if (buf.length) { blocks.push(buf); buf = []; }
        return;
      }
      // 新的题号开头 → 切块
      if (/^\d+\s*[、.．,，)）]/.test(t) && buf.length && looksLikeQuestionStart(t)) {
        blocks.push(buf);
        buf = [];
      }
      buf.push(t);
    });
    if (buf.length) blocks.push(buf);

    var questions = [];
    var skipped = 0;

    blocks.forEach(function (b, i) {
      var q = parseBlock(b, i + 1);
      if (q) questions.push(q); else skipped++;
    });

    /*
     * 题库 id 由内容决定，不能用写死的常量。
     *
     * 原来固定是 'bank::text-import'，于是所有文本导入全都并进同一套题库 ——
     * 想按学科分开都没有粒度可分（归类是按题库走的）。
     *
     * 改成题干指纹之后：
     *   · 同一批文本重复导入 → id 相同 → 合并，不会产生重复题库（保持幂等）
     *   · 不同批次的文本 → id 不同 → 各自成库，可以分别归类
     */
    var fingerprint = questions.map(function (q) { return q.stem; }).join('|');
    var firstStem = (questions[0] && questions[0].stem) || '';

    return {
      banks: [toBank({
        id: 'bank::text::' + CQB.hash64(fingerprint),
        // 标题带上第一题的影子，归类列表里才分得清哪套是哪套
        workTitle: firstStem ? ('文本导入 · ' + firstStem.slice(0, 18)) : '文本导入题库',
        questions: questions
      })],
      warnings: skipped ? ['有 ' + skipped + ' 个文本块无法识别，已跳过'] : []
    };
  }

  function looksLikeQuestionStart(t) {
    // 「数字、+ 内容包含问号/选项标记」才算新题，避免把「1、2、3 都是质数」这种选项行误判
    return /[?？]|[（(]\s*[)）]|_{2,}|答案|A\s*[.、．]/.test(t);
  }

  function parseBlock(lines, index) {
    var joined = lines.join(' ');
    var stem = '';
    var options = [];
    var answerRaw = '';

    // 1) 单行竖线格式
    if (joined.indexOf('|') >= 0) {
      var parts = joined.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
      parts.forEach(function (p, i) {
        var mAns = p.match(/^(?:参考)?答案\s*[:：]\s*(.+)$/);
        if (mAns) { answerRaw = mAns[1].trim(); return; }
        var mOpt = p.match(/^([A-HＡ-Ｈa-h])\s*[.、．,，)）:：]\s*(.+)$/);
        if (mOpt) {
          options.push({ key: mOpt[1].toUpperCase(), text: mOpt[2].trim() });
          return;
        }
        if (i === 0) stem = p.replace(/^\d+\s*[、.．,，)）]\s*/, '');
        else stem += (stem ? ' ' : '') + p;
      });
    } else {
      // 2) 多行块格式
      lines.forEach(function (line) {
        var mAns = line.match(/^(?:参考)?答案\s*[:：]\s*(.+)$/);
        if (mAns) { answerRaw = mAns[1].trim(); return; }

        var mAna = line.match(/^(?:解析|答案解析|分析)\s*[:：]\s*(.+)$/);
        if (mAna) { return; } // 解析这里先不解析，保持简单

        var mOpt = line.match(/^([A-HＡ-Ｈa-h])\s*[.、．,，)）:：]\s*(.+)$/);
        if (mOpt && !/^[TF]$/i.test(mOpt[1])) {
          options.push({ key: mOpt[1].toUpperCase(), text: mOpt[2].trim() });
          return;
        }
        stem += (stem ? '\n' : '') + line;
      });
      stem = stem.replace(/^\d+\s*[、.．,，)）]\s*/, '').trim();
    }

    if (!stem) return null;

    var type = guessType(stem, options);

    // 判断题没写选项时，自动补上 A.对 / B.错
    if (type === 'judge' && !options.length) {
      options = [{ key: 'A', text: '对' }, { key: 'B', text: '错' }];
    }

    var q = CQB.normalizeQuestion({
      index: index,
      stem: stem,
      type: type,
      options: options,
      answerRaw: answerRaw
    }, { index: index });

    return q;
  }

  function guessType(stem, options) {
    var head = stem.slice(0, 30);
    if (/多选/.test(head)) return 'multiple';
    if (/判断/.test(head)) return 'judge';
    if (/填空/.test(head)) return 'fill';
    if (/简答|论述|名词解释|case|案例分析/i.test(head)) return 'short';
    if (options.length) {
      // 两个选项且内容是对/错 → 判断题
      if (options.length === 2 &&
          /^(对|错|正确|错误|是|否|√|×|T|F)$/i.test(options[0].text) &&
          /^(对|错|正确|错误|是|否|√|×|T|F)$/i.test(options[1].text)) return 'judge';
      return 'single';
    }
    if (/_{2,}|（\s*）|\(\s*\)/.test(stem)) return 'fill';
    return 'other';
  }

  /* ------------------------------------------------------------------ *
   * 入口
   * ------------------------------------------------------------------ */

  /**
   * 解析一段文本（自动判断 JSON 还是纯文本）。
   * 返回 { banks, warnings }，抛错时由调用方展示。
   */
  function parse(text) {
    var t = String(text || '').trim();
    if (!t) throw new Error('内容为空');
    if (t[0] === '{' || t[0] === '[') {
      try { return parseJSON(t); }
      catch (e) {
        // JSON 解析失败时退回文本解析，比直接报错友好
        var r = parseText(t);
        r.warnings = (r.warnings || []).concat(['JSON 解析失败（' + e.message + '），已按纯文本格式尝试解析']);
        return r;
      }
    }
    return parseText(t);
  }

  global.CQBImporter = {
    parse: parse,
    parseJSON: parseJSON,
    parseText: parseText,
    normalizeAny: normalizeAny,
    guessType: guessType
  };
})(window);
