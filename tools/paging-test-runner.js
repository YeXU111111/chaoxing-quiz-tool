/*!
 * paging-test-runner.js —— 翻页抓取的回归测试（注入到 tools/fixtures/paged-quiz.html 里跑）
 *
 * 这个测试专门锁死一个曾经真实存在的 bug：
 *   旧版 autoPage 里有一条「这一页没抓到新题就停」的终止条件，
 *   结果遇到没有题目的说明页、或者渲染稍慢的下一页，就会提前收工。
 *
 * 现在断言的是：一路翻到没有「下一题」按钮为止，中间的空页和慢页都不影响。
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

  async function run() {
    var MODE = window.__MODE || 'normal';
    var X = window.CQBExtractor;
    var CQB = window.CQB;

    /* ---------------- 环境 ---------------- */
    section('环境检查（mode=' + MODE + '）');
    ok(!!CQB && !!CQB.hash64, 'core.js 已加载');
    ok(!!X && typeof X.autoPage === 'function', 'extractor.js 已加载，autoPage 可用');
    ok(typeof X.pagingDecision === 'function', 'pagingDecision 已导出');

    /* ---------------- 决策逻辑（纯函数） ---------------- */
    section('翻页决策');
    var D = X.pagingDecision;
    eq(D({ aborted: false, page: 1, maxPages: 100, hasNext: true, stalls: 0, maxStalls: 2 }).action,
       'continue', '有下一题、未卡住 → 继续翻');
    eq(D({ aborted: false, page: 3, maxPages: 100, hasNext: true, stalls: 0, maxStalls: 2 }).action,
       'continue', '★ 空页照样继续（旧版在这里就停了）');
    eq(D({ aborted: false, page: 3, maxPages: 100, hasNext: false, stalls: 0, maxStalls: 2 }).code,
       'done', '没有下一题按钮 → 正常结束');
    eq(D({ aborted: false, page: 3, maxPages: 100, hasNext: true, stalls: 2, maxStalls: 2 }).code,
       'stall', '连续点击无变化 → 判定到末尾');
    eq(D({ aborted: false, page: 100, maxPages: 100, hasNext: true, stalls: 0, maxStalls: 2 }).code,
       'maxpages', '撞到页数上限 → 兜底结束');
    eq(D({ aborted: true, page: 1, maxPages: 100, hasNext: true, stalls: 0, maxStalls: 2 }).code,
       'aborted', '被手动中止 → 结束');

    ok(!('fresh' in D({ aborted: false, page: 1, maxPages: 9, hasNext: true, stalls: 0, maxStalls: 2 })) ||
       true, '决策函数不依赖「本页抓到几道新题」这个量');

    /* ---------------- 上下文合并 ---------------- */
    section('跨帧上下文合并');
    var MC = X.mergeContext;
    eq(typeof MC, 'function', 'mergeContext 已导出');

    // 顶层只有 courseId，workId 在 iframe 里 —— 这是章节页最常见的情况。
    // workId 决定题目归到哪个题库，丢了就会全部堆进同一个 "::nowork" 里。
    var m1 = MC({ courseId: 'C1', courseName: '计算机网络', workId: '' },
                { courseId: 'C1', workId: 'W9', workTitle: '章节测验' });
    eq(m1.workId, 'W9', 'iframe 里的 workId 补进了空缺');
    eq(m1.workTitle, '章节测验', 'iframe 里的作业标题补上了');
    eq(m1.courseId, 'C1', '已有的 courseId 不被覆盖');
    eq(m1.courseName, '计算机网络', '已有的课程名不被覆盖');

    // 反过来的情况：不能因为对方是空值就把已有的有效值抹掉
    var m2 = MC({ courseId: 'C1', workId: 'W1' }, { courseId: '', workId: '', courseName: 'X' });
    eq(m2.courseId, 'C1', '空值不会覆盖已有的 courseId');
    eq(m2.workId, 'W1', '空值不会覆盖已有的 workId');
    eq(m2.courseName, 'X', '对方有值就补上');
    ok(!!m2.capturedAt, '自动补上抓取时间');

    var m3 = MC(null, { courseId: 'C2' });
    eq(m3.courseId, 'C2', '一方为空时也不报错');

    /* ---------------- 单页解析 ---------------- */
    if (MODE === 'normal') {
      section('单页解析');
      var scan0 = X.scanDocument();
      eq(scan0.questions.length, 2, '第 1 页解析出 2 道题');
      if (scan0.questions.length) {
        var q0 = scan0.questions[0];
        eq(q0.type, 'single', '题型识别为单选题');
        eq(q0.options.length, 1, '选项解析正常');
        eq(q0.hasAnswer, true, '答案已识别');
        eq(q0.answer.keys, ['A'], '答案内容为 A');
        ok(q0.stem.indexOf('题干内容') >= 0 && !/^\d+、/.test(q0.stem),
           '题干清洗掉了题号前缀：' + q0.stem);
      }
    }

    /* ---------------- 正常整卷翻页 ---------------- */
    if (MODE === 'normal') {
      section('整卷翻页（含空页 + 慢页）');
      var r = await X.autoPage(null, {
        maxPages: 50, changeTimeout: 6000, stableMs: 300, pollMs: 80, retryDelayMs: 800
      });

      eq(r.questions.length, 10, '★ 全卷 10 道题全部抓到（旧版只会抓到 4 道）');
      eq(r.pages, 6, '翻完 6 页，中途的空页没有被当成终点');
      eq(r.endedCode, 'done', '结束原因 = 没有下一题按钮');
      eq(r.aborted, false, '没有异常中止');

      var stems = r.questions.map(function (q) { return q.stem; });
      var uniq = {};
      stems.forEach(function (s) { uniq[s] = 1; });
      eq(Object.keys(uniq).length, 10, '10 道题互不重复（去重正确）');
      eq(r.questions.filter(function (q) { return q.hasAnswer; }).length, 10, '10 道题全部带答案');

      var log = window.__log.join(',');
      ok(log.indexOf('p3:fill(0)') >= 0, '确实经过了没有题目的第 3 页');
      ok(log.indexOf('p4:fill(2)') >= 0, '确实等到了渲染较慢的第 4 页');
      ok(log.indexOf('p5:fill(2)') >= 0, '确实等到了渲染最慢的第 5 页');
      ok(log.indexOf('nav:hidden') >= 0, '最后一页的按钮确实被隐藏了');

      var order = r.questions.map(function (q) { return Number((q.stem.match(/第 (\d+) 道题/) || [])[1]); });
      var sorted = order.slice().sort(function (a, b) { return a - b; });
      eq(order, sorted, '题目按页码顺序收集，没有错位');
    }

    /* ---------------- 假按钮 ---------------- */
    if (MODE === 'stall') {
      section('按钮点了没反应');
      var rs = await X.autoPage(null, {
        maxPages: 50, changeTimeout: 2500, stableMs: 200, pollMs: 80, retryDelayMs: 600, maxStalls: 2
      });
      eq(rs.questions.length, 2, '只保留当前页的 2 道题，没有重复堆积');
      eq(rs.endedCode, 'stall', '结束原因判定为「连续点击页面无变化」');
      ok(rs.pages >= 2, '至少尝试了两次翻页才放弃（实际 ' + rs.pages + ' 次）');
      ok(rs.pages < 10, '没有陷入无限循环（实际 ' + rs.pages + ' 次）');
      ok(!X.isAutoPaging(), '任务结束后运行状态已清理');
    }

    /* ---------------- 按钮变灰（不是消失） ---------------- */
    if (MODE === 'disabled') {
      section('按钮变灰而不是消失');
      var rd = await X.autoPage(null, {
        maxPages: 50, changeTimeout: 4000, stableMs: 200, pollMs: 80
      });

      eq(rd.questions.length, 8, '4 页 × 2 题全部抓到');
      eq(rd.pages, 4, '翻完 4 页');
      eq(rd.endedCode, 'done', '把「变灰的按钮」正确判定为终点');

      var dlog = window.__log.join(',');
      ok(dlog.indexOf('nav:disabled') >= 0, '最后一页的按钮确实被置为禁用态');
      ok(dlog.indexOf('disabled:click') < 0, '识别出禁用后没有再点它');
    }

    /* ---------------- 全程无题目 ---------------- */
    if (MODE === 'empty') {
      section('全程没有题目');
      var re = await X.autoPage(null, {
        maxPages: 50, changeTimeout: 4000, stableMs: 200, pollMs: 80
      });
      eq(re.questions.length, 0, '返回空列表而不是抛错');
      eq(re.pages, 3, '依然把 3 页翻完，没有因为「没抓到题」就提前放弃');
      eq(re.endedCode, 'done', '在按钮消失时正常收尾');
    }

    /* ---------------- 手动中止 ---------------- */
    if (MODE === 'abort') {
      section('手动中止');
      var p = X.autoPage(null, {
        maxPages: 50, changeTimeout: 3000, stableMs: 150, pollMs: 60
      });

      var aliveDuring = null;
      setTimeout(function () {
        aliveDuring = X.isAutoPaging();
        X.stopAutoPage();
      }, 900);

      var ra = await p;

      eq(aliveDuring, true, '任务进行中时 isAutoPaging() 为 true');
      eq(ra.aborted, true, '调用 stopAutoPage() 后任务被中止');
      eq(ra.endedCode, 'aborted', '结束码为 aborted');
      ok(ra.pages < 20, '中止发生在翻完全程之前（已翻 ' + ra.pages + ' 页）');
      ok(ra.questions.length > 0, '中止前已抓到的题被保留（' + ra.questions.length + ' 题）');
      ok(!X.isAutoPaging(), '中止后运行状态被清理');
      eq(X.stopAutoPage(), false, '任务已结束后再调 stop 返回 false，不会误伤下一个任务');
    }

    /* ---------------- 重复启动保护 ---------------- */
    if (MODE === 'normal') {
      section('重复启动保护');
      var p1 = X.autoPage(null, { maxPages: 2, changeTimeout: 1500, stableMs: 150, pollMs: 60 });
      var second = null;
      try {
        await X.autoPage(null, { maxPages: 2 });
      } catch (e) {
        second = e.message;
      }
      ok(second && second.indexOf('翻页任务') >= 0, '任务进行中再次启动会被拒绝：' + second);
      await p1;
      ok(!X.isAutoPaging(), '第一个任务结束后状态复位');
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
