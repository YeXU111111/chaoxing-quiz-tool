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

  /** 重建练习序列（筛选条件或题库变化时调用） */
  function rebuildSession(keepQid) {
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
    var html = '<button class="chip' + (STATE.filter.subjects.length ? '' : ' active') +
               '" data-subject="">全部 ' + total + '</button>';

    groups.forEach(function (g) {
      var active = STATE.filter.subjects.indexOf(g.name) >= 0 ? ' active' : '';
      var muted = g.name === CQB.UNCLASSIFIED ? ' chip-muted' : '';
      var tip = g.courseIds.length ? ('课程 ID：' + g.courseIds.join('、')) : '这些题库没抓到课程 ID';
      html += '<button class="chip' + active + muted + '" data-subject="' + escapeHtml(g.name) + '"' +
              ' title="' + escapeHtml(g.name + '　' + tip) + '">' +
              escapeHtml(g.name) + ' ' + g.questions + '</button>';
    });

    box.innerHTML = html;

    // 改名按钮只在选中了单个学科时可用
    var renameBtn = $('btnRenameSubject');
    if (renameBtn) {
      var renameable = selectedSubjectGroups(groups);
      renameBtn.disabled = !renameable;
      renameBtn.title = renameable
        ? '把「' + renameable[0].name + '」改名'
        : '先在左边选中一个学科（只选中一个时才能改名）';
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

  function renderFilters() {
    // 题型 chips：只显示当前题库里真实存在的题型
    var typeCount = {};
    Object.keys(STATE.banks).forEach(function (id) {
      if (STATE.filter.bankIds.length && STATE.filter.bankIds.indexOf(id) < 0) return;
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
    Object.keys(STATE.banks).forEach(function (id) {
      if (STATE.filter.bankIds.length && STATE.filter.bankIds.indexOf(id) < 0) return;
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

    // 全局错题数（跨当前筛选，看的是整个题库）
    var wrongAll = 0;
    Object.keys(STATE.banks).forEach(function (id) {
      STATE.banks[id].questions.forEach(function (q) {
        var p = STATE.progress[q.id];
        if (p && p.wrongBooked) wrongAll++;
      });
    });
    $('statWrong').textContent = wrongAll;
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
      subjTag.textContent = item.subject || '';
      // 只有「未分类」才需要在卡片上提醒，正常学科名不用占地方
      subjTag.style.display = (item.subject && item.subject !== CQB.UNCLASSIFIED) ? '' : 'none';
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

  function openOrganize() {
    if (!Object.keys(STATE.banks).length) { toast('还没有题库', true); return; }
    if ($('organizeSearch')) $('organizeSearch').value = '';
    if ($('organizeBulk')) $('organizeBulk').value = '';
    renderOrganize('');
    openModal('organizeModal');
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
        '<div class="organize-name" title="' + escapeHtml(title) + '">' +
          '<b>' + escapeHtml(title) + '</b>' +
          '<small>' + (b.questions || []).length + ' 题' +
            (b.courseId ? ' · 课程 ID ' + escapeHtml(b.courseId) : ' · 无课程 ID') +
          '</small>' +
        '</div>' +
        '<input type="text" class="organize-input" data-bank="' + escapeHtml(id) + '"' +
          ' list="subjectOptions" placeholder="未分类"' +
          ' value="' + escapeHtml(subj === CQB.UNCLASSIFIED ? '' : subj) + '">' +
      '</div>';
    });

    box.innerHTML = shown ? html : '<p class="hint">没有匹配的题库</p>';
  }

  function organizeBulkApply() {
    var name = String(($('organizeBulk') || {}).value || '').trim();
    if (!name) { toast('先填一个学科名', true); return; }

    var n = 0;
    qa('#organizeList .organize-input').forEach(function (inp) {
      inp.value = name;
      n++;
    });
    toast(n ? ('已把 ' + n + ' 套题库都填成「' + name + '」，记得保存') : '列表里没有题库');
  }

  function saveOrganize() {
    var inputs = qa('#organizeList .organize-input');
    if (!inputs.length) { closeModals(); return; }

    var next = Object.assign({}, STATE.subjects);
    var changed = 0;

    inputs.forEach(function (inp) {
      var b = STATE.banks[inp.getAttribute('data-bank')];
      if (!b) return;
      var key = CQB.subjectKeyOf(b);
      if (!key) return;

      var name = String(inp.value || '').trim();
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
    $('subjectFilter').onclick = function (e) {
      var btn = e.target.closest('button[data-subject]');
      if (!btn || !this.contains(btn)) return;

      var name = btn.getAttribute('data-subject');
      STATE.filter.subjects = name ? [name] : [];

      // 换学科要把题库选择一起重置，否则会留着上一个学科的题库 id，
      // 两个筛选条件互相矛盾，池子直接空掉
      STATE.filter.bankIds = [];
      STATE.filter.chapter = '';
      STATE.filter.types = [];
      renderBankSelect();
      rebuildSession();
    };

    $('btnRenameSubject').onclick = doRenameSubject;
    $('btnOrganize').onclick = openOrganize;
    $('btnOrganizeSave').onclick = saveOrganize;
    $('btnOrganizeBulk').onclick = organizeBulkApply;

    if ($('organizeSearch')) {
      $('organizeSearch').oninput = function () { renderOrganize(this.value); };
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
      if (!confirm('确定清空全部题库吗？此操作不可撤销（练习进度不受影响）。')) return;
      Store.clearBanks().then(function () {
        STATE.banks = {};
        renderBankSelect(); rebuildSession();
        closeModals();
        toast('题库已清空');
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
