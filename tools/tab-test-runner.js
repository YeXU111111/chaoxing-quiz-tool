/*!
 * tab-test-runner.js —— 「自动打开章节测验标签」的回归测试
 *
 * 注入到 tools/fixtures/chapter-page.html 里跑，四种模式：
 *   chapter  章节页停在视频标签，没有题目  → 应该自动切到章节测验、抓完、再切回视频
 *   already  章节测验已经开着（有题目）    → 一次都不该点
 *   notabs   没有标签栏，只有目录树诱饵    → findQuizTab() 必须返回 null，绝不能乱点
 *   off      用户关掉了「自动开标签」      → 一次都不该点
 *
 * 最要命的风险是「点错东西」：超星左侧目录树里每个章节都挂着一个「章节测验」，
 * 点中它就跳到别的章节去了。所以这里专门有一组针对误点的断言。
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
    var sa, sb;
    try { sa = JSON.stringify(a); sb = JSON.stringify(b); } catch (e) { sa = String(a); sb = String(b); }
    ok(sa === sb, name, sa === sb ? '' : '期望 ' + sb + '，实际 ' + sa);
  }
  function section(t) { R.push('# ' + t); }

  var errors = [];
  window.addEventListener('error', function (e) { errors.push(e.message || String(e.error)); });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push('unhandled rejection: ' + (e.reason && e.reason.message || e.reason));
  });

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** 被点到的元素是不是目录树里那个诱饵 */
  function inToc(el) {
    var n = el;
    for (var i = 0; i < 5 && n; i++) {
      if (n.classList && n.classList.contains('toc-item')) return true;
      n = n.parentElement;
    }
    return false;
  }

  async function run() {
    var MODE = window.__MODE || 'chapter';
    var X = window.CQBExtractor;
    var log = window.__log || [];

    /* ---------------- 环境 ---------------- */
    section('环境检查（mode=' + MODE + '）');
    ok(!!X && typeof X.findQuizTab === 'function', 'extractor.js 已加载');
    ok(typeof X.findTabByText === 'function', 'findTabByText 已导出');
    ok(typeof X.sameTabBar === 'function', 'sameTabBar 已导出');
    ok(!!window.chrome && Array.isArray(window.__sent), 'chrome API 桩已就位');

    /* ---------------- 标签识别（纯函数，先测） ---------------- */
    section('标签识别');

    var tabs = document.querySelectorAll('.tabbar .tab');
    eq(tabs.length, 2, '标签栏里有 2 个标签');

    // 页面上的诱饵数量要先确认，否则后面的断言没有意义
    var decoys = document.querySelectorAll('.toc-item a');
    ok(decoys.length >= 3, '目录树里放了 ' + decoys.length + ' 个诱饵条目');

    var found = X.findQuizTab();
    var vt = document.getElementById('tab-video');
    var qt = document.getElementById('tab-quiz');

    if (MODE === 'notabs') {
      eq(found, null, '★ 没有标签栏时 findQuizTab() 返回 null（不会去点目录树）');

      // 双重确认：目录树里的诱饵确实存在且可点，只是被正确排除了
      var clickableDecoys = 0;
      Array.prototype.forEach.call(decoys, function (d) {
        var r = d.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) clickableDecoys++;
      });
      ok(clickableDecoys >= 3,
         '目录里的 ' + clickableDecoys + ' 个诱饵确实是可见可点的，排除是有意义的');

    } else if (MODE === 'already') {
      // 章节测验已经是当前标签 —— 没有「可切换过去」的目标，应当返回 null。
      // 返回非 null 的话，自动流程会去点一个已经打开的标签，纯属多余动作。
      eq(found, null, '★ 章节测验已是当前标签时，findQuizTab() 返回 null');
      ok(X.isActiveTab(qt), '章节测验标签为激活态');
      ok(!X.isActiveTab(vt), '视频标签非激活态');

    } else {
      ok(!!found, 'findQuizTab() 找到了章节测验标签');
      if (found) {
        eq(found.el.id, 'tab-quiz', '★ 命中的是标签栏里的「2 章节测验」，不是目录树诱饵');
        ok(!inToc(found.el), '★ 命中元素不在目录树里');
        eq(found.label, '2 章节测验', '标签文案正确');
        eq(found.backTo.id, 'tab-video', '记录了要切回去的那个标签');
        eq(found.backLabel, '1 视频', '原标签文案正确');
        eq(found.distance, 0, '距离视频标签 0 层，置信度最高');
      }
      ok(X.isActiveTab(vt), '视频标签初始为激活态');
      ok(!X.isActiveTab(qt), '章节测验标签非激活态');
    }

    // 同一标签栏判定：这组断言与模式无关，是最核心的防误点逻辑
    ok(X.sameTabBar(vt, qt), '「视频」和「章节测验」判定为同一标签栏');
    ok(!X.sameTabBar(vt, decoys[0]), '★ 目录树诱饵判定为不同标签栏');

    // 按文案找回标签
    if (MODE === 'chapter' || MODE === 'already') {
      var back = X.findTabByText('1 视频');
      ok(!!back && back.id === 'tab-video', 'findTabByText 能按文案找回视频标签');
    }

    /* ---------------- 端到端：连续采集本章 ---------------- */
    if (MODE === 'chain') {
      section('连续采集本章');

      // 面板上有「连续采集本章」按钮，点它发车
      await sleep(2000);
      var chainBtn = document.getElementById('cqb-chain');
      ok(!!chainBtn, '面板上有「连续采集本章」按钮');
      if (chainBtn) chainBtn.click();

      // 三节要逐节跑：每节 = 开标签 + 抓取 + 4 秒间隔。
      // 虚拟时钟下这些都是瞬间的，等足轮次再断言。
      await sleep(40000);

      var clog = window.__log || [];
      var nextClicks = clog.filter(function (x) { return x === 'click:next'; }).length;
      var blocked = clog.filter(function (x) { return x === 'next:blocked'; }).length;

      eq(clog.filter(function (x) { return x.indexOf('render:') === 0; }).join(','),
         'render:s1,render:s2,render:s3', '依次渲染了 3 个小节');

      eq(nextClicks, 2, '★ 点了 2 次「下一节」：从 s1 到 s2、从 s2 到 s3');
      eq(blocked, 0, '★ 没有点最后那个「下一章」——不跨章');

      eq(window.__captures, 2, '★ 只有两节有测验，CAPTURE 恰好 2 次（没重复、没漏）');
      eq(window.__capturedQuestions, 5, '★ 抓到 3 + 2 = 5 道题，数量对得上');

      eq(clog.filter(function (x) { return x === 'click:video'; }).length, 0,
         '★ 连续采集期间没有切回过视频标签（方向是往前走）');

      eq(clog.filter(function (x) { return x === 'click:quiz'; }).length, 2,
         '两节各自动打开了一次「章节测验」标签');

      var status = document.getElementById('cqb-status');
      ok(true, '面板状态：' + (status ? status.textContent : '(无)'));

      /* ---------- 停止按钮必须无条件复位面板 ---------- */
      section('停止按钮');

      var panel = document.getElementById('cqb-root');
      var stopBtn = document.getElementById('cqb-stop');

      ok(!!panel && !!stopBtn, '面板与停止按钮都在');

      /*
       * 伪造用户遇到的那个状态：任务早就结束了（撞到上限、最后一节、
       * 或者收尾消息丢了），但面板还卡在「进行中」、停止按钮还挂着。
       *
       * 原来的代码在这种情况下点停止是**纹丝不动**的 ——
       * stopChapterHarvest 在第一行发现「没在跑」就直接 return，
       * 把后面的界面复位一起跳过了。
       */
      panel.classList.add('busy');
      stopBtn.classList.remove('cqb-hidden');
      if (status) status.textContent = '连续采集中…';

      ok(panel.classList.contains('busy') && !stopBtn.classList.contains('cqb-hidden'),
         '已把面板伪造成「卡在进行中」的状态');

      stopBtn.click();

      ok(!panel.classList.contains('busy'),
         '★ 点停止后面板复位了（修复前这里纹丝不动）');
      ok(stopBtn.classList.contains('cqb-hidden'),
         '★ 停止按钮自己隐藏了');
      ok(status && status.textContent === '就绪',
         '★ 状态文案回到「就绪」，实际是「' + (status ? status.textContent : '?') + '」');

      var pageBtn = document.getElementById('cqb-page');
      var chainBtn = document.getElementById('cqb-chain');
      ok(pageBtn && !pageBtn.classList.contains('cqb-hidden'), '翻页抓取按钮恢复可用');
      ok(chainBtn && !chainBtn.classList.contains('cqb-hidden'), '连续采集按钮恢复可用');

      /* ---------- 「整卷翻页抓取」不能被 pagingActive 卡死 ---------- */
      section('整卷抓取按钮不会被卡死');

      // 桩对 AUTOPAGE 返回 {ok:true} 但没有 started —— 正好模拟
      // 「这个页面上没有下一题按钮」这条最常见的路径（单页作业、章节测验）。
      var countAutoPage = function () {
        return (window.__sent || []).filter(function (t) { return t === 'AUTOPAGE'; }).length;
      };

      var before = countAutoPage();
      pageBtn.click();
      await sleep(250);
      var mid = countAutoPage();
      ok(mid - before === 1, '第一次点「整卷翻页抓取」发出了请求');

      pageBtn.click();
      await sleep(250);
      var after = countAutoPage();

      /*
       * 这里曾经有个回归：pagingActive 这个防重复点击的闸门
       * 只在「成功发车」和「抛异常」两条路径上被清零，
       * 而「没有下一题按钮」这条常见路径漏掉了 —— 闸门永远关着，
       * 之后每次点这个按钮都被静默吞掉，连错误提示都没有，只能刷新页面。
       */
      eq(after - before, 2,
         '★ 连点两次都真的发出了请求（修复前第二次会被静默吞掉）');
      ok(!panel.classList.contains('busy'), '两次点击后面板都没有卡在「进行中」');
    }

    /* ---------------- 端到端：自动切换流程 ---------------- */
    section('自动切换流程');

    // content.js 的首次扫描在 1500ms 后，之后还有 MutationObserver 防抖和回切延时，
    // 整条链路跑完大约 6 秒。留足余量再断言。
    if (MODE !== 'chain') await sleep(9000);

    var clickedQuiz = log.indexOf('click:quiz') >= 0;
    var clickedVideo = log.indexOf('click:video') >= 0;
    var captures = window.__captures || 0;
    var sentTypes = window.__sent || [];

    if (MODE === 'chapter') {
      ok(clickedQuiz, '★ 自动点开了「章节测验」标签');
      ok(sentTypes.indexOf('CAPTURE') >= 0, '★ 切换后抓到了题目并发起了保存（CAPTURE）');
      ok(captures > 0, 'CAPTURE 实际发出 ' + captures + ' 次');

      var firstQuiz = log.indexOf('click:quiz');
      var firstVideo = log.indexOf('click:video');
      ok(firstVideo > firstQuiz, '★ 抓完之后切回了「视频」标签（没有把用户晾在测验页）');

      // 防来回弹：切回视频页又会变成「没题目」，不能再次触发切换
      var quizClicks = log.filter(function (x) { return x === 'click:quiz'; }).length;
      eq(quizClicks, 1, '★ 同一个 URL 只自动切换一次，没有来回弹（实际 ' + quizClicks + ' 次）');

      var videoClicks = log.filter(function (x) { return x === 'click:video'; }).length;
      eq(videoClicks, 1, '只切回一次视频标签');

      eq(window.__log.filter(function (x) { return x.indexOf('toc') === 0; }).length, 0,
         '★ 全程没有碰过目录树里的任何条目');

      var last = X.findQuizTab();
      ok(true, '流程结束后页面处于：' + (clickedVideo ? '视频标签' : '未知'));
    }

    if (MODE === 'already') {
      ok(!clickedQuiz, '★ 章节测验已经开着时不会重复点击');
      ok(!clickedVideo, '也没有多余的回切动作');
      eq(sentTypes.indexOf('SCAN_ALL_FRAMES'), -1,
         '★ 本帧就扫到了题目，压根没走跨帧那条路（省掉一次多余的往返）');
      eq(captures, 1, '★ 当前页已有题目 → 直接抓取入库（CAPTURE 1 次）');
    }

    if (MODE === 'notabs') {
      ok(!clickedQuiz, '★ 没有标签栏时一次都没点');
      ok(!clickedVideo, '也没点视频标签');
      eq(captures, 0, '没有产生任何抓取');
    }

    if (MODE === 'off') {
      ok(!clickedQuiz, '★ 用户关掉「自动开标签」后不会自动切换');
      ok(!clickedVideo, '也没有回切动作');
      eq(captures, 0, '没有产生任何抓取');
    }

    /* ---------------- 运行期异常 ---------------- */
    section('运行期异常');
    var real = errors.filter(function (e) { return !/Not implemented|Could not parse CSS/i.test(e); });
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
    setTimeout(function () {
      run().then(finish).catch(function (e) {
        R.push('FAIL 测试脚本异常 :: ' + (e && e.message));
        fail++;
        finish();
      });
    }, 120);
  });
})();
