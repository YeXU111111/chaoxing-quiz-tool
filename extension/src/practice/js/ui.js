/*!
 * ui.js —— 刷题站界面层
 *
 * 状态管理很土但有效：一个 STATE 对象 + 一个 render() 树。
 * 题目量级在几千，全量重渲染完全够快，没必要上虚拟 DOM。
 */
(function () {
  'use strict';

  var CQB = window.CQB;
  var Store = window.CQBStore;
  var Session = window.CQBSession;
  var Importer = window.CQBImporter;

  /* ================================================================== *
   * 全局状态
   * ================================================================== */

  var STATE = {
    banks: {},
    subjects: {},           // courseId → 学科名，见 CQB.subjectNameOf
    progress: Store.loadProgress(),
    settings: Store.loadSettings(),
    filter: {
      bankIds: [],          // 空数组 = 全部题库
      subjects: [],         // 空数组 = 全部学科
      chapter: '',
      types: [],
      status: 'all'
    },
    mode: 'sequential',
    session: null,
    current: null         // 当前渲染的题目对象（可能是打乱选项后的副本）
  };

  var $ = function (id) { return document.getElementById(id); };
  var qa = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  /* ================================================================== *
   * 工具
   * ================================================================== */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 清洗题库里的 HTML。
   * 题库内容是本地抓来的、理论上可信，但它终究来自网页，
   * 万一被塞了 <script> / onerror= 也不能在我们页面上执行。
   * 白名单式保留常用标签，其余一律转义。
   */
  var ALLOWED_TAGS = {
    P: 1, BR: 1, SPAN: 1, DIV: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1,
    SUP: 1, SUB: 1, UL: 1, OL: 1, LI: 1, TABLE: 1, TR: 1, TD: 1, TH: 1,
    TBODY: 1, THEAD: 1, IMG: 1, CODE: 1, PRE: 1, BLOCKQUOTE: 1, FONT: 1
  };

  // 这些标签连内容一起丢掉。
  // 不要只做「提文本上来」——<script>window.x=1</script> 的 textContent
  // 会被当成正文渲染出来，虽然不执行，但页面上会出现一堆源码，很难看。
  var DROP_TAGS = {
    SCRIPT: 1, STYLE: 1, IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1, APPLET: 1,
    LINK: 1, META: 1, BASE: 1, FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1,
    SELECT: 1, OPTION: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, MATH: 1
  };

  function sanitizeHtml(html, origin) {
    var doc = new DOMParser().parseFromString('<div>' + String(html) + '</div>', 'text/html');
    var root = doc.body.firstChild;
    walk(root);
    return root.innerHTML;

    function walk(node) {
      var kids = Array.prototype.slice.call(node.childNodes);
      kids.forEach(function (n) {
        if (n.nodeType === 1) {
          if (DROP_TAGS[n.tagName]) { n.remove(); return; }
          if (!ALLOWED_TAGS[n.tagName]) {
            // 不允许的标签：把内容提上来，标签本身丢掉
            var text = doc.createTextNode(n.textContent || '');
            n.parentNode.replaceChild(text, n);
            return;
          }
          // 清掉所有 on* 事件和 javascript: 协议
          Array.prototype.slice.call(n.attributes).forEach(function (attr) {
            var name = attr.name.toLowerCase();
            var val = String(attr.value || '');
            if (name.indexOf('on') === 0) { n.removeAttribute(attr.name); return; }
            if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(val)) {
              n.removeAttribute(attr.name); return;
            }
            if (name === 'style') { n.removeAttribute('style'); return; }
          });
          if (n.tagName === 'IMG') fixImg(n, origin);
          walk(n);
        } else if (n.nodeType === 8) {
          n.parentNode.removeChild(n);   // 注释节点
        }
      });
    }
  }

  /** 超星题干里的图片常是 /star3/xxx 相对路径，要补上域名才能显示 */
  function fixImg(img, origin) {
    var src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (!src) { img.removeAttribute('src'); return; }
    if (/^https?:/i.test(src)) return;
    if (/^\/\//.test(src)) { img.setAttribute('src', 'https:' + src); return; }
    if (origin && src.charAt(0) === '/') {
      img.setAttribute('src', origin + src);
      return;
    }
    // 光秃秃的路径（既没有协议也不是绝对路径），补上 https
    if (origin) img.setAttribute('src', origin + '/' + src.replace(/^\.?\//, ''));
  }

  /**
   * 判断一段字符串是不是「真的富文本」。
   *
   * 不能简单用 /<[a-z]+>/ 判断 —— 题干里出现「若 a<b 则」「x<y>z」这种数学写法时，
   * 会被误当成标签解析，然后被白名单清洗掉，正文就丢了。
   * 所以只有出现我们明确认识的标签才走 HTML 渲染路径。
   */
  var RICH_TAG_RE = /<\/?(p|br|span|div|b|strong|i|em|u|sup|sub|ul|ol|li|table|tr|td|th|tbody|thead|img|code|pre|blockquote|font)\b[^>]*>/i;

  /** 渲染富文本：优先用 HTML（保公式、图片、排版），没有就退回纯文本 */
  function renderRich(el, item) {
    var html = item.html || item.stemHtml || '';
    var origin = item.origin || '';
    if (html && RICH_TAG_RE.test(html)) {
      el.innerHTML = sanitizeHtml(html, origin);
      // 清洗后如果什么文字都没剩下，退回纯文本，避免出现空白题干
      if (!el.textContent.trim() && !el.querySelector('img')) {
        el.textContent = item.text || item.stem || '';
      }
    } else {
      el.textContent = item.text || item.stem || '';
    }
    el.querySelectorAll('img').forEach(function (img) {
      img.loading = 'lazy';
      img.onerror = function () { this.style.display = 'none'; };
    });
    typesetMath(el);
  }

  function typesetMath(el) {
    if (window.MathJax && window.MathJax.typesetPromise) {
      try { window.MathJax.typesetPromise([el]); } catch (e) { /* 离线时忽略 */ }
    }
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2400);
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
             ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return ''; }
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /* ================================================================== *
   * 数据入口
   * ================================================================== */

  function reloadBanks() {
    // 题库和学科映射一起加载 —— 学科名要参与归组，缺一个都不完整
    return Promise.all([Store.loadBanks(), Store.loadSubjects()]).then(function (r) {
      STATE.banks = r[0] || {};
      STATE.subjects = r[1] || {};
      renderBankSelect();
      rebuildSession();
    });
  }

  /**
   * 丢掉当前范围里已经不存在的题型/章节选择。
   *
   * 换学科之后，原来选的题型可能在新范围里一道题都没有 ——
   * 留着它，池子会莫名其妙变空，而用户看不出是哪个条件在作怪。
   */
  function pruneFilterSelections() {
    var types = {};
    var chapters = {};

    banksInScope().forEach(function (id) {
      STATE.banks[id].questions.forEach(function (q) {
        types[q.type] = 1;
        chapters[q.chapter || '未分章节'] = 1;
      });
    });

    STATE.filter.types = STATE.filter.types.filter(function (t) { return types[t]; });
    if (STATE.filter.chapter && !chapters[STATE.filter.chapter]) STATE.filter.chapter = '';
  }

  /** 重建练习序列（筛选条件或题库变化时调用） */
  function rebuildSession(keepQid) {
    pruneFilterSelections();

    var filter = Object.assign({}, STATE.filter, { subjectMap: STATE.subjects });
    if (STATE.settings.skipNoAnswer) filter.onlyWithAnswer = true;

    // 注意把内存里的 progress 传进去，而不是让引擎自己去读 storage ——
    // storage 写入有防抖，回读会拿到旧数据
    var pool = Session.buildPool(STATE.banks, filter, STATE.progress);
    var s = new Session(null, [], { mode: STATE.mode, progress: STATE.progress });
    s.load(pool, STATE.mode);
    STATE.session = s;

    if (keepQid) {
      var i = s.indexOfId(keepQid);
      if (i >= 0) s.cursor = i;
    }

    renderAll();
  }

  /* ================================================================== *
   * 渲染
   * ================================================================== */

  function renderAll() {
    renderSubjects();
    renderFilters();
    renderStats();
    renderQuestion();
    renderGrid();
  }

  /**
   * 学科 chips。
   *
   * 只显示一个学科时不代表没用 —— 「改名」按钮要靠它选中目标。
   */
  /** 把已有的学科名灌进 datalist，各处输入框都能补全，省得手打错字分出新组 */
  function refreshSubjectOptions() {
    var dl = $('subjectOptions');
    if (!dl) return;
    var names = CQB.groupBySubject(STATE.banks, STATE.subjects)
      .map(function (g) { return g.name; })
      .filter(function (n) { return n && n !== CQB.UNCLASSIFIED; });
    dl.innerHTML = names.map(function (n) {
      return '<option value="' + escapeHtml(n) + '"></option>';
    }).join('');
  }

  function renderSubjects() {
    var box = $('subjectFilter');
    if (!box) return;

    refreshSubjectOptions();

    var groups = CQB.groupBySubject(STATE.banks, STATE.subjects);

    if (!groups.length) {
      box.innerHTML = '<span class="hint">暂无题库</span>';
      return;
    }

    var total = groups.reduce(function (n, g) { return n + g.questions; }, 0);
    var chosen = STATE.filter.subjects;

    var html = '<button class="chip' + (chosen.length ? '' : ' active') +
               '" data-subject="" title="显示全部学科">全部 ' + total + '</button>';

    var unclassified = null;

    groups.forEach(function (g) {
      var on = chosen.indexOf(g.name) >= 0;
      var unc = g.name === CQB.UNCLASSIFIED;
      if (unc) unclassified = g;

      // 未分类且确实有题没归位 —— 值得催一下
      var nag = (unc && g.questions) ? ' chip-nag' : '';
      var cls = 'chip' + (on ? ' active' : '') + (unc ? ' chip-muted' : '') + nag;

      var tip = (on ? '再点一下取消选择' : '点一下只看这个学科') +
                '　' + g.bankIds.length + ' 套题库' +
                (g.courseIds.length ? '　课程 ID：' + g.courseIds.join('、') : '　（没抓到课程 ID）');

      html += '<button class="' + cls + '" data-subject="' + escapeHtml(g.name) + '"' +
              ' title="' + escapeHtml(g.name + '　' + tip) + '">' +
              escapeHtml(g.name) + ' ' + g.questions + '</button>';
    });

    box.innerHTML = html;

    // 一行说明：多选时告诉用户还能取消，没选时提醒有未分类
    var note = $('subjectNote');
    if (note) {
      if (chosen.length > 1) {
        note.textContent = '已选 ' + chosen.length + ' 个学科，再点芯片可取消';
        note.className = 'filter-note';
      } else if (!chosen.length && unclassified && unclassified.questions) {
        note.textContent = '有 ' + unclassified.questions + ' 道题还没归类，点「归类」分一下';
        note.className = 'filter-note warn';
      } else {
        note.textContent = '';
        note.className = 'filter-note hidden';
      }
    }

    // 改名按钮只在选中了单个学科时可用
    var renameBtn = $('btnRenameSubject');
    if (renameBtn) {
      var renameable = selectedSubjectGroups(groups);
      renameBtn.disabled = !renameable;
      renameBtn.title = renameable
        ? '把「' + renameable[0].name + '」改名'
        : '先选中一个学科（只选中一个时才能改名）';
    }
  }

  /** 当前选中的学科分组；没选或选了多个就返回 null（改名需要唯一目标） */
  function selectedSubjectGroups(groups) {
    groups = groups || CQB.groupBySubject(STATE.banks, STATE.subjects);
    if (STATE.filter.subjects.length === 1) {
      return groups.filter(function (g) { return g.name === STATE.filter.subjects[0]; });
    }
    // 一个都没选、但整站只有一个学科时，也允许直接改名
    if (!STATE.filter.subjects.length && groups.length === 1) return groups;
    return null;
  }

  function renderBankSelect() {
    var sel = $('bankSelect');

    // 题库下拉只在「当前选中的学科」范围内列出，否则选了学科还能挑到别的学科的题库，很迷惑
    var ids = Object.keys(STATE.banks).filter(function (id) {
      if (!STATE.filter.subjects.length) return true;
      return STATE.filter.subjects.indexOf(
        CQB.subjectNameOf(STATE.banks[id], STATE.subjects)
      ) >= 0;
    });

    var cur = STATE.filter.bankIds.length === 1 ? STATE.filter.bankIds[0] : '__all__';

    var html = '<option value="__all__">全部题库（' + ids.length + ' 套）</option>';
    ids.forEach(function (id) {
      var b = STATE.banks[id];
      var subj = CQB.subjectNameOf(b, STATE.subjects);
      var title = b.workTitle || '未命名';
      html += '<option value="' + escapeHtml(id) + '">' +
        escapeHtml(subj + ' / ' + title) +
        '（' + (b.questions || []).length + '）</option>';
    });

    sel.innerHTML = html;
    sel.value = ids.indexOf(cur) >= 0 || cur === '__all__' ? cur : '__all__';
  }

  /**
   * 当前「学科 + 题库」两个筛选条件下，实际会参与练习的题库 id。
   *
   * 题型计数、章节计数、错题统计都必须走这一个口径。
   * 否则会出现「左栏选的是英语，题型栏却还在显示计网的填空题 12」这种自相矛盾 ——
   * 用户点了那个题型，池子直接空掉。
   */
  function banksInScope() {
    var subj = STATE.filter.subjects;
    var ids = STATE.filter.bankIds;
    var map = STATE.subjects;

    return Object.keys(STATE.banks).filter(function (id) {
      if (ids.length && ids.indexOf(id) < 0) return false;
      if (subj.length && subj.indexOf(CQB.subjectNameOf(STATE.banks[id], map)) < 0) return false;
      return true;
    });
  }

  function renderFilters() {
    // 题型 chips：只显示当前范围内真实存在的题型
    var typeCount = {};
    banksInScope().forEach(function (id) {
      STATE.banks[id].questions.forEach(function (q) {
        typeCount[q.type] = (typeCount[q.type] || 0) + 1;
      });
    });

    var typeBox = $('typeFilter');
    if (!Object.keys(typeCount).length) {
      typeBox.innerHTML = '<span class="hint">暂无题目</span>';
    } else {
      var html = '';
      CQB.TYPE_ORDER.forEach(function (t) {
        if (!typeCount[t]) return;
        var active = STATE.filter.types.indexOf(t) >= 0 ? ' active' : '';
        html += '<button class="chip' + active + '" data-type="' + t + '">' +
                CQB.TYPE_LABEL[t] + ' ' + typeCount[t] + '</button>';
      });
      typeBox.innerHTML = html;
      typeBox.querySelectorAll('[data-type]').forEach(function (el) {
        el.onclick = function () {
          var t = el.getAttribute('data-type');
          var i = STATE.filter.types.indexOf(t);
          if (i >= 0) STATE.filter.types.splice(i, 1); else STATE.filter.types.push(t);
          STATE.filter.chapter = '';
          rebuildSession();
        };
      });
    }

    // 章节列表
    var chapterCount = {};
    banksInScope().forEach(function (id) {
      STATE.banks[id].questions.forEach(function (q) {
        var c = q.chapter || '未分章节';
        chapterCount[c] = (chapterCount[c] || 0) + 1;
      });
    });

    var list = $('chapterList');
    var keys = Object.keys(chapterCount);
    if (!keys.length) { list.innerHTML = '<li class="hint">暂无章节</li>'; return; }

    var h = '<li class="' + (STATE.filter.chapter === '' ? 'active' : '') + '" data-chapter="">' +
            '<span>全部章节</span><em>' + keys.reduce(function (n, k) { return n + chapterCount[k]; }, 0) + '</em></li>';
    keys.forEach(function (c) {
      h += '<li class="' + (STATE.filter.chapter === c ? 'active' : '') + '" data-chapter="' + escapeHtml(c) + '">' +
           '<span>' + escapeHtml(c) + '</span><em>' + chapterCount[c] + '</em></li>';
    });
    list.innerHTML = h;
    list.querySelectorAll('[data-chapter]').forEach(function (el) {
      el.onclick = function () {
        STATE.filter.chapter = el.getAttribute('data-chapter');
        rebuildSession();
      };
    });
  }

  function renderStats() {
    var s = STATE.session;
    var st = s ? s.stats() : { total: 0, done: 0, correct: 0, accuracy: 0, wrong: 0 };
    $('statTotal').textContent = st.total;
    $('statDone').textContent = st.done;
    $('statAcc').textContent = st.done ? st.accuracy + '%' : '—';
    $('statAcc').className = st.done ? (st.accuracy >= 60 ? 'c-ok' : 'c-bad') : '';

    // 错题数跟着当前学科/题库范围走。
    // 这块面板叫「本组进度」，如果选了英语却显示全部学科的错题数，读起来是错的。
    var wrongInScope = 0;
    banksInScope().forEach(function (id) {
      STATE.banks[id].questions.forEach(function (q) {
        var p = STATE.progress[q.id];
        if (p && p.wrongBooked) wrongInScope++;
      });
    });
    $('statWrong').textContent = wrongInScope;
  }

  function renderQuestion() {
    var s = STATE.session;
    var item = s && s.current();

    if (!item) {
      $('questionCard').classList.add('hidden');
      $('emptyState').classList.remove('hidden');
      var hasBanks = Object.keys(STATE.banks).length > 0;
      $('emptyState').querySelector('h2').textContent = hasBanks ? '当前筛选没有题目' : '题库还是空的';

      if (hasBanks) {
        $('emptyState').querySelector('p').innerHTML = '换个筛选条件试试，或者点「全部」重置状态筛选。';
      } else if (Store.IN_EXTENSION) {
        $('emptyState').querySelector('p').innerHTML =
          '用扩展的悬浮面板点「抓取本题」，题目会自动出现在这里；<br>' +
          '或者点右上角「导入题库」手动导入 JSON / 文本格式的题库。';
      } else {
        // 独立版最容易踩的坑：以为抓到的题会自动出现在这里。
        // 它读的是本页 localStorage，和扩展的 chrome.storage 是两套存储。
        $('emptyState').querySelector('p').innerHTML =
          '点右上角「导入题库」导入 JSON / 文本格式的题库，或先「载入示例题库」试试功能。' +
          '<span class="standalone-note"><b>注意：你现在打开的是独立版刷题站。</b>' +
          '它读的是本页的本地存储，和浏览器扩展里的题库<b>不互通</b>。' +
          '如果你装了扩展，请从扩展弹窗点「打开刷题台」—— 那个是内嵌版，抓到的题会自动同步进去。</span>';
      }
      return;
    }

    $('emptyState').classList.add('hidden');
    $('questionCard').classList.remove('hidden');

    var q = item.q;

    // 选项打乱：只影响本次渲染，不改题库
    if (STATE.settings.shuffleOptions && q.options.length && q.type !== 'judge') {
      q = Session.shuffleOptions(q);
    }
    STATE.current = q;

    // ---- 头部标签 ----
    $('tagType').textContent = CQB.TYPE_LABEL[q.type] || '题目';
    var subjTag = $('tagSubject');
    if (subjTag) {
      var subj = item.subject || CQB.UNCLASSIFIED;
      subjTag.textContent = subj;
      // 未分类要显眼 —— 它是个待处理的状态，不是一种学科
      subjTag.classList.toggle('tag-nag', subj === CQB.UNCLASSIFIED);
      subjTag.style.display = '';   // 一直显示：按「全部」浏览时得能看出这题属于哪里
    }

    $('tagChapter').textContent = q.chapter || '未分章节';
    $('tagChapter').style.display = q.chapter ? '' : 'none';
    $('tagBank').textContent = item.bankTitle;
    $('tagNoAnswer').classList.toggle('hidden', !!q.hasAnswer);
    $('posCurrent').textContent = s.cursor + 1;
    $('posTotal').textContent = s.count();

    // ---- 题干 ----
    renderRich($('qStem'), {
      html: q.stemHtml, text: q.stem, origin: q.origin
    });

    // ---- 选项 / 填空 / 简答 ----
    var userAnswer = s.getAnswer(q.id);
    var result = s.result(q.id);
    var revealed = s.isRevealed(q.id);

    if (q.type === 'fill') {
      renderFill(q, userAnswer, result, revealed);
    } else if (q.type === 'short') {
      renderShort(q, userAnswer, result, revealed);
    } else {
      renderOptions(q, userAnswer, result, revealed);
    }

    renderFeedback(q, result, revealed);
    renderFootState(q, result, revealed);
    renderGrid();   // 高亮当前题号
  }

  function renderOptions(q, userAnswer, result, revealed) {
    var box = $('qOptions');
    var isMultiple = q.type === 'multiple';
    var locked = !!result;

    box.classList.remove('hidden');
    $('qFill').classList.add('hidden');

    var picked = {};
    (userAnswer.keys || []).forEach(function (k) { picked[k] = 1; });

    var correctKeys = {};
    if (result || revealed) {
      (q.answer.keys || []).forEach(function (k) { correctKeys[k] = 1; });
    }

    var html = '';
    q.options.forEach(function (o) {
      var cls = ['opt'];
      if (picked[o.key]) cls.push('selected');
      if (locked || revealed) {
        cls.push('locked');
        if (correctKeys[o.key]) cls.push('correct');
        else if (picked[o.key]) cls.push('wrong');
      }
      var mark = '';
      if (locked || revealed) {
        if (correctKeys[o.key]) mark = '<span class="opt-mark ok">✓ 正确</span>';
        else if (picked[o.key]) mark = '<span class="opt-mark bad">✗ 你的选择</span>';
      }
      html += '<button type="button" class="' + cls.join(' ') + '" data-key="' + escapeHtml(o.key) + '"' +
              (locked ? ' disabled' : '') + '>' +
              '<span class="opt-key">' + escapeHtml(o.key) + '</span>' +
              '<span class="opt-text" data-opt="' + escapeHtml(o.key) + '"></span>' +
              mark + '</button>';
    });

    if (!q.options.length) {
      html = '<div class="fill-hint">这道题没有解析出选项。若是填空题/简答题，请重新抓取。</div>';
    }

    box.innerHTML = html;

    // 选项文本单独渲染，避免富文本被 escape 两遍
    q.options.forEach(function (o) {
      var el = box.querySelector('[data-opt="' + cssEsc(o.key) + '"]');
      if (el) renderRich(el, { html: o.html, text: o.text, origin: q.origin });
    });

    if (locked) return;

    box.querySelectorAll('.opt').forEach(function (el) {
      el.onclick = function () {
        var key = el.getAttribute('data-key');
        var cur = STATE.session.getAnswer(q.id);
        if (isMultiple) {
          var keys = (cur.keys || []).slice();
          var i = keys.indexOf(key);
          if (i >= 0) keys.splice(i, 1); else keys.push(key);
          cur.keys = keys.sort();
        } else {
          cur.keys = [key];
        }
        STATE.session.setAnswer(q.id, cur);
        renderQuestion();
      };
    });
  }

  function renderFill(q, userAnswer, result, revealed) {
    var box = $('qFill');
    box.classList.remove('hidden');
    $('qOptions').classList.add('hidden');
    box.className = 'fill-area';

    // 空数取三者最大值：stem 里的 ___ 个数、答案个数、至少 1
    var blanksInStem = (q.stem.match(/_{2,}|（\s*）|\(\s*\)/g) || []).length;
    var n = Math.max(blanksInStem, (q.answer.text || []).length, 1);

    var texts = (userAnswer.text || []).slice();
    while (texts.length < n) texts.push('');

    var expTexts = (result || revealed) ? (q.answer.text || []) : [];
    var html = '';
    for (var i = 0; i < n; i++) {
      var cls = '';
      if (result && !result.ungraded) {
        cls = (cmpText(texts[i]) === cmpText(expTexts[i])) ? 'correct' : 'wrong';
      }
      html += '<div class="fill-row">' +
        '<label>第 ' + (i + 1) + ' 空</label>' +
        '<input type="text" data-blank="' + i + '" value="' + escapeHtml(texts[i]) + '"' +
        (result ? ' disabled' : '') + ' class="' + cls + '" placeholder="输入答案后按 Enter 提交">' +
        '</div>';
    }
    if (expTexts.length && (result || revealed)) {
      html += '<div class="fill-hint">参考答案：' + expTexts.map(escapeHtml).join(' ／ ') + '</div>';
    }
    box.innerHTML = html;

    if (result) return;

    var inputs = box.querySelectorAll('input[data-blank]');
    inputs.forEach(function (inp) {
      inp.oninput = function () {
        var cur = STATE.session.getAnswer(q.id);
        var arr = (cur.text || []).slice();
        while (arr.length < n) arr.push('');
        arr[Number(inp.getAttribute('data-blank'))] = inp.value;
        cur.text = arr;
        STATE.session.setAnswer(q.id, cur);
      };
      inp.onkeydown = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSubmit(); }
      };
    });
  }

  function renderShort(q, userAnswer, result, revealed) {
    var box = $('qFill');
    box.classList.remove('hidden');
    $('qOptions').classList.add('hidden');
    box.className = 'fill-area short-area';

    var val = (userAnswer.text || [])[0] || '';
    box.innerHTML = '<textarea data-short placeholder="写下你的答案要点，提交后与参考答案对照（简答题不自动判分）"' +
                    (result ? ' disabled' : '') + '>' + escapeHtml(val) + '</textarea>' +
                    (revealed && (q.answer.text || []).length
                      ? '<div class="fill-hint"><b>参考答案：</b><br>' + escapeHtml((q.answer.text || []).join('<br>')) + '</div>'
                      : '');

    var ta = box.querySelector('[data-short]');
    if (!ta || result) return;
    ta.oninput = function () { STATE.session.setAnswer(q.id, { keys: [], text: [ta.value] }); };
    ta.onkeydown = function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSubmit(); }
    };
  }

  function cmpText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  }

  function renderFeedback(q, result, revealed) {
    var box = $('qFeedback');
    if (!result && !revealed) { box.className = 'feedback hidden'; return; }

    var lines = [];
    var cls = 'feedback', head = '';

    if (result && result.ungraded) {
      cls += ' warn';
      head = '⚠ 这道题的答案还没公布，无法判分';
    } else if (result) {
      cls += result.correct ? ' ok' : ' bad';
      head = result.correct ? '✓ 回答正确' : '✗ 回答错误';
    } else {
      cls += ' warn';
      head = '👁 答案预览';
    }

    var userTxt = result ? formatAnswer(q, result.got) : '';
    var expTxt = formatAnswer(q, q.answer);

    if (result && !result.needManual) {
      if (userTxt) lines.push('<div class="fb-line"><b>我的答案：</b>' + escapeHtml(userTxt) + '</div>');
      if (expTxt) lines.push('<div class="fb-line"><b>正确答案：</b>' + escapeHtml(expTxt) + '</div>');
      if (result.partial != null && q.type === 'fill') {
        lines.push('<div class="fb-line"><b>命中：</b>' + Math.round(result.partial * 100) + '%</div>');
      }
    } else if (expTxt) {
      lines.push('<div class="fb-line"><b>参考答案：</b>' + escapeHtml(expTxt) + '</div>');
    }

    if (q.analysis) {
      // 解析是纯文本（抓取时取的 textContent），这里只做转义，不做 HTML 解析
      lines.push('<div class="fb-analysis"><b>解析：</b>' +
        escapeHtml(q.analysis).replace(/\n/g, '<br>') + '</div>');
    }

    // 历史做错次数提示
    var p = STATE.progress[q.id];
    if (p && p.attempts) {
      lines.push('<div class="fb-line" style="margin-top:6px;font-size:12.5px;color:var(--text-3)">' +
                 '本题累计作答 ' + p.attempts + ' 次，答错 ' + p.wrong + ' 次</div>');
    }

    box.className = cls;
    box.innerHTML = '<div class="fb-head">' + head + '</div>' + lines.join('');
  }

  function formatAnswer(q, ans) {
    if (!ans) return '';
    if (q.type === 'fill' || q.type === 'short') {
      var t = (ans.text || []).filter(function (x) { return String(x).trim(); });
      return t.length ? t.join(' ／ ') : '';
    }
    var keys = (ans.keys || []).slice().sort();
    if (!keys.length) return '';
    if (q.type === 'judge' && q.options.length) {
      var opt = q.options.filter(function (o) { return o.key === keys[0]; })[0];
      if (opt) return keys[0] + '（' + opt.text + '）';
    }
    return keys.join('');
  }

  function renderFootState(q, result, revealed) {
    var p = STATE.progress[q.id] || {};
    $('btnStar').className = 'btn' + (p.starred ? ' starred' : '');
    $('btnStar').textContent = p.starred ? '★ 已收藏' : '☆ 收藏';

    // 提交后选项会被锁定，此时「重新提交」没有意义（只会重复记录一次作答）。
    // 按钮改成「重做本题」，行为也切到 doRedo。
    $('btnSubmit').textContent = result ? '重做本题' : '提交';
    $('btnSubmit').dataset.mode = result ? 'redo' : 'submit';
    $('btnPrev').disabled = STATE.session.isFirst();
    $('btnNext').disabled = STATE.session.isLast();
    $('btnReveal').disabled = revealed && !result;
    $('btnReveal').textContent = revealed ? '已显示答案' : '显示答案';
  }

  function renderGrid() {
    var s = STATE.session;
    var grid = $('questionGrid');
    if (!s || !s.count()) { grid.innerHTML = '<span class="hint">暂无题目</span>'; return; }

    var html = '';
    s.questions.forEach(function (item, i) {
      var q = item.q;
      var r = s.results[q.id];
      var p = STATE.progress[q.id] || {};
      var cls = ['qdot'];
      if (r && !r.ungraded) cls.push(r.correct ? 'ok' : 'bad');
      else if (p.wrongBooked) cls.push('bad');
      if (p.starred) cls.push('star');
      if (i === s.cursor) cls.push('current');
      html += '<button class="' + cls.join(' ') + '" data-i="' + i + '" title="第 ' + (i + 1) + ' 题">' +
              (i + 1) + '</button>';
    });
    grid.innerHTML = html;
    grid.querySelectorAll('[data-i]').forEach(function (el) {
      el.onclick = function () {
        STATE.session.goto(Number(el.getAttribute('data-i')));
        renderQuestion();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ================================================================== *
   * 行为
   * ================================================================== */

  /**
   * 给学科改名。
   *
   * 超星的课程名往往长成「2024-2025-1-高等数学(上)-0001」这样，直接当学科名没法看。
   * 改名只写映射表，不动题库里的任何内容，也不影响练习进度。
   */
  function doRenameSubject() {
    var groups = CQB.groupBySubject(STATE.banks, STATE.subjects);
    var targets = selectedSubjectGroups(groups);

    if (!targets || !targets.length) {
      toast('先在左边选中一个学科（只选一个时才能改名）', true);
      return;
    }

    var g = targets[0];
    if (!g.keys.length) {
      toast('这些题库既没有课程 ID 也没有题库 ID，没法改名', true);
      return;
    }

    var msg = '给「' + g.name + '」起个新名字。\n\n' +
              '影响范围：' + g.bankIds.length + ' 套题库、' + g.questions + ' 道题。\n' +
              '以后从同一门课抓来的题会自动归到新名字下。\n' +
              '留空 = 恢复用超星的课程名自动识别。';

    var input;
    try {
      input = window.prompt(msg, g.name === CQB.UNCLASSIFIED ? '' : g.name);
    } catch (e) {
      toast('当前环境不支持输入框，改名失败', true);
      return;
    }
    if (input === null) return;      // 用户点了取消

    var newName = String(input).trim();

    Store.renameSubject(g, newName).then(function (map) {
      STATE.subjects = map;

      // 选中项要跟着改名走，否则改完筛选条件指向一个不存在的名字，题目会全空
      if (STATE.filter.subjects.length === 1) {
        STATE.filter.subjects = newName ? [newName] : [];
      }
      STATE.filter.bankIds = [];

      renderBankSelect();
      rebuildSession();

      toast(newName ? ('已改名为「' + newName + '」') : '已恢复用课程名自动识别');
    });
  }

  /* ------------------------------------------------------------------ *
   * 整理题库：逐套指定学科
   *
   * 「改名」是按整个学科批量改，解决不了「一批导入的题其实属于好几个学科」
   * 这种情况 —— 它们一开始全挤在「未分类」里，得一套一套分开。
   * ------------------------------------------------------------------ */

  /** 已有的学科名（不含「未分类」），按拼音排 */
  function subjectNames() {
    var names = [];
    CQB.groupBySubject(STATE.banks, STATE.subjects).forEach(function (g) {
      if (g.name !== CQB.UNCLASSIFIED && names.indexOf(g.name) < 0) names.push(g.name);
    });
    return names.sort(function (a, b) { return a.localeCompare(b, 'zh'); });
  }

  /**
   * 学科下拉的选项。
   * 第一项是「（未分类）」，最后一项是「＋ 新建学科…」。
   *
   * 用下拉而不是让用户手打 —— 手打太容易打错一个字就分出一个新学科组，
   * 而且完全看不出到底已经有哪些学科可选。
   */
  function subjectOptionsHtml(selected, extraNames) {
    var names = subjectNames();
    (extraNames || []).forEach(function (n) {
      if (n && n !== CQB.UNCLASSIFIED && names.indexOf(n) < 0) names.push(n);
    });

    var html = '<option value=""' + (selected ? '' : ' selected') + '>（未分类）</option>';
    names.forEach(function (n) {
      html += '<option value="' + escapeHtml(n) + '"' + (n === selected ? ' selected' : '') + '>' +
              escapeHtml(n) + '</option>';
    });
    html += '<option value="__new__">＋ 新建学科…</option>';
    return html;
  }

  function openOrganize() {
    if (!Object.keys(STATE.banks).length) { toast('还没有题库', true); return; }

    if ($('organizeSearch')) $('organizeSearch').value = '';
    if ($('organizeCheckAll')) $('organizeCheckAll').checked = false;

    renderOrganize('');
    refreshOrganizeBulkOptions();
    openModal('organizeModal');
  }

  /** 顶部「批量设为」那个下拉。行里出现过的自定义学科也要能选到 */
  function refreshOrganizeBulkOptions() {
    var sel = $('organizeBulk');
    if (!sel) return;

    var extra = qa('#organizeList .organize-select').map(function (s) { return s.value; })
      .filter(function (v) { return v && v !== '__new__'; });

    sel.innerHTML = subjectOptionsHtml('', extra);
  }

  function renderOrganize(keyword) {
    var box = $('organizeList');
    if (!box) return;

    var kw = String(keyword || '').trim().toLowerCase();

    // 未分类的排最前面 —— 它们才是最需要处理的
    var ids = Object.keys(STATE.banks).sort(function (a, b) {
      var ga = CQB.subjectNameOf(STATE.banks[a], STATE.subjects);
      var gb = CQB.subjectNameOf(STATE.banks[b], STATE.subjects);
      var ua = ga === CQB.UNCLASSIFIED ? 0 : 1;
      var ub = gb === CQB.UNCLASSIFIED ? 0 : 1;
      return (ua - ub) || ga.localeCompare(gb, 'zh') || a.localeCompare(b);
    });

    var html = '';
    var shown = 0;

    ids.forEach(function (id) {
      var b = STATE.banks[id];
      var subj = CQB.subjectNameOf(b, STATE.subjects);
      var title = (b.courseName ? b.courseName + ' / ' : '') + (b.workTitle || '未命名');

      if (kw && (title + ' ' + subj).toLowerCase().indexOf(kw) < 0) return;
      shown++;

      html += '<div class="organize-row">' +
        '<input type="checkbox" class="organize-check" data-bank="' + escapeHtml(id) + '"' +
          ' title="勾选后可批量修改">' +
        '<div class="organize-name" title="' + escapeHtml(title) + '">' +
          '<b>' + escapeHtml(title) + '</b>' +
          '<small>' + (b.questions || []).length + ' 题' +
            (b.courseId ? ' · 课程 ID ' + escapeHtml(b.courseId) : ' · 无课程 ID') +
          '</small>' +
        '</div>' +
        '<select class="organize-select" data-bank="' + escapeHtml(id) + '">' +
          subjectOptionsHtml(subj === CQB.UNCLASSIFIED ? '' : subj) +
        '</select>' +
        '<button class="btn mini danger organize-del" data-bank="' + escapeHtml(id) + '"' +
          ' title="删除这套题库">删</button>' +
      '</div>';
    });

    box.innerHTML = shown ? html : '<p class="hint">没有匹配的题库</p>';

    box.querySelectorAll('.organize-select').forEach(function (sel) {
      sel.onchange = function () { onSubjectSelectChange(this); };
    });
    box.querySelectorAll('.organize-check').forEach(function (c) {
      c.onchange = updateOrganizeCount;
    });
    box.querySelectorAll('.organize-del').forEach(function (btn) {
      btn.onclick = function () { doDeleteBanks([this.getAttribute('data-bank')]); };
    });

    updateOrganizeCount();
  }

  /** 行内下拉选到「＋ 新建学科…」时，问个名字再把它插进所有下拉 */
  function onSubjectSelectChange(sel) {
    if (!sel || sel.value !== '__new__') return;

    var name = '';
    try { name = window.prompt('新建一个学科，叫什么名字？') || ''; } catch (e) { name = ''; }
    name = String(name).trim();

    if (!name) { sel.value = ''; return; }    // 取消 = 退回未分类

    // 插进所有下拉，保证这一批操作里处处可选
    qa('#organizeList .organize-select').forEach(function (s) {
      var opts = Array.prototype.slice.call(s.options);
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === name) return;              // 已经存在
        if (opts[i].value === '__new__') {
          var o = document.createElement('option');
          o.value = name;
          o.textContent = name;
          s.insertBefore(o, opts[i]);
          return;
        }
      }
    });

    sel.value = name;
    refreshOrganizeBulkOptions();
    toast('新学科「' + name + '」，点保存后生效');
  }

  function updateOrganizeCount() {
    var all = qa('#organizeList .organize-check');
    var on = all.filter(function (c) { return c.checked; });
    var label = $('organizeCount');
    if (label) {
      label.textContent = on.length
        ? ('已选 ' + on.length + ' / ' + all.length)
        : ('全选（' + all.length + ' 套）');
    }
  }

  /** 把勾选中的题库一次性设为同一个学科 */
  function organizeBulkApply() {
    var checked = qa('#organizeList .organize-check').filter(function (c) { return c.checked; });
    if (!checked.length) { toast('先勾选要修改的题库', true); return; }

    var sel = $('organizeBulk');
    if (!sel) return;

    if (sel.value === '__new__') { onSubjectSelectChange(sel); return; }

    var name = sel.value;
    var n = 0;

    checked.forEach(function (c) {
      var row = c.closest('.organize-row');
      var s = row && row.querySelector('.organize-select');
      if (!s) return;
      s.value = name;
      n++;
    });

    toast('已把 ' + n + ' 套题库设为「' + (name || '未分类') + '」，记得点保存');
  }

  function saveOrganize() {
    var sels = qa('#organizeList .organize-select');
    if (!sels.length) { closeModals(); return; }

    var next = Object.assign({}, STATE.subjects);
    var changed = 0;

    sels.forEach(function (sel) {
      var b = STATE.banks[sel.getAttribute('data-bank')];
      if (!b) return;
      var key = CQB.subjectKeyOf(b);
      if (!key) return;

      var raw = sel.value;
      var name = raw === '__new__' ? '' : String(raw || '').trim();
      var before = next[key] || '';

      if (name) next[key] = name; else delete next[key];
      if (before !== name) changed++;
    });

    if (!changed) { toast('没有改动'); closeModals(); return; }

    Store.saveSubjects(next).then(function () {
      STATE.subjects = next;

      // 归组变了，原来的筛选条件可能指向一个已经不存在的学科名
      STATE.filter.subjects = [];
      STATE.filter.bankIds = [];
      STATE.filter.chapter = '';

      renderBankSelect();
      rebuildSession();
      refreshSubjectOptions();
      closeModals();
      toast('已更新 ' + changed + ' 套题库的学科');
    });
  }

  /* ------------------------------------------------------------------ *
   * 删除
   *
   * 删除会连练习进度一起清掉。只删题不删进度的话：这些记录永远没人再读、
   * 白占 localStorage 配额，而且以后重新导入同一批题（id 相同）会莫名其妙
   * 带上旧的做题记录。所以确认框里会把这一点写明白。
   *
   * 想只清进度、不动题库的话，设置里有「清空练习进度」。
   * ------------------------------------------------------------------ */

  /** 删完之后把内存状态收拾干净。返回顺带清掉了几条练习记录 */
  function afterDelete(res) {
    STATE.banks = res.banks;

    var dropped = Store.forgetProgress(STATE.progress, res.removedIds || []);

    // 被删的题库可能还挂在筛选项里，留着会筛出一个空池子
    var alive = Object.keys(STATE.banks);
    STATE.filter.bankIds = STATE.filter.bankIds.filter(function (id) {
      return alive.indexOf(id) >= 0;
    });

    return dropped;
  }

  /** 让确认框在无头/自动化环境里也能走通 */
  function askConfirm(msg) {
    try { return window.confirm(msg); } catch (e) { return true; }
  }

  function doDeleteBanks(bankIds) {
    bankIds = (bankIds || []).filter(function (id) { return STATE.banks[id]; });
    if (!bankIds.length) { toast('没有要删除的题库', true); return; }

    var qTotal = bankIds.reduce(function (n, id) {
      return n + ((STATE.banks[id].questions || []).length);
    }, 0);

    var head = bankIds.length === 1
      ? '删除题库「' + (STATE.banks[bankIds[0]].workTitle ||
                        STATE.banks[bankIds[0]].courseName || bankIds[0]) + '」？'
      : '删除这 ' + bankIds.length + ' 套题库？';

    if (!askConfirm(head + '\n\n共 ' + qTotal + ' 道题。\n' +
        '这些题的练习记录（作答 / 错题本 / 收藏）也会一起清掉。\n\n此操作不可撤销。')) {
      return;
    }

    Store.deleteBanks(bankIds).then(function (res) {
      if (!res.removedBanks) { toast('没找到要删的题库', true); return; }

      var dropped = afterDelete(res);

      renderBankSelect();
      refreshSubjectOptions();
      rebuildSession();

      // 如果是从「整理题库」弹窗里删的，列表得跟着刷新 ——
      // 否则被删掉的那几行还挂在那里，看着像没删成功
      if ($('organizeModal') && !$('organizeModal').classList.contains('hidden')) {
        renderOrganize(($('organizeSearch') || {}).value || '');
        refreshOrganizeBulkOptions();
      }

      toast('已删除 ' + res.removedBanks + ' 套题库、' + res.removedIds.length + ' 道题' +
            (dropped ? '，连同 ' + dropped + ' 条练习记录' : ''));
    });
  }

  function doDeleteCurrent() {
    var s0 = STATE.session;
    var item = s0 && s0.current();
    if (!item) return;

    var plain = String(item.q.stem || '').replace(/<[^>]+>/g, '').trim();
    var preview = plain.slice(0, 40) + (plain.length > 40 ? '…' : '');

    if (!askConfirm('从《' + (item.bankTitle || '当前题库') + '》里删掉这道题？\n\n' +
        preview + '\n\n它的练习记录也会一起清掉。此操作不可撤销。')) {
      return;
    }

    var at = s0.cursor;

    Store.deleteQuestions(item.bankId, [item.q.id]).then(function (res) {
      if (!res.removed) { toast('删除失败：题库里没找到这道题', true); return; }

      var dropped = afterDelete(res);

      renderBankSelect();
      refreshSubjectOptions();
      rebuildSession();      // 里面会 renderAll 一次

      // 光标停在原位（后面那道顶上来了），删的是最后一道就退一格
      var s = STATE.session;
      if (s.questions.length) s.cursor = Math.min(at, s.questions.length - 1);
      renderAll();           // 挪好光标再渲染一次

      toast('已删除这道题' +
            (res.emptied ? '，那套题库已空，一并移除' : '') +
            (dropped ? '，连同练习记录' : ''));
    });
  }

  function doSubmit() {
    var s = STATE.session;
    var item = s && s.current();
    if (!item) return;
    var q = item.q;

    var ans = s.getAnswer(q.id);
    var empty = !(ans.keys && ans.keys.length) && !(ans.text || []).some(function (t) { return String(t).trim(); });
    if (empty) { toast('先选个答案再提交', true); return; }

    var result = s.submit(q.id);
    STATE.progress = s.progress;
    renderQuestion();
    renderStats();

    if (result && result.correct && STATE.settings.autoNext && !s.isLast()) {
      setTimeout(function () { doNext(); }, 550);
    }
  }

  function doNext() {
    if (!STATE.session.next()) { toast('已经是最后一题了'); return; }
    renderQuestion(); renderStats();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function doPrev() {
    if (!STATE.session.prev()) return;
    renderQuestion(); renderStats();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function doReveal() {
    var item = STATE.session && STATE.session.current();
    if (!item) return;
    STATE.session.reveal(item.q.id);
    renderQuestion();
  }

  function doStar() {
    var item = STATE.session && STATE.session.current();
    if (!item) return;
    // toggleStar 是就地修改 STATE.progress 并返回该条目，
    // 千万不要 State.progress = Store.loadProgress() —— 落盘是防抖的，会读到旧值。
    var p = Store.toggleStar(STATE.progress, item.q.id);
    renderFootState(item.q, STATE.session.result(item.q.id), STATE.session.isRevealed(item.q.id));
    renderGrid(); renderStats();
    toast(p.starred ? '已加入收藏' : '已取消收藏');
  }

  /** 重做本题：清掉本次会话里的作答，选项回到可点状态 */
  function doRedo() {
    var s = STATE.session;
    var item = s && s.current();
    if (!item) return;
    delete s.results[item.q.id];
    s.answers[item.q.id] = { keys: [], text: [] };
    delete s.revealed[item.q.id];
    renderQuestion();
    toast('已重置本题，可以重新作答');
  }

  /* ================================================================== *
   * 导入 / 导出
   * ================================================================== */

  function runImport(text) {
    var parsed;
    try {
      parsed = Importer.parse(text);
    } catch (e) {
      showImportReport('解析失败：' + e.message, true);
      return;
    }

    // 导入时可以顺手指定学科。
    // 导入的题库通常没有课程名，不指定的话会全部堆进「未分类」，
    // 事后想分开就只能一套一套去归类。
    var wanted = String(($('importSubject') || {}).value || '').trim();
    var wantedTitle = String(($('importTitle') || {}).value || '').trim();

    // 题库名只在「本次只导入一套」时生效 ——
    // 一次导入多套还硬套同一个名字，会把这批题库全改成一样，反而更乱
    if (wantedTitle && parsed.banks.length === 1) {
      parsed.banks[0].workTitle = wantedTitle;
    }

    Store.importBankPayload({ banks: parsed.banks }, STATE.banks).then(function (res) {
      STATE.banks = res.banks;
      var r = res.report;

      return applySubjectToBanks(res.banks, r.bankIds, wanted).then(function () {
        var msg = '导入完成：' + r.banks + ' 套题库，新增 ' + r.added + ' 题' +
                  (r.updated ? '，更新 ' + r.updated + ' 题' : '') + '。' +
                  (wanted ? ' 已归入学科「' + wanted + '」。' : '') +
                  (wantedTitle && parsed.banks.length === 1 ? ' 题库名：「' + wantedTitle + '」。' : '');
        var warns = parsed.warnings || [];
        showImportReport(msg + (warns.length ? '\n' + warns.join('\n') : ''), false, warns);

        renderBankSelect();
        STATE.filter.bankIds = [];
        STATE.filter.chapter = '';
        rebuildSession();

        if ($('importSubject')) $('importSubject').value = '';
        if ($('importTitle')) $('importTitle').value = '';
        if (r.added || r.updated) setTimeout(closeModals, 900);
      });
    });
  }

  /** 把一批题库挂到指定学科名下（写映射表，不动题库本身） */
  function applySubjectToBanks(banks, bankIds, subjectName) {
    if (!subjectName) return Promise.resolve(null);

    var keys = (bankIds || []).map(function (id) {
      return CQB.subjectKeyOf(banks[id]);
    }).filter(Boolean);

    if (!keys.length) return Promise.resolve(null);

    return Store.renameSubject({ keys: keys }, subjectName).then(function (map) {
      STATE.subjects = map;
      return map;
    });
  }

  function showImportReport(msg, isErr, warns) {
    var el = $('importReport');
    el.className = 'import-report' + (isErr ? '' : '');
    el.style.background = isErr ? 'var(--bad-soft)' : 'var(--ok-soft)';
    el.style.borderLeftColor = isErr ? 'var(--bad)' : 'var(--ok)';
    el.innerHTML = escapeHtml(msg).replace(/\n/g, '<br>') +
      (warns && warns.length ? '<div class="warn">' + warns.map(escapeHtml).join('<br>') + '</div>' : '');
    el.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------ *
   * 导出 PDF
   *
   * 为什么走 window.print() 而不是直接吐出 .pdf 文件：
   * 手写 PDF 必须嵌入中文字体，一套 CJK 字体动辄 5–15MB；MV3 扩展又禁止
   * 远程加载代码，塞不进第三方 PDF 库。浏览器自带的打印引擎本来就有完整
   * 的中文字体和图片支持，让它排版最省事也最可靠 —— 用户在打印窗口里
   * 把目标选成「另存为 PDF」就得到文件了。
   * ------------------------------------------------------------------ */

  var PRINT_ID = 'cqbPrint';

  function pdfOptions() {
    var box = function (id, dflt) {
      var el = $(id);
      return el ? el.checked : dflt;
    };
    return {
      scope: ($('pdfScope') || {}).value || 'current',
      answer: box('pdfAnswer', true),
      analysis: box('pdfAnalysis', true),
      group: box('pdfGroup', true),
      onlyNoAnswer: box('pdfOnlyNoAnswer', false)
    };
  }

  function openPdf() {
    if (!Object.keys(STATE.banks).length) { toast('还没有题库', true); return; }
    var rep = $('pdfReport');
    if (rep) { rep.textContent = ''; rep.classList.add('hidden'); }
    openModal('pdfModal');
  }

  /** 取出要打印的题目。当前筛选结果直接复用会话的池子，口径和屏幕上完全一致 */
  function collectForPrint(opts) {
    var items;

    if (opts.scope === 'all') {
      items = [];
      Object.keys(STATE.banks).forEach(function (id) {
        var b = STATE.banks[id];
        (b.questions || []).forEach(function (q) {
          items.push({
            q: q,
            bankId: id,
            bankTitle: b.workTitle || b.courseName || id,
            subject: CQB.subjectNameOf(b, STATE.subjects)
          });
        });
      });
    } else {
      items = (STATE.session ? STATE.session.questions : []).slice();
    }

    if (opts.onlyNoAnswer) {
      items = items.filter(function (it) { return it.q && !it.q.hasAnswer; });
    }
    return items;
  }

  /** 按 学科 → 题库 两层归拢，保持原有顺序 */
  function groupForPrint(items, opts) {
    var sections = [];
    var index = {};

    items.forEach(function (it) {
      var subj = opts.group ? (it.subject || CQB.UNCLASSIFIED) : '';
      var bank = opts.group ? (it.bankTitle || '未命名题库') : '';
      var sk = subj + '\u0000' + bank;

      if (!index[sk]) {
        var sec = index['\u0000' + subj];
        if (!sec) {
          sec = { subject: subj, banks: [], _bankIndex: {} };
          index['\u0000' + subj] = sec;
          sections.push(sec);
        }
        var bk = { title: bank, questions: [] };
        sec.banks.push(bk);
        index[sk] = bk;
      }
      index[sk].questions.push(it);
    });

    return sections;
  }

  /** 题干/选项/解析可能是富文本（带图和公式），走和屏幕上同一套清洗 */
  function richForPrint(s, origin) {
    var raw = String(s == null ? '' : s);
    if (raw && RICH_TAG_RE.test(raw)) {
      try { return sanitizeHtml(raw, origin || ''); } catch (e) { /* 退回纯文本 */ }
    }
    return escapeHtml(raw).replace(/\n/g, '<br>');
  }

  function buildPrintHtml(opts) {
    var items = collectForPrint(opts);
    if (!items.length) return { html: '', count: 0 };

    var now = new Date();
    var stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
                ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

    var html = '<div class="p-head">' +
      '<h1>' + (opts.scope === 'all' ? '题库全集' : '题库 · 当前筛选') + '</h1>' +
      '<p>' + items.length + ' 道题　·　导出于 ' + stamp +
        (opts.answer ? '' : '　·　不含答案') + '</p>' +
      '</div>';

    var n = 0;

    groupForPrint(items, opts).forEach(function (sec) {
      if (sec.subject) {
        html += '<h2 class="p-subject">' + escapeHtml(sec.subject) + '</h2>';
      }
      sec.banks.forEach(function (bank) {
        if (bank.title) html += '<h3 class="p-bank">' + escapeHtml(bank.title) + '</h3>';
        bank.questions.forEach(function (it) {
          n++;
          html += questionPrintHtml(it.q, n, opts);
        });
      });
    });

    return { html: html, count: items.length };
  }

  function questionPrintHtml(q, n, opts) {
    var origin = '';
    try { origin = CQB.getOrigin(q.sourceUrl || ''); } catch (e) { origin = ''; }

    var h = '<div class="p-q">';

    h += '<div class="p-stem"><span class="p-no">' + n + '.</span>' +
         '<span class="p-type">' + escapeHtml(CQB.TYPE_LABEL[q.type] || '题目') + '</span>' +
         richForPrint(q.stem, origin) + '</div>';

    if (q.options && q.options.length) {
      h += '<ul class="p-opts">';
      q.options.forEach(function (o) {
        h += '<li><b>' + escapeHtml(o.key || '') + '.</b>' + richForPrint(o.text, origin) + '</li>';
      });
      h += '</ul>';
    }

    if (opts.answer) {
      var ans = q.hasAnswer ? formatAnswer(q, q.answer) : '';
      h += '<div class="p-ans">答案：<b>' + (ans ? escapeHtml(ans) : '（未公布）') + '</b></div>';
    }

    if (opts.analysis && q.analysis) {
      h += '<div class="p-ana">解析：' + richForPrint(q.analysis, origin) + '</div>';
    }

    h += '</div>';
    return h;
  }

  function showPdfReport(msg, isErr) {
    var el = $('pdfReport');
    if (!el) return;
    el.className = 'import-report';
    el.style.background = isErr ? 'var(--bad-soft)' : 'var(--ok-soft)';
    el.style.borderLeftColor = isErr ? 'var(--bad)' : 'var(--ok)';
    el.textContent = msg;
  }

  function doExportPdf() {
    var opts = pdfOptions();
    var rep = $('pdfReport');

    if (rep) { rep.textContent = ''; rep.classList.add('hidden'); }

    var built = buildPrintHtml(opts);
    if (!built.count) {
      showPdfReport('这个范围里没有题目' +
        (opts.onlyNoAnswer ? '（「只导出答案未公布的题」把它们全过滤掉了）' : '') +
        '。换个范围或取消勾选再试。', true);
      return;
    }

    var boxEl = $(PRINT_ID);
    if (!boxEl) { showPdfReport('页面里找不到打印容器，刷新一下再试', true); return; }

    boxEl.innerHTML = built.html;

    // 打印对话框默认拿 document.title 当文件名，借它把文件名定好
    var prevTitle = document.title;
    var t = new Date();
    var stamp = String(t.getFullYear()) + pad(t.getMonth() + 1) + pad(t.getDate()) +
                '-' + pad(t.getHours()) + pad(t.getMinutes());
    document.title = '题库-' + (opts.scope === 'all' ? '全部' : '筛选') +
                     '-' + built.count + '题-' + stamp;

    var cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      document.title = prevTitle;
      boxEl.innerHTML = '';
      closeModals();
    }

    var fired = false;
    function fire() {
      if (fired) return;
      fired = true;
      try {
        window.print();
      } catch (e) {
        showPdfReport('调用打印失败：' + e.message, true);
      }
      cleanup();
    }

    // 题干里的图片得先加载完，否则导出的 PDF 上是一片空白
    var imgs = Array.prototype.slice.call(boxEl.querySelectorAll('img'));
    var pending = imgs.length;

    if (!pending) { setTimeout(fire, 60); return; }

    var tick = function () {
      pending--;
      if (pending <= 0) fire();
    };
    imgs.forEach(function (img) {
      if (img.complete) { tick(); return; }
      img.addEventListener('load', tick, { once: true });
      img.addEventListener('error', tick, { once: true });
    });

    setTimeout(fire, 4000);   // 图片卡住也得让用户拿到东西
  }

  function doExport() {
    var payload = CQB.buildExport(STATE.banks);
    if (!payload.stats.questions) { toast('还没有题目可以导出', true); return; }
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'chaoxing-bank-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出 ' + payload.stats.questions + ' 道题');
  }

  /* ================================================================== *
   * 弹窗
   * ================================================================== */

  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModals() { document.querySelectorAll('.modal').forEach(function (m) { m.classList.add('hidden'); }); }

  /* ================================================================== *
   * 事件绑定
   * ================================================================== */

  function bind() {
    // ---- 顶栏 ----
    $('bankSelect').onchange = function () {
      var v = this.value;
      STATE.filter.bankIds = v === '__all__' ? [] : [v];
      STATE.filter.chapter = '';
      STATE.filter.types = [];
      rebuildSession();
    };

    $('modeSwitch').querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        $('modeSwitch').querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        STATE.mode = b.getAttribute('data-mode');
        rebuildSession();
        toast(STATE.mode === 'random' ? '已切换为随机练习，本次顺序已重新洗牌'
             : STATE.mode === 'recite' ? '背题模式：答案直接显示，不判分'
             : '已切换为顺序练习');
      };
    });

    $('statusFilter').querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        $('statusFilter').querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        STATE.filter.status = b.getAttribute('data-status');
        rebuildSession();
      };
    });

    // ---- 学科 ----
    // 学科支持多选：点一下选中，再点一下取消。
    // 「同时练高数和英语」是很自然的需求，逼着人一次只看一门太蠢。
    $('subjectFilter').onclick = function (e) {
      var btn = e.target.closest('button[data-subject]');
      if (!btn || !this.contains(btn)) return;

      var name = btn.getAttribute('data-subject');
      var cur = STATE.filter.subjects.slice();

      if (!name) {
        cur = [];                               // 点「全部」= 清空
      } else {
        var i = cur.indexOf(name);
        if (i >= 0) cur.splice(i, 1);           // 已选中 → 取消
        else cur.push(name);                    // 未选中 → 加上
      }

      STATE.filter.subjects = cur;

      // 题库选择要重置：它可能指向一个已经不在范围内的题库
      STATE.filter.bankIds = [];
      renderBankSelect();
      rebuildSession();     // 里面会顺手清掉失效的题型/章节选择
    };

    $('btnRenameSubject').onclick = doRenameSubject;
    $('btnOrganize').onclick = openOrganize;
    $('btnOrganizeSave').onclick = saveOrganize;
    $('btnOrganizeBulk').onclick = organizeBulkApply;

    if ($('organizeSearch')) {
      $('organizeSearch').oninput = function () { renderOrganize(this.value); };
    }

    if ($('organizeCheckAll')) {
      $('organizeCheckAll').onchange = function () {
        var on = this.checked;
        qa('#organizeList .organize-check').forEach(function (c) { c.checked = on; });
        updateOrganizeCount();
      };
    }

    $('btnPdf').onclick = openPdf;
    $('btnDoPdf').onclick = doExportPdf;
    $('btnDeleteQ').onclick = doDeleteCurrent;

    if ($('btnOrganizeDelete')) {
      $('btnOrganizeDelete').onclick = function () {
        var ids = qa('#organizeList .organize-check')
          .filter(function (c) { return c.checked; })
          .map(function (c) { return c.getAttribute('data-bank'); });

        if (!ids.length) { toast('先勾选要删除的题库', true); return; }
        doDeleteBanks(ids);
      };
    }

    $('btnImport').onclick = function () { openModal('importModal'); };
    $('btnImport2').onclick = function () { openModal('importModal'); };

    $('btnSample').onclick = function () {
      var sample = window.CQB_SAMPLE_BANKS;
      if (!sample || !sample.length) { toast('示例数据缺失', true); return; }
      Store.importBankPayload({ banks: sample }, STATE.banks).then(function (res) {
        STATE.banks = res.banks;
        renderBankSelect();
        STATE.filter.bankIds = [];
        STATE.filter.chapter = '';
        STATE.filter.types = [];
        STATE.filter.status = 'all';
        $('statusFilter').querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-status') === 'all');
        });
        rebuildSession();
        toast('示例题库已载入：' + res.report.added + ' 道题，可以直接开始练习');
      });
    };
    $('btnExport').onclick = doExport;
    $('btnSettings').onclick = function () { openModal('settingsModal'); };

    $('btnTheme').onclick = function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      STATE.settings.theme = next;
      Store.saveSettings(STATE.settings);
    };

    // ---- 题目操作 ----
    $('btnSubmit').onclick = function () {
      if ($('btnSubmit').dataset.mode === 'redo') doRedo();
      else doSubmit();
    };
    $('btnNext').onclick = doNext;
    $('btnPrev').onclick = doPrev;
    $('btnReveal').onclick = doReveal;
    $('btnStar').onclick = doStar;

    // ---- 弹窗关闭 ----
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) closeModals(); });
    });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.onclick = closeModals;
    });

    // ---- 导入 ----
    var dz = $('dropZone');
    var fi = $('fileInput');
    dz.onclick = function () { fi.click(); };
    dz.ondragover = function (e) { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = function () { dz.classList.remove('over'); };
    dz.ondrop = function (e) {
      e.preventDefault(); dz.classList.remove('over');
      var f = e.dataTransfer.files[0];
      if (f) readFile(f);
    };
    fi.onchange = function () { if (fi.files[0]) readFile(fi.files[0]); };

    $('btnDoImport').onclick = function () {
      var t = $('pasteArea').value.trim();
      if (!t) { toast('先选择文件或粘贴内容', true); return; }
      runImport(t);
    };

    $('btnClearBanks').onclick = function () {
      var qn = 0;
      Object.keys(STATE.banks).forEach(function (id) {
        qn += (STATE.banks[id].questions || []).length;
      });

      // 题库清空了，练习进度就彻底没有归属了，留着纯属占地方 —— 一起清掉
      if (!confirm('清空全部题库？\n\n' + qn + ' 道题，以及它们的练习记录' +
          '（作答 / 错题本 / 收藏）都会一起清掉。\n\n此操作不可撤销。')) return;

      Store.clearBanks().then(function () {
        STATE.banks = {};
        STATE.progress = {};
        Store.resetProgress();
        renderBankSelect(); rebuildSession();
        closeModals();
        toast('题库和练习进度都已清空');
      });
    };

    // ---- 设置 ----
    var map = {
      setShowAnswer: 'showAnswerImmediately',
      setAutoNext: 'autoNext',
      setShuffleOptions: 'shuffleOptions',
      setKeepWrong: 'keepWrongAfterCorrect',
      setOnlyAnswer: 'skipNoAnswer'
    };
    Object.keys(map).forEach(function (id) {
      var el = $(id);
      var key = map[id];
      el.checked = !!STATE.settings[key];
      el.onchange = function () {
        STATE.settings[key] = el.checked;
        Store.saveSettings(STATE.settings);
        if (key === 'skipNoAnswer') rebuildSession();
        else renderQuestion();
      };
    });

    $('btnResetProgress').onclick = function () {
      if (!confirm('确定清空练习进度（做题记录 / 错题本 / 收藏）吗？')) return;
      Store.resetProgress();
      STATE.progress = Store.loadProgress();
      STATE.session.progress = STATE.progress;
      STATE.session.results = {};
      STATE.session.answers = {};
      STATE.session.revealed = {};
      renderAll();
      closeModals();
      toast('练习进度已清空');
    };

    // ---- 键盘 ----
    document.addEventListener('keydown', onKey);

    // ---- 题库变化（扩展页面里，content script 抓到新题会实时推过来）----
    Store.onBanksChanged(function (banks) {
      STATE.banks = banks;
      var curQid = STATE.session && STATE.session.current() ? STATE.session.current().q.id : null;
      renderBankSelect();
      rebuildSession(curQid);
      toast('题库已更新');
    });

    // 另一个标签页改了学科名，这边要跟着刷新
    if (Store.onSubjectsChanged) {
      Store.onSubjectsChanged(function (map) {
        STATE.subjects = map || {};
        renderBankSelect();
        rebuildSession();
      });
    }
  }

  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () { runImport(String(reader.result)); };
    reader.onerror = function () { showImportReport('文件读取失败', true); };
    reader.readAsText(file, 'utf-8');
  }

  function onKey(e) {
    // 正在输入框里打字时不劫持快捷键，只放行 Ctrl/Cmd+Enter
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && tag === 'input') { /* 填空题自己处理 */ }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!$('importModal').classList.contains('hidden')) {
      if (e.key === 'Escape') closeModals();
      return;
    }
    if (!$('settingsModal').classList.contains('hidden')) {
      if (e.key === 'Escape') closeModals();
      return;
    }

    var item = STATE.session && STATE.session.current();
    if (!item) return;
    var q = STATE.current || item.q;
    var key = e.key;

    if (key === 'Enter') {
      e.preventDefault();
      if (STATE.session.isSubmitted(q.id)) doNext(); else doSubmit();
      return;
    }
    if (key === 'ArrowRight' || key === 'n') { e.preventDefault(); doNext(); return; }
    if (key === 'ArrowLeft'  || key === 'p') { e.preventDefault(); doPrev(); return; }
    if (key === ' ' || key === 'Spacebar') { e.preventDefault(); doReveal(); return; }
    if (key === 'f' || key === 'F') { e.preventDefault(); doStar(); return; }
    if (key === 'r' || key === 'R') { e.preventDefault(); doRedo(); return; }

    // 选项快捷键：A-H 或 1-8
    var ch = key.toUpperCase();
    if (/^[A-H]$/.test(ch)) { pickByKey(ch); return; }
    if (/^[1-8]$/.test(key)) {
      var idx = Number(key) - 1;
      var opt = (q.options || [])[idx];
      if (opt) pickByKey(opt.key);
    }
  }

  function pickByKey(k) {
    var item = STATE.session && STATE.session.current();
    if (!item) return;
    var q = STATE.current || item.q;
    if (STATE.session.isSubmitted(q.id)) return;
    var exists = (q.options || []).some(function (o) { return o.key === k; });
    if (!exists) return;

    var cur = STATE.session.getAnswer(q.id);
    if (q.type === 'multiple') {
      var keys = (cur.keys || []).slice();
      var i = keys.indexOf(k);
      if (i >= 0) keys.splice(i, 1); else keys.push(k);
      cur.keys = keys.sort();
    } else {
      cur.keys = [k];
    }
    STATE.session.setAnswer(q.id, cur);
    renderQuestion();
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */

  function boot() {
    // 顶部环境标识
    $('envBadge').textContent = Store.IN_EXTENSION ? '扩展模式 · 与抓取实时同步' : '本地模式 · 需手动导入';

    bind();

    // URL 参数：?bank=xxx 直接定位某个题库（扩展弹窗「打开刷题」会带这个参数）
    var params = new URLSearchParams(location.search);
    var wantBank = params.get('bank');
    var wantStatus = params.get('status');

    reloadBanks().then(function () {
      if (wantBank && STATE.banks[wantBank]) {
        STATE.filter.bankIds = [wantBank];
        $('bankSelect').value = wantBank;
      }
      if (wantStatus) {
        STATE.filter.status = wantStatus;
        $('statusFilter').querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-status') === wantStatus);
        });
      }
      rebuildSession();
    });

    // 每 30 秒把内存里的进度落一次盘，防页面被直接关掉丢失
    setInterval(function () { Store.saveProgress(STATE.progress); }, 30000);
    window.addEventListener('beforeunload', function () { Store.saveProgress(STATE.progress); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
