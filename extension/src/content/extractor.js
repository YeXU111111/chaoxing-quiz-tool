/*!
 * extractor.js —— 超星页面题目解析器
 *
 * 【这个文件是整个扩展最容易烂掉的地方】
 * 超星的页面结构没有稳定契约，同一份作业在教学点、不同学期、不同院校模板下
 * DOM 都可能不一样。所以这里的原则是：
 *
 *   1. 每类信息都给一组候选选择器，命中第一个非空即用；
 *   2. 选择器全落空时退回「按文本特征猜」；
 *   3. 答案来源按可信度排序：结构化接口数据 > 明确的答案 DOM > 选项上的对错类名 > 文本正则。
 *
 * 如果哪天抓不到了，多半是超星改版。改这里的 SELECTORS 就行，不要动 content.js。
 */
(function (global) {
  'use strict';

  var CQB = global.CQB;

  /* ================================================================== *
   * 选择器表
   * ================================================================== */

  var SEL = {
    // 单题容器。按优先级排列，第一个能匹配到内容的胜出。
    block: [
      '.TiMu',                    // 作业 / 考试主用（多年未变）
      '.questionLi',              // 部分新版考试页
      '.queDetail',
      '.exam-question',
      '.mark_item',
      '.singleQuesId',
      '[data-questionid]'
    ],

    // 题型标签所在位置
    typeLabel: [
      '.Zy_TItle .fl.letter',
      '.fl.letter',
      '.mark_name',
      '.questionType',
      '.type-name'
    ],

    // 题干主体
    stem: [
      '.Zy_TItle .clearfix',
      '.Zy_TItle',
      '.stem_answer',
      '.mark_name',
      '.question-title'
    ],

    // 选项列表
    optionList: [
      '.Zy_ulTop li',
      '.Zy_ulBottom li',
      'ul.answerList li',
      '.answerList li',
      '.queOptions li',
      '.optionList li',
      '.Zy_ulTop .clearfix li'
    ],

    // 答案 / 解析区域
    answerBox: [
      '.Py_answer',
      '.mark_answer',
      '.rightAnswer',
      '.answerCon',
      '.answer',
      '.referenceAnswer',
      '.Py_analysis',
      '.analysis',
      '.jiexi'
    ],

    // 需要从题干里剔除的噪音
    noise: [
      '.Zy_ulTop', '.Zy_ulBottom', 'ul', 'ol', '.Py_answer', '.mark_answer',
      '.analysis', '.Py_analysis', '.answer', 'script', 'style', '.zy_ico',
      'button', '.fr'
    ]
  };

  /* ================================================================== *
   * 页面上下文
   * ================================================================== */

  /**
   * 从 URL 和 DOM 里提取「这页是什么作业」。
   * 这个对象决定了题目会被合并进哪个题库 —— 分页抓取能累积，全靠它稳定。
   */
  function getContext() {
    var p = new URLSearchParams(location.search);
    var hashQ = '';
    var hashMatch = String(location.hash || '').match(/\?(.+)$/);
    if (hashMatch) hashQ = hashMatch[1];
    var hp = new URLSearchParams(hashQ);

    function pick() {
      for (var i = 0; i < arguments.length; i++) {
        var key = arguments[i];
        var v = p.get(key) || hp.get(key);
        if (v) return v;
      }
      return '';
    }

    var courseId = pick('courseId', 'courseid');
    var workId = pick('workId', 'workid', 'examId', 'examid', 'jobid', 'taskId');
    var classId = pick('classId', 'clazzid', 'classid');
    var kind = /exam|test/i.test(location.pathname + location.search) ? 'exam' : 'work';

    // 课程名 / 作业名：DOM 里找，找不到退回 document.title
    var courseName = textOf('.courseName, .course-name, #courseName, .prev_course, h1.course') ||
                     textOf('.zt_header .name, .head_name');
    var workTitle = textOf('#workTitle, .workTitle, .mark_title, .examTitle, h1.title, .work_name, .zyTitle') ||
                     document.title.replace(/[-|_].*$/, '').trim();

    var chapter = getChapter();

    return {
      courseId: courseId,
      courseName: cleanText(courseName),
      workId: workId,
      workTitle: cleanText(workTitle),
      classId: classId,
      kind: kind,
      chapter: chapter,
      sourceUrl: location.href,
      pageUrl: location.href,
      capturedAt: new Date().toISOString()
    };
  }

  /** 章节名：URL 里没有，就从面包屑 / 目录高亮项里挖 */
  function getChapter() {
    var candidates = [
      '.chapterTitle', '.prev', '.crumb', '.breadcrumb',
      '.posCatalog_select .active', '.catalog_active', '.zt_header .section',
      '.chapter_name', '.chapter-item.active', '#chapterTitle'
    ];
    for (var i = 0; i < candidates.length; i++) {
      var el = document.querySelector(candidates[i]);
      if (!el) continue;
      var t = cleanText(el.textContent);
      if (t && t.length < 60) return t;
    }
    // 有些页面把章节挂在 window 上的配置里
    try {
      var cfg = global.chapterName || global.chapterTitle;
      if (cfg && typeof cfg === 'string') return cleanText(cfg);
    } catch (e) {}
    return '';
  }

  /** 题库 ID：课程 + 作业 唯一确定一套题 */
  function bankIdOf(ctx) {
    return [ctx.courseId || 'nocourse', ctx.workId || ctx.workTitle || 'nowork'].join('::');
  }

  /* ================================================================== *
   * 主入口：扫全页
   * ================================================================== */

  /**
   * 扫描当前文档，返回 { questions, context, blocks }。
   * questions 已经过 CQB.normalizeQuestion。
   */
  function scanDocument() {
    var ctx = getContext();
    var blocks = findBlocks();
    var questions = [];
    var stats = { blocks: blocks.length, parsed: 0, withAnswer: 0, skipped: 0 };

    blocks.forEach(function (el, i) {
      var q;
      try {
        q = parseBlock(el, i + 1, ctx);
      } catch (e) {
        console.warn('[CQB] 第 ' + (i + 1) + ' 个题目块解析异常', e);
        q = null;
      }
      if (!q || !q.stem || q.stem.length < 2) { stats.skipped++; return; }
      questions.push(q);
      stats.parsed++;
      if (q.hasAnswer) stats.withAnswer++;
    });

    return { questions: questions, context: ctx, stats: stats, pageUrl: location.href };
  }

  function findBlocks() {
    for (var i = 0; i < SEL.block.length; i++) {
      var nodes = document.querySelectorAll(SEL.block[i]);
      if (nodes.length) {
        // 过滤掉相互嵌套的（比如 .mark_item 里套着 .TiMu），只留最内层
        var list = Array.prototype.slice.call(nodes);
        return list.filter(function (n) {
          return !list.some(function (m) { return m !== n && n.contains(m); });
        });
      }
    }
    return [];
  }

  /* ================================================================== *
   * 单题解析
   * ================================================================== */

  function parseBlock(el, index, ctx) {
    var blockText = cleanText(el.textContent);
    if (blockText.length < 3) return null;

    var type = detectType(el, blockText);
    var options = parseOptions(el);
    var stemInfo = parseStem(el);
    var answerInfo = parseAnswer(el, type, options);
    var analysis = parseAnalysis(el);
    var score = parseScore(el);

    // 判断题没解析出选项：自己补 A.对 / B.错，否则判分无从谈起
    if (type === 'judge' && !options.length) {
      // 先看看有没有藏在文本里的「对/错」
      var guess = /(?:A|A\s*[.、．])?\s*(对|正确)/.test(blockText);
      options = [{ key: 'A', text: '对' }, { key: 'B', text: '错' }];
      if (!guess) { /* 选项顺序猜不准，但 A=对 是超星默认约定 */ }
    }

    return CQB.normalizeQuestion({
      index: index,
      type: type,
      stem: stemInfo.text,
      stemHtml: stemInfo.html,
      options: options,
      answerRaw: answerInfo.raw,
      answer: answerInfo.answer,
      hasAnswer: answerInfo.hasAnswer,
      analysis: analysis,
      score: score
    }, ctx);
  }

  /* ---------------------------- 题型 ---------------------------- */

  function detectType(el, blockText) {
    // 1) 容器上的 data-type / class 提示
    var hints = [
      el.getAttribute('data-type'), el.getAttribute('data-questiontype'),
      el.className
    ].join(' ');
    var t = typeFromString(hints);
    if (t) return t;

    // 2) 题型标签元素
    for (var i = 0; i < SEL.typeLabel.length; i++) {
      var lab = el.querySelector(SEL.typeLabel[i]);
      if (lab) {
        t = typeFromString(lab.textContent);
        if (t) return t;
      }
    }

    // 3) 题干开头部分（超星常把题型写在题号后面：(单选题)）
    t = typeFromString(blockText.slice(0, 60));
    if (t) return t;

    // 4) 靠选项数量和内容推断
    var opts = el.querySelectorAll('input[type=radio]');
    var chks = el.querySelectorAll('input[type=checkbox]');
    if (chks.length) return 'multiple';
    if (opts.length === 2) {
      var texts = Array.prototype.map.call(opts, function (i) {
        var lab = i.closest('label') || el.querySelector('label[for="' + i.id + '"]');
        return lab ? cleanText(lab.textContent) : '';
      }).join(' ');
      if (/对.*错|正确.*错误|√.*×|T.*F/i.test(texts)) return 'judge';
    }
    // 有 input[type=text] 基本就是填空
    if (el.querySelector('input[type=text], input:not([type]), textarea')) return 'fill';

    var optCount = el.querySelectorAll(SEL.optionList.join(',')).length;
    if (optCount >= 3) return 'single';
    if (optCount === 2) return 'judge';
    return 'other';
  }

  function typeFromString(s) {
    if (!s) return '';
    s = String(s);
    if (/多选|多项选择/.test(s)) return 'multiple';
    if (/判断/.test(s)) return 'judge';
    if (/填空/.test(s)) return 'fill';
    if (/简答|论述|名词解释|案例|计算题|问答/.test(s)) return 'short';
    if (/单选|单项选择|选择/.test(s)) return 'single';
    return '';
  }

  /* ---------------------------- 题干 ---------------------------- */

  function parseStem(el) {
    // 优先找明确的题干节点
    for (var i = 0; i < SEL.stem.length; i++) {
      var node = el.querySelector(SEL.stem[i]);
      if (!node) continue;
      var clone = node.cloneNode(true);
      {
        // 剔除选项、按钮、答案区，只留题干
        SEL.noise.forEach(function (sel) {
          clone.querySelectorAll(sel).forEach(function (n) { n.remove(); });
        });
        // 题型标签也去掉
        SEL.typeLabel.forEach(function (sel) {
          clone.querySelectorAll(sel).forEach(function (n) { n.remove(); });
        });
      }
      var html = clone.innerHTML;
      var text = cleanStemText(clone.textContent);
      if (text.length >= 2) return { text: text, html: html };
    }

    // 兜底：整个块去掉选项和答案区
    var clone2 = el.cloneNode(true);
    SEL.noise.forEach(function (sel) {
      clone2.querySelectorAll(sel).forEach(function (n) { n.remove(); });
    });
    return {
      text: cleanStemText(clone2.textContent),
      html: clone2.innerHTML
    };
  }

  function cleanStemText(s) {
    return cleanText(s)
      .replace(/^[（(【\[]?\s*(单选|多选|判断|填空|简答|论述|计算|名词解释)[题]?\s*[）)】\]]?\s*/i, '')
      .replace(/^\d+\s*[、.．,，)）]\s*/, '')
      .replace(/^[（(]\s*\d+(\.\d+)?\s*分\s*[）)]\s*/, '')
      .trim();
  }

  /* ---------------------------- 选项 ---------------------------- */

  function parseOptions(el) {
    var lis = el.querySelectorAll(SEL.optionList.join(','));
    // 选择器全落空时，退化到「找所有 li」，但要过滤掉明显不含选项的
    if (!lis.length) {
      lis = el.querySelectorAll('li');
    }

    var out = [];
    Array.prototype.forEach.call(lis, function (li) {
      if (li.querySelector('li')) return;            // 嵌套容器，不是选项本身
      var opt = parseOptionLi(li);
      if (opt) out.push(opt);
    });

    // 去重（同一 li 可能被多个选择器选中）+ 重排键
    var seen = {};
    out = out.filter(function (o) {
      var k = CQB.normalizeText(o.text);
      if (!k || seen[k]) return false;
      seen[k] = 1;
      return true;
    });

    // 键缺失或重复时按位置补 A、B、C…
    out.forEach(function (o, i) {
      if (!o.key) o.key = CQB.LETTERS[i] || String(i + 1);
    });

    var keySeen = {};
    out.forEach(function (o, i) {
      if (keySeen[o.key]) o.key = CQB.LETTERS[i] || String(i + 1);
      keySeen[o.key] = 1;
    });

    return out;
  }

  function parseOptionLi(li) {
    // 全程只在副本上操作。原始 DOM 一个字节都不能改 ——
    // 否则用户会发现页面上的「A」「B」被我们删掉了。
    var clone = li.cloneNode(true);

    // 键：优先从明确的字母标记元素取
    var key = '';
    var keySelector = '.check_answer, .fl.check_answer, .opt-key, .num, i.fl, i';
    var keyEl = clone.querySelector(keySelector);
    if (keyEl) {
      var kt = cleanText(keyEl.textContent);
      if (/^[A-Ha-h]$/.test(kt)) key = kt.toUpperCase();
      else keyEl = null;
    }

    // 正确性标记：超星用 .dui（对）/.cuo（错）；有些页面用 .right/.correct/.cur
    // 原始 li 和字母标记元素两处都要看
    var optCls = [(li.className || '')];
    if (keyEl && li.querySelector(keySelector)) {
      optCls.push(li.querySelector(keySelector).className || '');
    }
    var correct = /(^|\s)(dui|right|correct|true|cur)(\s|$)/.test(optCls.join(' '));

    // 副本里去掉字母标记，剩下的才是选项正文
    if (keyEl) keyEl.remove();
    clone.querySelectorAll('.check_answer').forEach(function (n) { n.remove(); });

    var text = cleanText(clone.textContent);
    // 文本里可能还带「A、」前缀
    var m = text.match(/^([A-Ha-h])\s*[、.．,，)）:：]\s*([\s\S]+)$/);
    if (m) {
      if (!key) key = m[1].toUpperCase();
      text = m[2];
    }

    // 去掉尾部混进来的「我的答案 / 正确答案」等
    text = text.replace(/(我的答案|正确答案|参考答案)\s*[:：][\s\S]*$/, '').trim();

    if (!text && !key) return null;

    var html = clone.innerHTML.replace(/^\s*<i[^>]*>\s*[A-Ha-h]\s*<\/i>\s*/i, '').trim();

    return { key: key, text: text, html: html, correct: correct };
  }

  /* ---------------------------- 答案 ---------------------------- */

  /**
   * 答案提取，按可信度从高到低尝试。
   * 返回 { raw, answer, hasAnswer }。
   */
  function parseAnswer(el, type, options) {
    var collected = [];

    // ---- 来源 0：页面里挂的结构化数据（有则最准）----
    var structured = readStructuredAnswer(el);
    if (structured) collected.push(structured);

    // ---- 来源 1：答案区域的文本 ----
    SEL.answerBox.forEach(function (sel) {
      el.querySelectorAll(sel).forEach(function (n) {
        var t = cleanText(n.textContent);
        if (t) collected.push(t);
      });
    });

    // ---- 来源 2：选项上的对错类名 ----
    var marked = options.filter(function (o) { return o.correct; }).map(function (o) { return o.key; });
    if (marked.length) collected.push('正确答案：' + marked.join(''));

    var raw = '';
    for (var i = 0; i < collected.length; i++) {
      var parsed = extractAnswerFromText(collected[i], type, options);
      if (parsed) { raw = parsed; break; }
    }

    if (!raw) {
      // 没找到答案，但选项上有正确标记的也算
      if (marked.length) {
        return { raw: marked.join(''), answer: { keys: marked.sort(), text: [] }, hasAnswer: true };
      }
      return { raw: '', answer: { keys: [], text: [] }, hasAnswer: false };
    }

    var answer = CQB.normalizeAnswer(raw, type);
    return {
      raw: raw,
      answer: answer,
      hasAnswer: !!(answer.keys.length || answer.text.length)
    };
  }

  /**
   * 从一段文本里捞出答案。
   * 覆盖的写法：
   *   正确答案：A         参考答案：ABD
   *   正确答案：A、B       正确答案：对
   *   我的答案：C  正确答案：A        ← 只取「正确」那个
   *   正确答案：第一空：foo 第二空：bar
   */
  function extractAnswerFromText(text, type, options) {
    if (!text) return '';
    var t = String(text).replace(/\s+/g, ' ').trim();

    // 优先找「正确答案 / 参考答案」
    var m = t.match(/(?:正确答案|参考答案|标准答案|答案)\s*[:：]\s*([^；;]*?)(?=\s*(?:我的答案|正确答案|参考答案|答案解析|解析|$))/);
    if (m) {
      var v = m[1].trim();
      // 形如「A（2分）」的，把分数切掉
      v = v.replace(/[（(]\s*\d+(\.\d+)?\s*分\s*[）)]\s*$/, '').trim();
      if (v) return v;
    }

    // 只有「我的答案」的话，说明答案没公布，不能拿来当标准答案
    if (/我的答案\s*[:：]/.test(t) && !/正确答案|参考答案/.test(t)) return '';

    // 整段就是个答案（来源 2 那种合成串已被上面处理）
    if (/^[A-H]{1,8}$/.test(t)) return t;
    if (/^[对错正确误√×TF]{1,2}$/i.test(t)) return t;
    if (type === 'fill' && /第\s*[一二三四五六七八九十\d]+\s*空/.test(t)) return t;

    return '';
  }

  /** 尝试读页面上挂的 JSON 答案数据 */
  function readStructuredAnswer(el) {
    // 元素自身属性
    var attrs = ['data-answer', 'data-rightanswer', 'answer', 'data-correct'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v) return String(v);
    }
    return '';
  }

  /* ---------------------------- 解析 ---------------------------- */

  function parseAnalysis(el) {
    var sels = ['.Py_analysis', '.analysis', '.jiexi', '.answerAnalysis', '.analysisContent'];
    for (var i = 0; i < sels.length; i++) {
      var n = el.querySelector(sels[i]);
      if (n) {
        var clone = n.cloneNode(true);
        clone.querySelectorAll('script,style').forEach(function (x) { x.remove(); });
        var t = cleanText(clone.textContent)
          .replace(/^(答案解析|解析|分析)\s*[:：]\s*/, '');
        if (t) return t;
      }
    }
    // 解析有时被塞在答案框里，用正则从整块文本里抠
    var whole = cleanText(el.textContent);
    var m = whole.match(/(?:答案解析|解析)\s*[:：]\s*([\s\S]{4,600})$/);
    return m ? m[1].trim() : '';
  }

  function parseScore(el) {
    var t = cleanText(el.textContent).slice(0, 400);
    var m = t.match(/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/);
    return m ? Number(m[1]) : null;
  }

  /* ================================================================== *
   * 工具
   * ================================================================== */

  function cleanText(s) {
    return String(s == null ? '' : s)
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function textOf(sel) {
    var el = document.querySelector(sel);
    return el ? cleanText(el.textContent) : '';
  }

  /* ================================================================== *
   * 自动翻页
   * ================================================================== */

  /** 翻页任务的运行状态。同一时间只允许一个任务，方便中止。 */
  var PAGING = { running: false, abort: false };

  /**
   * 翻页循环的决策核心 —— 纯函数，不碰 DOM，方便单测。
   *
   * ★ 这里刻意 **不含**「这一页没有新题就停」这条规则。
   *   那是上一版的错误写法：超星的分页作业里有「没有题目的说明页」，
   *   而且下一页渲染慢一点就会扫到旧内容而误判成没新题，
   *   结果就是翻两页就"自动暂停"。
   *
   *   真正的结束信号只有三个，都是可靠的：
   *     1. 「下一题」按钮消失或变灰 —— 这是最准的
   *     2. 点了按钮但页面内容纹丝不动（连续 N 次）—— 按钮变成摆设了
   *     3. 撞到页数上限（兜底，防死循环）
   *
   * @param {object} s {aborted, page, maxPages, hasNext, stalls, maxStalls}
   * @returns {{action: 'continue'|'stop', reason: string}}
   */
  function pagingDecision(s) {
    if (s.aborted) return { action: 'stop', code: 'aborted', reason: '已手动停止' };
    if (!s.hasNext) {
      return { action: 'stop', code: 'done', reason: '页面已没有「下一题」按钮，说明已到最后一题' };
    }
    if (s.page >= s.maxPages) {
      return {
        action: 'stop', code: 'maxpages',
        reason: '已达到页数上限 ' + s.maxPages + ' 页，可能还有剩余题目'
      };
    }
    if (s.stalls >= s.maxStalls) {
      return {
        action: 'stop', code: 'stall',
        reason: '连续 ' + s.stalls + ' 次点击「下一题」后页面内容都没有变化，判定已到最后一题'
      };
    }
    return { action: 'continue', code: '', reason: '' };
  }

  /**
   * 页面内容指纹。
   *
   * 用途是回答一个问题：「我点了下一题，页面到底换没换？」
   * 不能只看题干 —— 翻到说明页时题干是空的，看题干会误判成"没换"。
   * 所以优先取题目块的文本，没有题目块时退化成整个 body 的文本，
   * 再加上分页指示器和 iframe 的 src（iframe 被整块换掉也是一种页面变化）。
   */
  function frameSignature() {
    var parts = [];
    var blocks = document.querySelectorAll(SEL.block.join(','));
    if (blocks.length) {
      Array.prototype.forEach.call(blocks, function (b) {
        parts.push(cleanText(b.textContent));
      });
    } else {
      // 没有题目块（说明页 / 加载中），用整页文本兜底
      var root = document.body ? document.body.cloneNode(true) : null;
      if (root) {
        root.querySelectorAll('script,style,noscript,template').forEach(function (n) { n.remove(); });
        parts.push(cleanText(root.textContent).slice(0, 20000));
      }
    }

    var ind = document.querySelector('#pageInfo, .pageInfo, .tiIndex, .currentNum, .pageNum, .questionIndex');
    parts.push(ind ? cleanText(ind.textContent) : '');

    var iframes = '';
    document.querySelectorAll('iframe').forEach(function (f) {
      iframes += (f.getAttribute('src') || '') + '|';
    });
    parts.push(iframes);

    return CQB.hash64(parts.join('\u0001'));
  }

  /** 取一次快照：本地指纹 + 可选的跨帧指纹 */
  async function takeSnapshot(cfg) {
    var local = frameSignature();
    var remote = '';
    if (cfg.remoteSignature) {
      try { remote = (await cfg.remoteSignature()) || ''; } catch (e) { remote = ''; }
    }
    return { local: local, remote: remote, sig: local + '#' + remote };
  }

  /**
   * 等页面「换完并且稳定下来」。
   *
   * 这是「抓不全」的另一个根源。上一版用固定 900ms 的 sleep，
   * 下一页要 1.5 秒才渲染完的话，扫描扫到的还是上一页的内容，
   * 于是被那条「没新题就停」的规则判了死刑。
   *
   * 但光等「内容变了」还不够 —— 超星翻页普遍是两段式：
   * 先清空容器（这时指纹已经变了），过一会儿才把新题填进去。
   * 在"变了"的瞬间就去扫描，扫到的是空页面。
   * 所以这里等的是「连续 stableMs 毫秒指纹都不再变化」，也就是渲染真的停了。
   *
   * @returns {{changed: boolean, aborted: boolean}}
   */
  /** 页面上有题目块吗 */
  function pageHasQuestions() {
    return document.querySelectorAll(SEL.block.join(',')).length > 0;
  }

  /** 页面上有没有正在转的加载遮罩 / 骨架屏 */
  var LOADING_SELECTORS = [
    '.loading', '.loadMask', '.maskLayer', '.loadImg', '.loadingBox',
    '#loading', '.spinner', '.loading-container', '.loading-mask', '.skeleton'
  ];
  function isLoading() {
    for (var i = 0; i < LOADING_SELECTORS.length; i++) {
      var el = document.querySelector(LOADING_SELECTORS[i]);
      if (el && isClickable(el)) return true;
    }
    return false;
  }

  /**
   * 「稳定多久才算渲染完」这件事，不能一刀切。
   *
   * 踩过的坑：超星翻页是两段式的 —— 先清空容器显示「加载中…」，
   * 一两秒后才把题填进去。那段"加载中"占位符本身是很稳定的，
   * 用固定的稳定窗口会在占位符阶段就判定"渲染完了"，扫到一张空页面。
   *
   * 所以：
   *   页面已经有题目块 → 只需要很短的时间确认没在变化（stableMs）
   *   页面还没有题目块 → 多等一会儿（emptyStableMs），给它填进来的机会
   *   页面上有加载遮罩   → 根本不算稳定，继续等
   */
  function requiredStableMs(cfg) {
    if (isLoading()) return Infinity;
    return pageHasQuestions() ? cfg.stableMs : cfg.emptyStableMs;
  }

  /** 等当前页面渲染稳定。已渲染完的页面大约 stableMs 后返回。 */
  async function waitInitialRender(cfg) {
    var lastSig = frameSignature();
    var stableSince = Date.now();
    var deadline = Date.now() + cfg.changeTimeout;

    while (Date.now() < deadline) {
      if (PAGING.abort) return;
      await sleep(cfg.pollMs);

      var sig = frameSignature();
      var need = requiredStableMs(cfg);

      if (sig !== lastSig) {
        lastSig = sig;
        stableSince = Date.now();
        continue;
      }
      if (need !== Infinity && Date.now() - stableSince >= need) return;
    }
  }

  async function waitForStableChange(before, cfg) {
    var deadline = Date.now() + cfg.changeTimeout;
    var changed = false;
    var lastSig = before.local;
    var stableSince = 0;
    var polls = 0;

    while (Date.now() < deadline) {
      if (PAGING.abort) return { changed: changed, aborted: true };
      await sleep(cfg.pollMs);
      polls++;

      var sig = frameSignature();

      if (sig !== before.local && !changed) {
        changed = true;
        lastSig = sig;
        stableSince = Date.now();
      } else if (changed) {
        if (sig !== lastSig) {
          lastSig = sig;
          stableSince = Date.now();     // 还在渲染，重置稳定计时
        } else {
          // 稳定窗口按「这页现在长什么样」动态取：
          // 已经有题目块 → 短窗口；还是「加载中」占位符 → 长窗口或继续等
          var need = requiredStableMs(cfg);
          if (need !== Infinity && Date.now() - stableSince >= need) {
            return { changed: true, aborted: false };
          }
        }
      }

      // 本地一直没变，每 4 次探一次其他 frame（题目可能整个在 iframe 里）
      if (!changed && cfg.remoteSignature && polls % 4 === 0) {
        try {
          var r = await cfg.remoteSignature();
          if (r && r !== before.remote) {
            changed = true;
            lastSig = '';
            stableSince = Date.now();
          }
        } catch (e) { /* 跨帧探测失败不致命，继续等本地 */ }
      }
    }

    return { changed: changed, aborted: false };
  }

  /**
   * 「整卷翻页抓取」的主循环。
   *
   * 一路点到没有下一题为止，中途遇到空白页、慢页面都不会停。
   * 用 opts.scanAll / opts.remoteSignature 注入跨帧能力（Node 环境里不传就是纯本地扫描）。
   *
   * @returns {{questions, context, pages, endedReason, aborted}}
   */
  async function autoPage(onBatch, opts) {
    if (PAGING.running) throw new Error('已经有一个翻页任务在跑了');

    opts = opts || {};
    var cfg = {
      maxPages: opts.maxPages || 300,
      changeTimeout: opts.changeTimeout || 8000,   // 单次翻页最长等多久（含渲染稳定）
      stableMs: opts.stableMs || 500,              // 已有题目块时，指纹稳定多久算渲染完
      emptyStableMs: opts.emptyStableMs || 2000,   // 还没题目块时多等一会儿，防止扫到加载占位符
      pollMs: opts.pollMs || 200,
      maxStalls: opts.maxStalls || 2,
      retryDelayMs: opts.retryDelayMs || 1500,     // stall 后再给一次机会等多久
      scanAll: opts.scanAll || null,
      remoteSignature: opts.remoteSignature || null,
      onProgress: opts.onProgress || function () {}
    };

    PAGING.running = true;
    PAGING.abort = false;

    var all = [];
    var seenStems = {};
    var ctx = getContext();
    var pages = 0;
    var stalls = 0;
    var endedReason = '';
    var endedCode = '';

    try {
      // 第一页也要等渲染稳定。否则用户刚点开作业就按抓取，
      // 拿到的是一张还没渲染完的空页面，后面翻页会把"这页没题"也算进去。
      await waitInitialRender(cfg);

      for (var p = 0; p < cfg.maxPages; p++) {
        if (PAGING.abort) { endedReason = '已手动停止'; endedCode = 'aborted'; break; }

        // ---------- 抓当前页 ----------
        var batch = await collectPage(cfg);
        pages++;

        // 逐字段补齐，不整体覆盖。
        // 场景：题目在 iframe 里时，顶层 URL 只有 courseId 没有 workId，
        // 而 workId 决定了题目会被归到哪个题库 —— 必须从 iframe 那边补上。
        if (batch.context) ctx = mergeContext(ctx, batch.context);

        var fresh = 0;
        batch.questions.forEach(function (q) {
          var k = CQB.hash64(q.stem);
          if (seenStems[k]) return;
          seenStems[k] = 1;
          all.push(q);
          fresh++;
        });

        cfg.onProgress({
          page: pages, found: batch.questions.length, fresh: fresh,
          total: all.length, stalls: stalls, url: location.href
        });
        if (onBatch && batch.questions.length) {
          onBatch({ questions: batch.questions, context: ctx, page: pages });
        }

        // ---------- 判断还能不能继续 ----------
        var nextBtn = findNextButton();
        var d1 = pagingDecision({
          aborted: PAGING.abort, page: pages, maxPages: cfg.maxPages,
          hasNext: !!nextBtn, stalls: stalls, maxStalls: cfg.maxStalls
        });
        if (d1.action === 'stop') { endedReason = d1.reason; endedCode = d1.code; break; }

        // ---------- 点下一题，等页面换完并稳定 ----------
        var before = await takeSnapshot(cfg);
        nextBtn.click();

        var wait = await waitForStableChange(before, cfg);
        if (wait.aborted) { endedReason = '已手动停止'; endedCode = 'aborted'; break; }

        if (wait.changed) {
          stalls = 0;
          continue;   // 页面已稳定，下一轮直接扫描
        }

        // 没变：可能是慢页面，也可能按钮已经失效
        stalls++;
        var d2 = pagingDecision({
          aborted: PAGING.abort, page: pages, maxPages: cfg.maxPages,
          hasNext: true, stalls: stalls, maxStalls: cfg.maxStalls
        });
        if (d2.action === 'stop') { endedReason = d2.reason; endedCode = d2.code; break; }

        // 还有一次机会：多等一会儿再说
        await sleep(cfg.retryDelayMs);
      }

      if (!endedReason) {
        var dEnd = pagingDecision({
          aborted: PAGING.abort, page: pages, maxPages: cfg.maxPages,
          hasNext: true, stalls: 0, maxStalls: cfg.maxStalls
        });
        endedReason = dEnd.reason || '未知原因结束';
        endedCode = dEnd.code || 'unknown';
      }

      return {
        questions: all,
        context: ctx,
        pages: pages,
        endedReason: endedReason,
        endedCode: endedCode,
        aborted: PAGING.abort
      };
    } finally {
      PAGING.running = false;
      PAGING.abort = false;
    }
  }

  /**
   * 合并两份上下文：已有的非空字段优先，空缺的由另一份补上。
   * 不做整体 Object.assign —— 否则一份空值会盖掉另一份的有效值。
   */
  var CONTEXT_FIELDS = ['courseId', 'courseName', 'workId', 'workTitle', 'kind', 'chapter', 'sourceUrl', 'pageUrl'];

  function mergeContext(a, b) {
    a = a || {}; b = b || {};
    var out = {};
    CONTEXT_FIELDS.forEach(function (k) { out[k] = a[k] || b[k] || ''; });
    out.capturedAt = b.capturedAt || a.capturedAt || new Date().toISOString();
    return out;
  }

  /** 抓当前页。注入了 scanAll 就走跨帧汇总，否则只扫本帧。 */
  async function collectPage(cfg) {
    if (cfg.scanAll) {
      var r = await cfg.scanAll();
      if (r) return { questions: r.questions || [], context: r.context || getContext() };
    }
    var res = scanDocument();
    return { questions: res.questions, context: res.context };
  }

  /** 中止正在跑的翻页任务 */
  function stopAutoPage() {
    if (!PAGING.running) return false;
    PAGING.abort = true;
    return true;
  }

  function isAutoPaging() { return PAGING.running; }

  /**
   * 找「下一题 / 下一页」按钮。
   * 多个候选，取第一个可见可点的。
   */
  function findNextButton() {
    var selectors = [
      '#prevNextFocusNext', '.prevNextFocusNext', '#nextQuestion', '.nextQuestion',
      'a.next', '.nextBtn', '.btnNext', '.btn-next', '#next', '.btn_next',
      '[title="下一题"]', '#pageNext', '.pagination .next', '.questionNext'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var els = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (isClickable(el) && !isDisabled(el)) return el;
      }
    }
    // 文本兜底：找写着「下一题」的可点元素
    var all = document.querySelectorAll('a, button, div[onclick], span[onclick], li[onclick]');
    for (var k = 0; k < all.length; k++) {
      var t = cleanText(all[k].textContent);
      if (/^(下一题|下一页|下页|继续|►|▶|>)$/.test(t) && isClickable(all[k]) && !isDisabled(all[k])) {
        return all[k];
      }
    }
    return null;
  }

  function isClickable(el) {
    if (!hasBox(el)) return false;
    var st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' &&
           st.pointerEvents !== 'none' && st.opacity !== '0';
  }

  /**
   * 按钮是否已经失效。
   * 「最后一题」时超星不一定会把按钮删掉 —— 更常见的是把它变灰：
   * 加 .disabled 类、置 aria-disabled、或者干脆把 cursor 设成 not-allowed。
   * 这三种都要认出来，否则会在最后一题上白点几次直到 stall 超时。
   */
  var DISABLED_CLASS = /(^|[\s_-])(disabled|disable|gray|grey|ban|noclick|forbid|unclickable)([\s_-]|$)/i;

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    if (el.getAttribute && el.getAttribute('disabled') != null) return true;

    // 自身和往上三层祖先都要看：超星常把状态加在 li / span 包装层上
    var n = el;
    for (var i = 0; i < 4 && n && n.classList; i++) {
      if (DISABLED_CLASS.test(n.className)) return true;
      n = n.parentElement;
    }

    var st = getComputedStyle(el);
    if (st.cursor === 'not-allowed') return true;
    if (st.pointerEvents === 'none') return true;

    // 变灰的按钮：文字颜色和边框都很淡
    if (st.color) {
      var m = st.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        var lum = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
        if (lum > 205) return true;   // 太淡，基本就是禁用态
      }
    }
    return false;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ================================================================== *
   * 页内标签识别（视频 / 章节测验 / 讨论 …）
   *
   * 超星的章节页把「章节测验」放在页内的标签栏里，不点开的话题目根本不会加载。
   * 这里负责把那个标签找出来。
   *
   * 最大的坑是别点错：页面左侧的目录树里也有「章节测验」条目，
   * 点中它就跳到别的章节去了。所以加了双重约束：
   *   1. 文案必须是「干净」的标签文案 —— 允许前面带序号，不能是「课程视频」这种带前缀的
   *   2. 必须和「视频」标签待在同一个标签栏容器里
   * ================================================================== */

  /** 生成严格的标签文案正则：允许「2」「2.」这样的序号前缀，以及「(3)」这种计数后缀 */
  function tabTextRe(words) {
    return new RegExp('^\\s*\\d*\\s*[.、]?\\s*(?:' + words + ')\\s*(?:\\(\\s*\\d+\\s*\\)|（\\s*\\d+\\s*）)?\\s*$');
  }

  var RE_TAB_VIDEO = tabTextRe('视频|课件|音频|文档|图书');
  var RE_TAB_QUIZ = tabTextRe('章节测验|本章测验|章节测试|本章测试|测验|测试|习题|练习|章节作业|课后作业|作业|章节练习');

  /**
   * 标签文案里的装饰字符。
   *
   * 超星很喜欢在按钮里塞箭头：「下一节 ›」「▶ 下一节」「下一节 >」。
   * 这些字符会让 `^下一节$` 这种严格匹配直接失效 ——
   * 用户看到的现象就是「有时候找不到下一节」。
   * 所以匹配之前先把它们剥掉。
   */
  var LABEL_DECOR = /[›»>→▸▶►◀◂«<←\u203a\u25b8\u25ba\u25c4\u2192\u2190\u00bb\u00ab]/g;

  function stripDecor(s) {
    return cleanText(String(s == null ? '' : s).replace(LABEL_DECOR, ' '));
  }

  function tabLabelOf(el) {
    var t = stripDecor(el.textContent);
    if (!t || t.length > 16) return '';
    return t;
  }

  /** 有些按钮的文字在 title / aria-label 上，元素里只有图标 */
  function attrLabelOf(el) {
    if (!el.getAttribute) return '';
    var v = el.getAttribute('title') || el.getAttribute('aria-label');
    if (!v) return '';
    var t = stripDecor(v);
    if (!t || t.length > 16) return '';
    return t;
  }

  /** 元素的综合文案：优先正文，没有再看 title / aria-label */
  function labelFor(el) {
    return tabLabelOf(el) || attrLabelOf(el);
  }

  /** 只要有盒子就算。用于「hover 才显示」的按钮 —— 它们有尺寸，只是被样式藏了 */
  function hasBox(el) {
    var r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  }

  function isActiveTab(el) {
    var n = el;
    for (var i = 0; i < 3 && n && n.classList; i++) {
      if (/(^|[\s_-])(active|cur|current|selected|checked|on)([\s_-]|$)/i.test(n.className)) return true;
      n = n.parentElement;
    }
    return false;
  }

  /**
   * 在 root 的子孙里找文案命中 re 的可点元素。
   * 只保留最内层 —— 否则 <li><a>章节测验</a></li> 里的 li 和 a 都会被选中。
   */
  /**
   * 在 root 的子孙里找文案命中 re 的可点元素。
   *
   * @param {object} [opts]
   *   opts.loose  true 时只要求「有盒子」，不检查可见性 ——
   *               给章节翻页按钮用。超星那对「上一节/下一节」经常是
   *               hover 才显示的（visibility/opacity 被样式压着），
   *               用严格的可见性检查会把它们全滤掉，表现就是「找不到下一节」。
   *               display:none 的照样会被盒尺寸挡掉，所以「已经是最后一节」仍然能识别。
   */
  function findClickableByText(root, re, opts) {
    opts = opts || {};
    if (!root || !root.querySelectorAll) return [];

    var check = opts.loose ? hasBox : isClickable;
    var out = [];

    var all = root.querySelectorAll(
      'a, button, li, span, div[onclick], [role="tab"], [title], [aria-label]'
    );

    Array.prototype.forEach.call(all, function (el) {
      if (!check(el)) return;

      var t = tabLabelOf(el);
      var a = attrLabelOf(el);
      if (!re.test(t) && !re.test(a)) return;

      // 只保留最内层：子元素也命中就说明自己不是
      var inner = el.querySelector('a, button, span');
      if (inner && (re.test(tabLabelOf(inner)) || re.test(attrLabelOf(inner)))) return;

      out.push(el);
    });
    return out;
  }

  /**
   * 两个元素是不是待在同一个「标签栏」里。
   *
   * 这是防止误点的关键。页面上到处都有「章节测验」字样 ——
   * 左侧目录树里每个章节都有一个。光靠「文案匹配」会点到别的章节去。
   *
   * 覆盖超星的两种结构：
   *   <div class="tabbar"><a>视频</a><a>章节测验</a></div>       ← 同一个父节点
   *   <ul><li><a>视频</a></li><li><a>章节测验</a></li></ul>       ← 父节点是兄弟
   */
  function sameTabBar(a, b) {
    var pa = a.parentElement;
    var pb = b.parentElement;
    if (!pa || !pb) return false;
    if (pa === pb) return true;
    if (pa.parentElement && pa.parentElement === pb.parentElement) return true;
    if (pb.parentElement === pa || pa.parentElement === pb) return true;
    return false;
  }

  /**
   * 找「章节测验」标签。
   *
   * @returns {{el, label, backTo, backLabel, distance}|null}
   *   el         要点开的元素
   *   backTo     用户原本待着的那个标签（抓完切回来用）
   *   distance   在 DOM 上往上找了几层，越小越可信
   */
  function findQuizTab() {
    var videoTabs = findClickableByText(document, RE_TAB_VIDEO);

    for (var i = 0; i < videoTabs.length; i++) {
      var videoTab = videoTabs[i];
      var bar = videoTab.parentElement;

      for (var up = 0; up < 3 && bar && bar !== document.body; up++) {
        var hits = findClickableByText(bar, RE_TAB_QUIZ);

        for (var j = 0; j < hits.length; j++) {
          var el = hits[j];
          if (el === videoTab) continue;
          if (isActiveTab(el)) continue;             // 已经是当前标签，点了没意义
          if (!sameTabBar(videoTab, el)) continue;   // ★ 必须是同一个标签栏里的兄弟

          return {
            el: el,
            distance: up,
            label: tabLabelOf(el),
            backTo: videoTab,
            backLabel: tabLabelOf(videoTab)
          };
        }

        bar = bar.parentElement;
      }
    }

    return null;
  }

  /* ================================================================== *
   * 小节导航
   * ================================================================== */

  // 严格匹配，避免把「下一章节的测验」这种长文案也算进来。
  // 注意匹配前已经剥掉箭头等装饰字符了。
  var RE_NEXT_SECTION = /^(下一节|下一小节|下节|下一讲|下一课时)$/;
  var RE_NEXT_CHAPTER = /^(下一章|下一单元|下一个专题|下一模块|下一部分)$/;

  // 类名/ID 兜底：超星章节页的翻页按钮类名相对稳定，文案认不出来时靠它
  var NEXT_BTN_SELECTORS = [
    '#nextNode', '.nextNode', '#next_node', '.next_node',
    '#prev_next_next', '.prev_next_next', '.nextChapter', '.chapterNext',
    '.nodeNext', '.nextNodeBtn', '.js-next-node', '.next-node',
    'a[data-action="next"]', '.chapter_next'
  ];

  var TOC_CONTAINERS = [
    '.posCatalog_level', '.posCatalog', '.chapter_list', '.chapterList',
    '.zt_list', '#catalog', '.catalogList', '.catalog_list', '.chapter-item'
  ];

  /** 按类名/ID 找翻页按钮。文案是「下一章」的一律排除，免得跨章 */
  function findNextByClass() {
    for (var i = 0; i < NEXT_BTN_SELECTORS.length; i++) {
      var els = document.querySelectorAll(NEXT_BTN_SELECTORS[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!hasBox(el)) continue;
        if (isDisabled(el)) continue;

        var t = labelFor(el);
        if (t && RE_NEXT_CHAPTER.test(t)) continue;
        return el;
      }
    }
    return null;
  }

  /**
   * 找「下一节」。
   *
   * 优先用页面自己的按钮 —— 它内部知道该跳哪个 id，比自己解析目录树可靠得多。
   * 文案匹配 → 类名兜底 → 目录树，逐层降级。
   *
   * @returns {{el, label, kind: 'section'|'chapter', via}|null}
   *   kind='chapter' 表示前面已经出章了，调用方应当停下，不要跨章乱跑
   */
  function findNextSection() {
    // 1) 文案（含 title / aria-label），宽松可见性 —— 兼容 hover 才显示的按钮
    var btn = findClickableByText(document, RE_NEXT_SECTION, { loose: true })[0];
    if (btn) {
      return { el: btn, label: labelFor(btn) || '下一节', kind: 'section', via: 'text' };
    }

    // 2) 只剩「下一章」说明已经到本章最后一节了。
    //    这一步要排在类名兜底之前 —— 否则兜底会把「下一章」按钮当成小节按钮点掉
    var chap = findClickableByText(document, RE_NEXT_CHAPTER, { loose: true })[0];
    if (chap) {
      return { el: chap, label: labelFor(chap) || '下一章', kind: 'chapter', via: 'text' };
    }

    // 3) 类名兜底
    var byClass = findNextByClass();
    if (byClass) {
      return { el: byClass, label: labelFor(byClass) || '下一节', kind: 'section', via: 'class' };
    }

    // 4) 最后才解析目录树
    return findNextSectionFromToc();
  }

  /**
   * 当前小节的标识。
   *
   * 用途：有些超星页面切小节时 URL 不变，只换 iframe。
   * 只看 URL 的话，「这个地址已经自动切过一次」的闸门会把第二节也拦下来，
   * 导致连续采集空转。加上小节标题一起做键就准了。
   */
  function getSectionKey() {
    var title = textOf('h1, .chapterTitle, .posCatalog_select_title, .zt_title, .mark_title, .chapter_name');
    if (title) return cleanText(title).slice(0, 60);

    // 页面上找不到标题就从目录树的高亮项取
    for (var c = 0; c < TOC_CONTAINERS.length; c++) {
      var boxes = document.querySelectorAll(TOC_CONTAINERS[c]);
      for (var b = 0; b < boxes.length; b++) {
        var items = boxes[b].querySelectorAll('li, a, div[onclick]');
        for (var i = 0; i < items.length; i++) {
          if (isActiveTab(items[i])) {
            var t = tabLabelOf(items[i]);
            if (t) return t.slice(0, 60);
          }
        }
      }
    }
    return '';
  }

  function findNextSectionFromToc() {
    // 找不到高亮项时，用页面标题去比对目录条目
    var pageTitle = cleanText(textOf(
      'h1, .chapterTitle, .posCatalog_select_title, .zt_title, .mark_title, .chapter_name'
    ));

    for (var c = 0; c < TOC_CONTAINERS.length; c++) {
      var boxes = document.querySelectorAll(TOC_CONTAINERS[c]);

      for (var b = 0; b < boxes.length; b++) {
        var items = boxes[b].querySelectorAll('li, a, div[onclick], span[onclick]');
        if (items.length < 2) continue;

        var activeIdx = -1;
        var i;

        // 优先认高亮项
        for (i = 0; i < items.length; i++) {
          if (isActiveTab(items[i])) activeIdx = i;
        }

        // 没有高亮就退而求其次：哪一项的文案和当前页标题对得上
        if (activeIdx < 0 && pageTitle) {
          for (i = 0; i < items.length; i++) {
            var it = tabLabelOf(items[i]);
            if (!it || it.length < 3) continue;
            if (it.indexOf(pageTitle) >= 0 || pageTitle.indexOf(it) >= 0) { activeIdx = i; break; }
          }
        }

        if (activeIdx < 0) continue;

        // 往后找第一个可点、且不是当前项后代的条目
        for (var j = activeIdx + 1; j < items.length; j++) {
          var el = items[j];
          if (!hasBox(el)) continue;
          if (items[activeIdx].contains(el)) continue;   // 当前项的子孙，还是同一节
          var t = tabLabelOf(el);
          if (!t || t.length < 2) continue;

          return { el: el, label: t, kind: 'section', via: 'toc' };
        }
      }
    }
    return null;
  }

  /**
   * 按文案找回某个标签（整页跳转后切回原标签用）。
   * 同样要避开目录树里的同名条目 —— 优先挑「旁边还有别的标签」的那个。
   */
  function findTabByText(label) {
    var t = cleanText(label);
    if (!t) return null;

    var re = new RegExp('^\\s*' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
    var hits = findClickableByText(document, re);
    if (!hits.length) return null;

    for (var i = 0; i < hits.length; i++) {
      var bar = hits[i].parentElement;
      for (var up = 0; up < 2 && bar; up++) {
        // 标签栏的特征：不止一个可点元素，而且总文字很短
        if (bar.querySelectorAll('a, button, li').length >= 2 &&
            cleanText(bar.textContent).length <= 60) {
          return hits[i];
        }
        bar = bar.parentElement;
      }
    }
    return hits[0];
  }

  /* ================================================================== *
   * 登录态检测
   * ================================================================== */

  /**
   * 判断当前页面是不是「没登录」或「登录过期」。
   * 超星会把用户踢到 passport2.chaoxing.com 或弹出一个内嵌登录框，
   * 这时候如果还去抓取，只会抓到一个空页面 —— 必须明确告诉用户。
   */
  function checkLoginState() {
    // 1) 域名判断
    if (/passport|login|sso/i.test(location.hostname + location.pathname)) {
      return { loggedIn: false, reason: '当前停在登录页，请先登录学习通' };
    }

    // 2) 页面里的登录框
    var loginHints = ['#loginBox', '.login-box', '.loginForm', '#passportLogin', '.maskLogin'];
    for (var i = 0; i < loginHints.length; i++) {
      var el = document.querySelector(loginHints[i]);
      if (el && isClickable(el)) {
        return { loggedIn: false, reason: '页面弹出了登录框，登录后再抓取' };
      }
    }

    // 3) 页面文字里有「请重新登录 / 登录已过期」
    var body = document.body ? cleanText(document.body.textContent).slice(0, 3000) : '';
    if (/登录已过期|请重新登录|请先登录|未登录/.test(body)) {
      return { loggedIn: false, reason: '登录状态已过期，请重新登录学习通' };
    }

    // 4) 用户名元素存在 → 大概率已登录
    if (document.querySelector('#zne_nickName, .userName, .personalInfo, #exitBtn, .loginOut')) {
      return { loggedIn: true, reason: '' };
    }

    // 判断不了就别拦，让用户自己看结果
    return { loggedIn: true, reason: '' };
  }

  global.CQBExtractor = {
    SEL: SEL,
    scanDocument: scanDocument,
    parseBlock: parseBlock,
    getContext: getContext,
    bankIdOf: bankIdOf,
    detectType: detectType,
    mergeContext: mergeContext,
    findQuizTab: findQuizTab,
    findTabByText: findTabByText,
    findNextSection: findNextSection,
    getSectionKey: getSectionKey,
    sameTabBar: sameTabBar,
    isActiveTab: isActiveTab,
    autoPage: autoPage,
    stopAutoPage: stopAutoPage,
    isAutoPaging: isAutoPaging,
    pagingDecision: pagingDecision,
    frameSignature: frameSignature,
    findNextButton: findNextButton,
    isDisabled: isDisabled,
    checkLoginState: checkLoginState,
    _cleanText: cleanText
  };
})(window);
