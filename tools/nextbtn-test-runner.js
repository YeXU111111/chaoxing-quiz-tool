/*!
 * nextbtn-test-runner.js —— 「下一节」按钮识别的回归测试
 *
 * 注入到 tools/fixtures/next-button.html 里跑。
 *
 * 起因：用户报「有时候点连续采集本章会说找不到『下一节』然后直接停」。
 * 追下去发现识别条件太严：
 *   · 文案里带箭头（「下一节 ›」）就匹配不上
 *   · 文字挂在 title 上、正文只有图标的按钮认不出来
 *   · hover 才显示（visibility:hidden）的按钮被可见性检查滤掉
 *   · 连文案都没有的按钮（只有类名）完全没有兜底
 *
 * 这个文件把六种写法逐个锁死。夹具里每个变体各自一个容器，
 * 测试时只显示其中一个 —— display:none 的会被尺寸检查自然排除。
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

  function run() {
    var X = window.CQBExtractor;
    var cases = Array.prototype.slice.call(document.querySelectorAll('.case'));

    section('环境检查');
    ok(!!X && typeof X.findNextSection === 'function', 'extractor.js 已加载，findNextSection 可用');
    eq(cases.length, 7, '夹具里有 7 个变体容器');

    /** 只显示某个变体，其余 display:none（尺寸归零，会被自然排除） */
    function only(variant) {
      cases.forEach(function (c) {
        c.style.display = c.getAttribute('data-variant') === variant ? 'block' : 'none';
      });
    }

    function probe(variant) {
      only(variant);
      try { return X.findNextSection(); } catch (e) { return { error: e.message }; }
    }

    /* ---------------- 逐个变体 ---------------- */
    section('按钮识别（六种写法）');

    var r1 = probe('plain');
    ok(!!r1 && r1.kind === 'section', '普通写法「下一节」认得出来');
    eq(r1 && r1.via, 'text', '走的是文案匹配');
    eq(r1 && r1.label, '下一节', '标签文案正确');

    var r2 = probe('deco');
    ok(!!r2 && r2.kind === 'section', '★ 带箭头的「下一节 ›」认得出来（这曾经是失败主因）');
    eq(r2 && r2.label, '下一节', '★ 装饰字符被剥掉了，标签是干净的「下一节」');

    var r3 = probe('icon-title');
    ok(!!r3 && r3.kind === 'section', '★ 正文只有图标、文字在 title 上的按钮认得出来');
    eq(r3 && r3.label, '下一节', '从 title 里取到了正确文案');

    var r4 = probe('class-only');
    ok(!!r4 && r4.kind === 'section', '★ 完全没文案时靠类名兜底认得出来');
    eq(r4 && r4.via, 'class', '标记为 class 兜底命中');
    eq(r4 && r4.el && r4.el.id, 'nextNode', '命中的正是 #nextNode');

    var r5 = probe('hover-hidden');
    ok(!!r5 && r5.kind === 'section', '★ hover 才显示（visibility:hidden）的按钮认得出来');

    var r6 = probe('chapter');
    ok(!!r6, '「下一章」按钮被找到了');
    eq(r6 && r6.kind, 'chapter', '★ 「下一章」判定为章末，不会当成下一节去点');
    eq(r6 && r6.label, '下一章', '章末按钮的文案也去掉了箭头，读到的是干净的「下一章」');

    var r7 = probe('none');
    eq(r7, null, '★ 确实没有按钮时返回 null，不会误点别的东西');

    /* ---------------- 负例：别被别的东西骗到 ---------------- */
    section('不能误判的东西');

    // 「下一节的测验」「请先完成下一节」这类长文案不能算按钮
    var decoy = document.createElement('div');
    decoy.id = 'decoy';
    decoy.innerHTML =
      '<a href="javascript:;" id="d1">下一节的测验</a>' +
      '<a href="javascript:;" id="d2">请先完成下一节的任务点</a>' +
      '<a href="javascript:;" id="d3">下一章节</a>' +
      '<a href="javascript:;" id="d4">返回上一节</a>';
    document.body.appendChild(decoy);

    only('none');
    eq(X.findNextSection(), null, '★ 只有「下一节的测验」这类长文案时返回 null，不会误点');
    ok(true, '（四个诱饵：下一节的测验 / 请先完成下一节的任务点 / 下一章节 / 返回上一节）');

    // 确认这些诱饵本身确实存在且可点 —— 否则上面那条断言是空过的
    var clickableDecoys = 0;
    ['d1', 'd2', 'd3', 'd4'].forEach(function (id) {
      var el = document.getElementById(id);
      var r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) clickableDecoys++;
    });
    eq(clickableDecoys, 4, '4 个诱饵都是可见可点的，排除是有意义的');

    decoy.remove();

    /* ---------------- 运行时异常 ---------------- */
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
      try { run(); finish(); }
      catch (e) { R.push('FAIL 测试脚本异常 :: ' + (e && e.message)); fail++; finish(); }
    }, 120);
  });
})();
