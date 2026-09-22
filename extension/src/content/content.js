/*!
 * content.js —— 注入到超星页面里的抓取器 UI
 *
 * 运行策略：
 *   - all_frames: true，所以 TOP 和所有 iframe 都会跑这份脚本。
 *   - 只有 TOP 帧创建悬浮面板；iframe 只负责「扫到题就静默上报」。
 *     超星的题目区经常整个装在 iframe 里，不这么做就只能抓到空壳。
 *   - 用 MutationObserver + history 钩子处理 SPA 换页，
 *     否则用户点「下一题」后我们还停在上一次的扫描结果上。
 */
(function () {
  'use strict';

  var X = window.CQBExtractor;
  if (!X) return;

  var IS_TOP = window.top === window;
  var capturedStems = {};       // 本次页面生命周期内已上报过的题干，防重复提交
  var panel = null;

  /* ================================================================== *
   * 与后台通信
   * ================================================================== */

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          // 后台没起来时会设置 lastError，这里吞掉避免控制台刷屏
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(res || { ok: true });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  /**
   * 把一次扫描结果上报给后台合并。
   * 关键：bankId 由「课程 + 作业」决定，所以一页一题的作业翻到第 10 页时，
   * 10 道题会自然合并进同一个题库，而不是产生 10 个题库。
   */
  function report(scan, opts) {
    opts = opts || {};
    var ctx = scan.context;
    var fresh = scan.questions.filter(function (q) {
      var k = window.CQB.hash64(q.stem);
      if (capturedStems[k] && !opts.force) return false;
      capturedStems[k] = 1;
      return true;
    });

    if (!fresh.length && !opts.force) {
      return Promise.resolve({ ok: true, added: 0, updated: 0, totalReuse: true });
    }

    return send({
      type: 'CAPTURE',
      payload: {
        bankId: X.bankIdOf(ctx),
        courseId: ctx.courseId,
        courseName: ctx.courseName,
        workId: ctx.workId,
        workTitle: ctx.workTitle,
        kind: ctx.kind,
        sourceUrl: ctx.sourceUrl,
        chapter: ctx.chapter,
        capturedAt: ctx.capturedAt,
        questions: fresh
      }
    });
  }

  /* ================================================================== *
   * 手动抓取
   * ================================================================== */

  function grabCurrentPage() {
    var login = X.checkLoginState();
    if (!login.loggedIn) {
      notify(login.reason, 'err');
      return Promise.resolve();
    }

    var scan = X.scanDocument();
    if (!scan.questions.length) {
      // 顶层没找到，可能是题在 iframe 里。让后台去问各个 frame。
      notify('本页没扫到题目，正在尝试子框架…');
      return send({ type: 'SCAN_ALL_FRAMES' }).then(function (res) {
        if (res && res.count) notify('在子框架中抓到 ' + res.count + ' 道题');
        else notify('没找到题目。确认当前在作业/考试作答页，而不是课程目录页', 'err');
      });
    }

    return report(scan, { force: false }).then(function (res) {
      if (res && res.totalReuse) notify('这 ' + scan.questions.length + ' 道题之前抓过了，未重复入库');
      else if (res && res.ok) notify('已抓取 ' + scan.questions.length + ' 题，其中 ' + scan.stats.withAnswer + ' 题含答案');
      else notify('保存失败：' + ((res && res.error) || '未知错误'), 'err');
      refreshBadgeText();
    });
  }

  /**
   * 整卷翻页抓取。
   *
   * 委托给后台去做，而不是在本帧直接跑循环 —— 因为「下一题」按钮可能在 iframe 里，
   * 跨域的 iframe 顶层是碰不到的。后台会挑出「握着按钮的那个帧」让它执行循环。
   */
  var pagingActive = false;    // 「请求已发出、还没收到回执」，防重复点击
  var pagingRunning = false;   // 「后台的翻页循环确实在跑」，停止按钮靠它判断

  function grabWithPaging() {
    var login = X.checkLoginState();
    if (!login.loggedIn) { notify(login.reason, 'err'); return Promise.resolve(); }
    if (pagingActive) return Promise.resolve();

    pagingActive = true;

    return send({ type: 'AUTOPAGE' }).then(function (res) {
      if (!res || !res.ok) {
        resetTaskUI();
        notify('无法开始抓取：' + ((res && res.error) || '未知错误'), 'err');
        return;
      }

      // 没有分页：后台已经顺手把当前所有 frame 的题目抓完了，直接展示结果
      if (!res.started) {
        showPagingResult(res);
        return;
      }

      pagingActive = false;
      pagingRunning = true;      // 后台那边真的开始跑了
      setPagingUI(true, '翻页抓取中…');
      notify('开始翻页抓取，会一直翻到最后一题。中途可点「停止抓取」。');
    }).catch(function (e) {
      pagingActive = false;
      pagingRunning = false;
      resetTaskUI();
      notify('翻页抓取出错：' + e.message, 'err');
    });
  }

  function stopPaging() {
    // 三个长任务都可能正在跑：翻页抓取、自动开标签、连续采集。
    // 一次全停掉，别让用户按两遍。
    var hadChain = stopChapterHarvest(true);
    var hadPaging = pagingRunning;
    var hadOpening = tabState.opening;

    // 先无条件复位界面，再去通知后台。
    // 顺序很重要：就算后台那边早就没任务了、消息发不出去，
    // 面板也必须先干净下来，不能让用户对着一动不动的界面反复点。
    resetTaskUI();

    send({ type: 'STOP_AUTOPAGE' }).then(function (res) {
      var stopped = hadChain || hadPaging || hadOpening || (res && res.stopped);
      notify(
        stopped ? '已停止。已抓到的题目都保留了。' : '当前没有在跑的任务，面板已复位。',
        stopped ? null : 'err',
        true
      );
    });
  }

  /** 执行帧跑完后由后台转发过来，收尾统一在这里做 */
  function showPagingResult(res) {
    resetTaskUI();          // 翻页循环结束了，无条件复位
    refreshBadgeText();

    if (!res || !res.ok) {
      notify('翻页抓取失败：' + ((res && res.error) || '未知错误'), 'err');
      return;
    }
    if (!res.count) {
      notify('这个页面上没有找到题目。章节页本身不含题目，题目在「章节测验」标签页里，' +
             '或者需要先把它点开。', 'err');
      return;
    }

    if (res.noPaging) {
      // 没有下一题按钮：不是错误，是这类页面本来就单页
      notify('已经是全部了：抓到 ' + res.count + ' 题，新增 ' + (res.added || 0) + ' 题。' +
             (res.added === 0 ? '（之前抓过，未重复入库）' : ''));
      return;
    }

    var head = res.aborted ? '已手动停止' : '翻页抓取完成';
    var body = '：共 ' + res.pages + ' 页 / ' + res.count + ' 题，新增 ' + (res.added || 0) + ' 题';

    // 正常翻到底不用啰嗦，非正常收尾才把原因摆出来
    var tail = '';
    if (res.aborted) tail = '（' + res.endedReason + '）';
    else if (res.endedCode === 'maxpages') tail = '　⚠ ' + res.endedReason;
    else if (res.endedCode === 'stall') tail = '　（' + res.endedReason + '）';

    notify(head + body + tail, res.endedCode === 'maxpages' ? 'err' : null);
  }

  function setPagingUI(on, label) {
    if (!panel) return;
    var page = panel.querySelector('#cqb-page');
    var chain = panel.querySelector('#cqb-chain');
    var stop = panel.querySelector('#cqb-stop');
    var grab = panel.querySelector('#cqb-grab');
    if (page) page.classList.toggle('cqb-hidden', on);
    if (chain) chain.classList.toggle('cqb-hidden', on);
    if (stop) stop.classList.toggle('cqb-hidden', !on);
    if (grab) grab.disabled = on;
    panel.classList.toggle('busy', on);
    setPanelStatus(on ? (label || '进行中…') : '就绪');
  }

  /**
   * 无条件把面板恢复到「空闲」。
   *
   * ★ 这是「点停止抓取没反应」的根因所在。
   *   原来只有「后台确实中止了一个循环」时才更新界面。
   *   可任务可能早就自己结束了（撞到上限、最后一页、后台消息没回来），
   *   面板却一直卡在「连续采集中…」、停止按钮一直挂着。
   *   再点停止，代码发现没有任务在跑，于是什么都不做 —— 界面纹丝不动。
   *   复位必须是无条件的，不能带前提。
   */
  function resetTaskUI() {
    clearTimeout(tabState.timer);
    clearInterval(tabState.poll);
    tabState.opening = false;
    tabState.chainPending = false;
    pagingRunning = false;
    // ★ pagingActive 也必须在这里清。
    //   它是「请求已发出、还没收到回执」的防重复点击闸门，
    //   而「没有下一题按钮」这条常见路径（单页作业、章节测验）只走 resetTaskUI，
    //   漏掉它的话闸门会永远关着 —— 之后每次点「整卷翻页抓取」都被静默吞掉，
    //   连错误提示都没有，只能刷新页面。
    pagingActive = false;
    setPagingUI(false);
  }

  /**
   * 看门狗：面板显示「进行中」但实际上没有任何任务在跑，就自动复位。
   *
   * 兜底的是「任务结束了，但收尾消息没回来」这一类 ——
   * 后台消息丢失、执行帧被销毁、service worker 被回收、用户中途刷新。
   * 没有它的话，面板会一直卡在「连续采集中…」，用户只能自己刷新页面。
   *
   * 两种判定：
   *   1. 明确没有任何任务在跑（连续采集没武装、翻页也没在跑）→ 6 秒后复位
   *   2. 有任务标记但长时间完全没有活动（60 秒没有一条提示）→ 判定卡死
   */
  function watchTaskState() {
    var idleSince = 0;

    setInterval(function () {
      if (!panel || !panel.classList.contains('busy')) { idleSince = 0; return; }

      var running = chainRunning() || pagingRunning || tabState.opening || tabState.chainPending;
      var now = Date.now();

      if (!running) {
        if (!idleSince) { idleSince = now; return; }
        if (now - idleSince > 6000) {
          idleSince = 0;
          resetTaskUI();
          refreshBadgeText();
          notify('任务已结束，面板已复位', null, true);
        }
        return;
      }

      idleSince = 0;

      if (now - lastActivityAt > 60000) {
        resetTaskUI();
        refreshBadgeText();
        notify('任务长时间没有进展，已自动停止并复位面板', 'err');
      }
    }, 2000);
  }

  function refreshBadgeText() {
    send({ type: 'GET_SUMMARY' }).then(function (res) {
      if (!res || !res.ok) return;
      setPanelStatus('题库共 ' + res.totalQuestions + ' 题 / ' + res.totalBanks + ' 套');
    });
  }

  /* ================================================================== *
   * 悬浮面板（只在 TOP 帧创建）
   * ================================================================== */

  function buildPanel() {
    if (!IS_TOP || panel) return;

    var root = document.createElement('div');
    root.id = 'cqb-root';
    root.innerHTML = [
      '<button id="cqb-fab" title="学习通题库提取器">',
      '  <span class="cqb-fab-icon">题</span>',
      '  <span class="cqb-fab-count" id="cqb-fab-count">0</span>',
      '</button>',
      '<div class="cqb-panel" id="cqb-panel">',
      '  <header class="cqb-head">',
      '    <span>题库提取</span>',
      '    <button class="cqb-x" id="cqb-close">✕</button>',
      '  </header>',
      '  <div class="cqb-status" id="cqb-status">就绪</div>',
      '  <div class="cqb-actions">',
      '    <button class="cqb-btn cqb-primary" id="cqb-grab">抓取本题</button>',
      '    <button class="cqb-btn" id="cqb-page">整卷翻页抓取</button>',
      '    <button class="cqb-btn" id="cqb-chain" title="从当前小节开始，自动逐节抓完本章（最多 40 节）">连续采集本章</button>',
      '    <button class="cqb-btn cqb-stop cqb-hidden" id="cqb-stop">停止抓取</button>',
      '    <button class="cqb-btn" id="cqb-open">打开刷题台</button>',
      '  </div>',
      '  <pre class="cqb-diag cqb-hidden" id="cqb-diag"></pre>',
      '  <div class="cqb-tip">',
      '    <button class="cqb-flag" id="cqb-auto" title="点一下开关自动抓取">开</button>自动抓取',
      '    <button class="cqb-flag" id="cqb-autotab" title="点一下开关「自动打开章节测验标签」">开</button>自动开标签',
      '    <button class="cqb-link" id="cqb-diag-btn">诊断</button>',
      '  </div>',
      '</div>'
    ].join('');

    document.documentElement.appendChild(root);
    panel = root;

    root.querySelector('#cqb-fab').onclick = function () {
      root.classList.toggle('open');
      if (root.classList.contains('open')) refreshBadgeText();
    };
    root.querySelector('#cqb-close').onclick = function () { root.classList.remove('open'); };
    root.querySelector('#cqb-grab').onclick = grabCurrentPage;
    root.querySelector('#cqb-page').onclick = grabWithPaging;
    root.querySelector('#cqb-chain').onclick = startChapterHarvest;
    root.querySelector('#cqb-stop').onclick = stopPaging;
    root.querySelector('#cqb-open').onclick = function () {
      send({ type: 'OPEN_PRACTICE' });
    };
    root.querySelector('#cqb-diag-btn').onclick = showDiagnostics;

    root.querySelector('#cqb-auto').onclick = function () {
      AUTO.on = !AUTO.on;
      renderAutoFlags();
      saveAutoSetting();
      notify('自动抓取已' + (AUTO.on ? '开启' : '关闭'), null, true);
    };
    root.querySelector('#cqb-autotab').onclick = function () {
      AUTO.openTab = !AUTO.openTab;
      renderAutoFlags();
      saveAutoSetting();
      notify('「自动打开章节测验标签」已' + (AUTO.openTab ? '开启' : '关闭'), null, true);
    };
  }

  /**
   * 诊断报告。
   *
   * 加这个是因为「自动抓取没反应」这种问题在本地根本复现不了 ——
   * 到底是脚本没注入、还是注入了但解析不到、题目又在哪个 frame 里，
   * 光看界面完全推不出来。直接把每一层的事实摊开给用户看。
   */
  function showDiagnostics() {
    var box = panel.querySelector('#cqb-diag');
    if (!box) return;

    if (!box.classList.contains('cqb-hidden') && box.dataset.loaded === '1') {
      box.classList.add('cqb-hidden');
      return;
    }
    box.classList.remove('cqb-hidden');
    box.dataset.loaded = '1';
    box.textContent = '正在检测…';

    send({ type: 'DIAGNOSE' }).then(function (r) {
      if (!r || !r.ok) {
        box.textContent = '检测失败：' + ((r && r.error) || '未知错误');
        return;
      }

      var lines = [];
      var injected = r.frames.filter(function (f) { return f.injected; }).length;

      lines.push('框架 ' + r.frames.length + ' 个，脚本已注入 ' + injected + ' 个');

      r.frames.forEach(function (f) {
        var short = String(f.url || '').replace(/^https?:\/\//, '').split('?')[0];
        if (short.length > 50) short = short.slice(0, 50) + '…';

        var cnt = f.injected
          ? (f.questions + ' 题' + (f.withAnswer ? '（含答案 ' + f.withAnswer + '）' : '（无答案）'))
          : '脚本未注入';

        lines.push('  [' + f.frameId + '] ' + cnt + (f.hasNext ? '  · 有下一题按钮' : ''));
        lines.push('        ' + short);
        if (f.injected && f.questions > 0 && f.bankId) {
          lines.push('        题库 ID：' + f.bankId);
        }
      });

      // 「连续采集本章」靠这个按钮推进，找不到就得说清楚
      var withNext = r.frames.filter(function (f) { return f.hasNextSection; });
      if (withNext.length) {
        withNext.forEach(function (f) {
          lines.push('  [' + f.frameId + '] 「' + f.nextSection.label + '」按钮  · 经 ' +
                     f.nextSection.via + ' 识别' +
                     (f.nextSection.kind === 'chapter' ? '（是「下一章」，章末）' : ''));
        });
      } else {
        lines.push('  ⚠ 所有框架都没找到「下一节」按钮 —— 连续采集在本页用不了');
      }

      lines.push('');
      lines.push('题库总计 ' + r.totalQuestions + ' 题（含答案 ' + r.withAnswer + '）／' + r.totalBanks + ' 套');
      lines.push('自动抓取：' + (r.autoOn === false ? '已关闭' : '已开启'));

      if (r.totalQuestions === 0) {
        lines.push('');
        lines.push('题目为 0 排查顺序：');
        lines.push('  1) 当前是不是「章节测验 / 作业」的作答页？章节主页不含题目');
        lines.push('  2) 章节页要把「章节测验」标签点开，题目才会加载');
        lines.push('  3) 若某框架显示「脚本未注入」，刷新一下这个页面');
      }

      box.textContent = lines.join('\n');
    });
  }

  function setPanelStatus(text) {
    if (!panel) return;
    var el = panel.querySelector('#cqb-status');
    if (el) el.textContent = text;
  }

  /* ================================================================== *
   * 跨帧能力：翻页循环里每一步都要知道「别的 frame 现在是什么内容」
   * ================================================================== */

  /**
   * 让后台去问所有 frame 要题目。
   * 台前是超星，题目经常整个装在 iframe 里，本帧的 DOM 只有壳子。
   */
  function makeCrossFrameScan() {
    return function () {
      return send({ type: 'SCAN_ALL_FRAMES', dryRun: true }).then(function (r) {
        if (!r || !r.ok) return null;
        return { questions: r.questions || [], context: r.context || null, signature: r.signature || '' };
      });
    };
  }

  /** 跨帧指纹：所有 frame 的题干合起来算一个哈希 */
  function makeCrossFrameSignature() {
    return function () {
      return send({ type: 'SCAN_ALL_FRAMES', dryRun: true }).then(function (r) {
        return (r && r.ok && r.signature) || '';
      });
    };
  }

  /** 执行帧的翻页进度回传到 TOP 帧展示。每 5 页弹一次提示，别刷屏。 */
  function showPagingProgress(p) {
    if (!p) return;
    lastActivityAt = Date.now();
    setPanelStatus('第 ' + p.page + ' 页 · 累计 ' + p.total + ' 题');
    if (p.page === 1 || p.page % 5 === 0) {
      notify('已翻 ' + p.page + ' 页，累计 ' + p.total + ' 题', null, true);
    }
  }

  function setFabCount(n) {
    if (!panel) return;
    var el = panel.querySelector('#cqb-fab-count');
    if (el) el.textContent = n > 999 ? '999+' : String(n);
  }

  /**
   * 页面内浮层提示。
   *
   * 之前每条提示都是独立定位到同一个坐标的，连着弹两条就完全叠在一起，
   * 谁都看不清（用户截图里就是一片糊）。
   * 现在统一挂到一个纵向排列的容器里，自然往下排。
   */
  var MAX_TOASTS = 4;

  function toastHost() {
    var host = document.getElementById('cqb-toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'cqb-toasts';
      document.documentElement.appendChild(host);
    }
    return host;
  }

  var lastActivityAt = Date.now();   // 看门狗判断「是不是卡住了」用

  function notify(msg, kind, quiet) {
    // 只有顶层帧有面板和浮层；iframe 里的提示转发到顶层显示
    if (!IS_TOP) {
      send({ type: 'TOAST', message: msg, kind: kind });
      return;
    }

    lastActivityAt = Date.now();

    var host = toastHost();

    // 太多就挤掉了，丢掉最老的
    while (host.children.length >= MAX_TOASTS) host.removeChild(host.firstChild);

    var el = document.createElement('div');
    el.className = 'cqb-toast' + (kind === 'err' ? ' cqb-err' : '');
    el.textContent = msg;
    host.appendChild(el);

    requestAnimationFrame(function () { el.classList.add('show'); });

    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, quiet ? 1500 : 3000);

    if (panel) setPanelStatus(msg);
  }

  /* ================================================================== *
   * 自动抓取：SPA 路由 + DOM 变化
   * ================================================================== */

  var autoTimer = null;
  var lastSignature = '';

  /**
   * 一级防抖：DOM 一动就扫太费性能，而且动画期间会扫到半渲染的状态。
   * 等 1.2 秒没有新变动，再扫一次。
   */
  function scheduleAutoScan() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () {
      if (!AUTO.on) return;
      autoScanOnce();
    }, 1200);
  }

  /**
   * 自动扫描一次。
   *
   * ★ 关键：本帧扫不到题目时不能就这么算了。
   *   超星的章节页 / 内嵌作业，题目整个在 iframe 里，顶层 DOM 只有个壳子，
   *   只扫本帧的话自动抓取永远不触发 —— 表现就是「开了自动抓取但什么都没发生」。
   *   这时候必须往后台要一次跨帧汇总。
   */
  var lastCrossFrameAt = 0;
  var CROSS_FRAME_MIN_GAP = 3000;   // 跨帧扫描贵，至少隔 3 秒才做一次

  function announceCapture(res, prefix) {
    if (!res || !res.ok || !(res.added || res.updated)) return false;
    notify(prefix + '：新增 ' + res.added + ' 题' + (res.updated ? '，更新 ' + res.updated + ' 题' : ''));
    setFabCount(res.total !== undefined ? res.total : res.totalQuestions);
    return true;
  }

  function autoScanOnce() {
    // 连续采集有自己的节奏，别让 MutationObserver 插进来重复跑一遍
    if (chainRunning() && tabState.chainPending) return;

    var scan = X.scanDocument();

    if (scan.questions.length) {
      // 用题干哈希集合当签名，页面没实质变化就不重复上报
      var sig = window.CQB.hash64(scan.questions.map(function (q) { return q.stem; }).join('|'));
      if (sig === lastSignature) return;
      lastSignature = sig;

      report(scan).then(function (res) {
        announceCapture(res, chainRunning() ? '连续采集' : '自动抓取');
        onSectionCaptured();
      });
      return;
    }

    // 本帧没题 → 问一遍所有 frame
    if (document.hidden) return;
    var now = Date.now();
    if (now - lastCrossFrameAt < CROSS_FRAME_MIN_GAP) return;
    lastCrossFrameAt = now;

    send({ type: 'SCAN_ALL_FRAMES' }).then(function (res) {
      // 已经被抓过的题不会重复计入，added 为 0 时静默
      if (res && res.ok && res.count) {
        announceCapture(res, chainRunning() ? '连续采集（子框架）' : '自动抓取（题目在子框架里）');
        onSectionCaptured();
        return;
      }
      // 整个页面（含所有子框架）都没有题目 → 看看是不是有「章节测验」标签没点开
      if (!tryOpenQuizTab()) onSectionEmpty();
    });
  }

  /* ================================================================== *
   * 自动打开「章节测验」标签
   *
   * 超星的章节页把测验藏在页内标签里，不点开题目就不会加载。
   * 这里自动切过去抓完再切回来，用户什么都不用做。
   *
   * 「切回来」的状态存 sessionStorage：整页跳转（而不是页内切标签）时
   * 内容脚本会重新初始化，靠内存变量记不住。
   * ================================================================== */

  var TAB_KEY = 'cqb:tabAuto';
  var TAB_TRIED_PREFIX = 'cqb:tabTried:';
  var TAB_MAX_AGE = 90000;     // 超过 90 秒的返回意图就作废，免得莫名其妙切页
  var TAB_WAIT_MAX = 20000;    // 最多在测验页等 20 秒
  var tabState = { opening: false, timer: null, poll: null, chainPending: false };

  /*
   * 同一个 URL 只自动切一次。
   *
   * 没有这个闸门会来回弹：切到测验页抓到题 → 切回视频 → 视频页没题目 →
   * 又判定「该去开测验标签」→ 再切过去…… 无限循环。
   * 用 sessionStorage 按 URL 记，所以换到下一个章节（URL 变了）仍会自动生效。
   */
  // 键里带上小节标题：有些页面切小节时 URL 不变，
  // 只用 URL 会把第二节也拦下来，连续采集就空转了
  function tabTriedKey() {
    try {
      var sec = '';
      try { sec = X.getSectionKey ? X.getSectionKey() : ''; } catch (e) {}
      return TAB_TRIED_PREFIX + location.href + '#' + sec;
    } catch (e) { return ''; }
  }
  function hasTriedThisUrl() {
    try { return sessionStorage.getItem(tabTriedKey()) === '1'; } catch (e) { return false; }
  }
  function markTriedThisUrl() {
    try { sessionStorage.setItem(tabTriedKey(), '1'); } catch (e) {}
  }

  function rememberBackTab(label) {
    try { sessionStorage.setItem(TAB_KEY, JSON.stringify({ label: label, at: Date.now() })); } catch (e) {}
  }
  function forgetBackTab() {
    try { sessionStorage.removeItem(TAB_KEY); } catch (e) {}
  }
  function readBackTab() {
    try {
      var raw = sessionStorage.getItem(TAB_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.label) return null;
      if (Date.now() - (o.at || 0) > TAB_MAX_AGE) { forgetBackTab(); return null; }
      return o;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * 连续采集本章
   *
   * 「抓完切到下一节」单独做成一个显式动作，而不是直接把回切改成前进。
   * 原因是：那样一来，用户随手打开任何一节都会触发整章自动跑一遍，
   * 完全不受控。做成按钮之后，跑与不跑由人决定。
   * ------------------------------------------------------------------ */

  var CHAIN_ARMED = 'cqb:chainArmed';
  var CHAIN_STOP_KEY = 'cqb:chainStop';
  var CHAIN_STEPS = 'cqb:chainSteps';
  var CHAIN_MAX = 40;           // 一次连续采集最多走多少节，防跑飞
  var CHAIN_DELAY = 4000;       // 节与节之间的间隔。别太急，这是在对超星发请求
  var CHAIN_SKIP_DELAY = 1600;  // 这一节没测验时，只等短一点

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

  function chainRunning() {
    return ssGet(CHAIN_ARMED) === '1' && ssGet(CHAIN_STOP_KEY) !== '1';
  }
  function readSteps() { return parseInt(ssGet(CHAIN_STEPS) || '0', 10) || 0; }

  function startChapterHarvest() {
    if (chainRunning()) { notify('连续采集已经在跑了', 'err'); return; }

    ssSet(CHAIN_ARMED, '1');
    ssDel(CHAIN_STOP_KEY);
    ssDel(CHAIN_LAST);            // 清掉上一轮的痕迹，否则第一节会被当成「已处理」
    ssSet(CHAIN_STEPS, '0');
    tabState.opening = false;
    clearTimeout(tabState.timer);
    setPagingUI(true, '连续采集中…');
    notify('开始连续采集本章：会自动逐节抓取，最多 ' + CHAIN_MAX + ' 节。随时可点「停止抓取」。');

    runCurrentSection();
  }

  /**
   * 停止连续采集。
   *
   * ★ 早期版本在第一行就 `if (没在跑) return false;`，
   *   把后面的界面复位一起跳过了 —— 撞到上限自动停下之后再点「停止抓取」，
   *   界面就永远是「连续采集中…」。复位不能放在有没有任务这个判断后面。
   *
   * @returns {boolean} 之前确实有任务在跑
   */
  function stopChapterHarvest(silent) {
    var wasRunning = ssGet(CHAIN_ARMED) === '1';

    if (wasRunning) {
      ssSet(CHAIN_STOP_KEY, '1');
      ssDel(CHAIN_ARMED);
    }

    clearTimeout(tabState.timer);
    clearInterval(tabState.poll);
    tabState.opening = false;
    tabState.chainPending = false;
    setPagingUI(false);

    if (wasRunning && !silent) notify('连续采集已停止', null, true);
    return wasRunning;
  }

  var CHAIN_LAST = 'cqb:chainLast';   // 已经计入过的小节标识

  /** 当前小节的稳定标识：优先小节标题，退回 URL */
  function sectionKey() {
    var k = '';
    try { k = X.getSectionKey ? X.getSectionKey() : ''; } catch (e) {}
    return k || location.href;
  }

  /**
   * 连续采集推进一步。
   *
   * ★ 必须幂等。同一节的「抓到了」可能被两条路径各通知一次
   *   —— MutationObserver 扫到题目，和切标签后的轮询也扫到题目 ——
   *   不去重的话计数会翻倍、小节会被成对跳过。
   */
  function chainStep(kind) {
    if (!chainRunning()) return false;

    var key = sectionKey();
    if (ssGet(CHAIN_LAST) === key) return false;   // 这一节已经处理过了
    ssSet(CHAIN_LAST, key);

    clearTimeout(tabState.timer);
    clearInterval(tabState.poll);

    // ★ 必须在这里复位。opening 原本只在 returnToBackTab 里清零，
    //   而连续采集从不走回切那条路 —— 不复位的话第二节会被
    //   「已经在一次切换流程里」挡住，永远打不开自己的章节测验标签。
    tabState.opening = false;

    if (kind === 'skip') {
      scheduleAdvance(CHAIN_SKIP_DELAY);
      return true;
    }

    var n = readSteps() + 1;
    ssSet(CHAIN_STEPS, String(n));

    if (n >= CHAIN_MAX) {
      stopChapterHarvest(true);
      notify('已连续采集 ' + n + ' 节，达到上限自动停止', null, true);
      return true;
    }

    if (IS_TOP) setPanelStatus('连续采集：已完成 ' + n + ' 节，正在前往下一节…');
    notify('第 ' + n + ' 节采集完成，' + (CHAIN_DELAY / 1000) + ' 秒后进入下一节…', null, true);
    scheduleAdvance(CHAIN_DELAY);
    return true;
  }

  /** 走完一轮：抓到的题已经入库了，决定下一步去哪 */
  function onSectionCaptured() {
    clearInterval(tabState.poll);

    if (chainRunning()) { chainStep('capture'); return; }

    // 不是连续采集模式：抓完切回用户原来待着的那个标签
    scheduleReturnToBackTab();
  }

  /** 这一节什么都没有。连续采集中就跳过去，否则啥也不用做 */
  function onSectionEmpty() {
    if (!chainRunning()) return false;
    return chainStep('skip');
  }

  function scheduleAdvance(delay) {
    tabState.chainPending = true;
    clearTimeout(tabState.timer);
    tabState.timer = setTimeout(advanceToNextSection, delay);
  }

  var NEXT_RETRY = 4;          // 找不到按钮时重试几次
  var NEXT_RETRY_GAP = 1500;

  function advanceToNextSection(attempt) {
    attempt = attempt || 1;
    if (!chainRunning()) return;
    if (readSteps() >= CHAIN_MAX) { stopChapterHarvest(true); return; }

    var next = X.findNextSection();

    if (!next) {
      // ★ 找不到就重试，不要一次就收工。
      //   翻页按钮可能是懒渲染的，或者页面刚切完还没稳定 ——
      //   上来就判死刑，用户看到的就是「点一下就停」。
      if (attempt < NEXT_RETRY) {
        if (IS_TOP) setPanelStatus('正在查找「下一节」按钮…（第 ' + attempt + ' 次）');
        tabState.chainPending = true;
        clearTimeout(tabState.timer);
        tabState.timer = setTimeout(function () {
          advanceToNextSection(attempt + 1);
        }, NEXT_RETRY_GAP);
        return;
      }

      stopChapterHarvest(true);
      notify('找不到「下一节」按钮，连续采集结束。' +
             '这个功能要在章节学习页上用；如果当前是单独的作业页，页面上没有翻节按钮。' +
             '可以点面板上的「诊断」看看识别到了什么。', 'err');
      return;
    }

    if (next.kind === 'chapter') {
      stopChapterHarvest(true);
      notify('已经到本章最后一节（按钮是「' + next.label + '」），连续采集结束，不跨章', null, true);
      return;
    }

    forgetBackTab();     // 往前走，不需要回切的记忆
    if (IS_TOP) setPanelStatus('连续采集：正在进入「' + next.label + '」');
    notify('进入下一节：' + next.label, null, true);

    try {
      next.el.click();
      scheduleSectionRun();
    } catch (e) {
      stopChapterHarvest(true);
      notify('点击「下一节」失败，连续采集已停止', 'err');
    }
  }

  /**
   * 点完「下一节」之后自己接着跑，不等 MutationObserver 的防抖。
   *
   * 整页跳转的话这个定时器会随页面一起消失，由 boot() 里的 chainRunning 分支接管；
   * 页内换内容的话就走这里。两条路都覆盖到。
   */
  function scheduleSectionRun() {
    tabState.chainPending = true;
    clearTimeout(tabState.timer);

    tabState.timer = setTimeout(function () {
      if (!chainRunning()) return;

      // 兜底：点了「下一节」但页面没动（按钮其实已经禁用、或者点了没反应），
      // 说明到头了，别一直挂着等
      if (ssGet(CHAIN_LAST) === sectionKey()) {
        stopChapterHarvest(true);
        notify('点了「下一节」但页面没有变化，连续采集结束', null, true);
        return;
      }

      runCurrentSection();
    }, 2500);
  }

  /** 当前这一节：有题就抓，没题就看看有没有章节测验标签 */
  function runCurrentSection() {
    tabState.chainPending = false;
    if (!chainRunning()) { setPagingUI(false); return; }

    var scan = X.scanDocument();
    if (scan.questions.length) {
      report(scan).then(function (res) {
        announceCapture(res, '连续采集');
        onSectionCaptured();
      });
      return;
    }

    send({ type: 'SCAN_ALL_FRAMES' }).then(function (res) {
      if (!chainRunning()) { setPagingUI(false); return; }
      if (res && res.ok && res.count) {
        announceCapture(res, '连续采集（子框架）');
        onSectionCaptured();
        return;
      }
      // 本页没题：有章节测验标签就点开它（抓完会走 onSectionCaptured），
      // 连标签都没有就说明这节没测验，直接跳下一节
      if (!tryOpenQuizTab()) onSectionEmpty();
    });
  }

  function tryOpenQuizTab() {
    if (!IS_TOP) return false;
    if (!AUTO.on || !AUTO.openTab) return false;
    if (tabState.opening) return false;
    if (hasTriedThisUrl()) return false;                             // 这个 URL 已经自动切过一次了
    if (readBackTab()) return false;                                 // 已经在一次自动切换流程里
    if (X.scanDocument().questions.length) return false;             // 本页有题就不折腾

    var found = X.findQuizTab();
    if (!found) return false;

    tabState.opening = true;
    markTriedThisUrl();

    // 连续采集时方向是往前走，不记「回到哪」—— 记了反而会让下一节的
    // tryOpenQuizTab 以为「已经在一次切换流程里」而不肯点开
    if (chainRunning()) forgetBackTab();
    else rememberBackTab(found.backLabel);

    notify(chainRunning()
      ? '本节没有题目，正在自动打开「' + found.label + '」抓取…'
      : '本页没有题目。正在自动切到「' + found.label + '」抓取，抓完会切回来。');

    setTimeout(function () {
      try { found.el.click(); } catch (e) {}
      waitForQuizThenReturn();
    }, 250);

    return true;
  }

  /** 页面是不是在说「这个测验你还没解锁」 */
  var LOCK_TEXT = /请先完成|还未完成|任务点未完成|未完成任务点|需要完成.{0,6}视频|无法作答|暂未开放/;

  /**
   * 切过去之后轮询：抓到题就早点切回来，最长等 TAB_WAIT_MAX。
   *
   * 提前放弃的两种情况：
   *   1. 页面明说「请先完成视频任务点」—— 再等也没用，赶紧切回去
   *   2. 超过 TAB_WAIT_MAX
   */
  function waitForQuizThenReturn() {
    var start = Date.now();
    var polls = 0;

    // 有没有「正在进行中的会话」：要么是回切流程，要么是连续采集
    function sessionAlive() { return !!readBackTab() || chainRunning(); }

    clearInterval(tabState.poll);
    tabState.poll = setInterval(function () {
      if (!sessionAlive()) { clearInterval(tabState.poll); return; }
      polls++;

      if (Date.now() - start > TAB_WAIT_MAX) {
        clearInterval(tabState.poll);
        if (chainRunning()) {
          notify('这一节的测验没等到内容，跳到下一节', null, true);
          onSectionEmpty();
        } else {
          returnToBackTab(true);
        }
        return;
      }

      // 非 dryRun：顺手把题目落库。
      // 这样即使测验页自己的内容脚本没触发自动扫描，也不会空手而归。
      send({ type: 'SCAN_ALL_FRAMES' }).then(function (r) {
        if (r && r.ok && r.count) {
          announceCapture(r, chainRunning() ? '连续采集' : '自动抓取（章节测验）');
          clearInterval(tabState.poll);
          setTimeout(onSectionCaptured, 1200);
          return;
        }

        // 连试三次都没题，看看是不是被任务点锁住了
        if (polls >= 3 && !X.scanDocument().questions.length) {
          var body = String(document.body ? document.body.textContent : '').slice(0, 4000);
          if (LOCK_TEXT.test(body)) {
            clearInterval(tabState.poll);
            if (chainRunning()) {
              notify('这一节的测验还没解锁（需先完成视频任务点），跳过', 'err');
              onSectionEmpty();
            } else {
              notify('章节测验还没解锁（需要先完成视频任务点），已切回原标签', 'err');
              returnToBackTab(true);
            }
          }
        }
      });
    }, 2000);
  }

  function returnToBackTab(timedOut) {
    clearTimeout(tabState.timer);
    clearInterval(tabState.poll);
    tabState.opening = false;

    // 连续采集时方向是往前走，不要半路拐回去
    if (chainRunning()) return;

    var back = readBackTab();
    forgetBackTab();
    if (!back) return;

    var el = X.findTabByText(back.label);
    if (!el) return;      // 找不到原标签就算了，宁可停着也别乱点

    notify(timedOut ? '没抓到题目，已切回「' + back.label + '」' : '已切回「' + back.label + '」',
           timedOut ? 'err' : null, true);
    try { el.click(); } catch (e) {}
  }

  /** 抓到题了 → 提前把定时器改短，别让用户干等 */
  function scheduleReturnToBackTab() {
    if (!readBackTab()) return;
    clearInterval(tabState.poll);
    clearTimeout(tabState.timer);
    tabState.timer = setTimeout(function () { returnToBackTab(false); }, 1500);
  }

  /**
   * 页面刚加载时调用：如果上一次是因为自动切标签跳过来的，
   * 现在题目已经在手上了，就直接切回去。
   */
  function resumeReturnIfNeeded() {
    if (!IS_TOP || !readBackTab()) return;

    setTimeout(function () {
      if (X.scanDocument().questions.length) { returnToBackTab(false); return; }
      waitForQuizThenReturn();      // 还在加载，接着等
    }, 2500);
  }

  /** 拦 history API，处理 SPA 换页 */
  function hookHistory() {
    if (!IS_TOP) return;
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = history[fn];
      if (!orig) return;
      history[fn] = function () {
        var r = orig.apply(this, arguments);
        window.dispatchEvent(new Event('cqb:locationchange'));
        return r;
      };
    });
    window.addEventListener('popstate', function () {
      window.dispatchEvent(new Event('cqb:locationchange'));
    });
    window.addEventListener('cqb:locationchange', scheduleAutoScan);
  }

  var AUTO = { on: true, openTab: true };

  function renderAutoFlags() {
    if (!panel) return;
    var a = panel.querySelector('#cqb-auto');
    var b = panel.querySelector('#cqb-autotab');
    if (a) { a.textContent = AUTO.on ? '开' : '关'; a.className = AUTO.on ? 'cqb-on' : 'cqb-off'; }
    if (b) { b.textContent = AUTO.openTab ? '开' : '关'; b.className = AUTO.openTab ? 'cqb-on' : 'cqb-off'; }
  }

  function loadAutoSetting() {
    try {
      chrome.storage.local.get('settings', function (res) {
        var s = (res && res.settings) || {};
        AUTO.on = s.autoCapture !== false;
        AUTO.openTab = s.openQuizTab !== false;
        renderAutoFlags();
      });
    } catch (e) {}
  }

  /** 面板上直接切换开关，省得每次都要开弹窗 */
  function saveAutoSetting() {
    try {
      chrome.storage.local.get('settings', function (res) {
        var s = Object.assign({}, (res && res.settings) || {});
        s.autoCapture = AUTO.on;
        s.openQuizTab = AUTO.openTab;
        chrome.storage.local.set({ settings: s });
      });
    } catch (e) {}
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */

  function observeDom() {
    if (!document.body) return;
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];

        // 有新节点加进来
        if (m.addedNodes && m.addedNodes.length) { scheduleAutoScan(); return; }

        // iframe 被换了 src —— 切「章节测验」这类页内标签页就是这种变化，
        // 光看 childList 是捕捉不到的
        if (m.type === 'attributes' && m.attributeName === 'src' &&
            m.target && String(m.target.tagName).toUpperCase() === 'IFRAME') {
          scheduleAutoScan();
          return;
        }
      }
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']     // 不限一下的话，任何属性变动（含超星自己的动画）都会触发
    });
  }

  function boot() {
    if (IS_TOP) {
      buildPanel();
      loadAutoSetting();
      hookHistory();
      watchTaskState();
      // 上一次可能是被「自动切到章节测验」带过来的，题目到手就切回去
      resumeReturnIfNeeded();

      document.addEventListener('keydown', function (e) {
        // Alt+Shift+S：抓取本题
        if (e.altKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
          e.preventDefault();
          grabCurrentPage();
        }
      });

      send({ type: 'GET_SUMMARY' }).then(function (res) {
        if (res && res.ok) {
          setFabCount(res.totalQuestions);
          setPanelStatus('题库共 ' + res.totalQuestions + ' 题 / ' + res.totalBanks + ' 套');
        }
      });
    }

    observeDom();

    // 首次扫描：等页面把题目渲染出来
    setTimeout(function () {
      if (!AUTO.on) return;

      // 连续采集跨小节时可能是整页跳转，内容脚本会重新初始化。
      // 这里接着上一节往下走，而不是当成一次普通的自动扫描。
      if (chainRunning()) {
        if (IS_TOP) setPagingUI(true, '连续采集中…');
        runCurrentSection();
        return;
      }

      autoScanOnce();
    }, 1500);
  }

  /* 监听后台派发的指令（多 frame 汇总抓取时用） */
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.type) return;
      if (msg.type === 'DO_SCAN') {
        var scan = X.scanDocument();
        sendResponse({ ok: true, count: scan.questions.length, questions: scan.questions, context: scan.context, pageUrl: location.href });
        return true;
      }
      if (msg.type === 'DO_DIAGNOSE') {
        var login = X.checkLoginState();
        var probe = X.scanDocument();

        var nextSec = null;
        try {
          var ns = X.findNextSection();
          if (ns) nextSec = { label: ns.label, kind: ns.kind, via: ns.via || '?' };
        } catch (e) {}

        var secKey = '';
        try { secKey = X.getSectionKey(); } catch (e) {}

        sendResponse({
          ok: true,
          isTop: IS_TOP,
          url: location.href,
          questions: probe.questions.length,
          withAnswer: probe.questions.filter(function (q) { return q.hasAnswer; }).length,
          hasNext: !!X.findNextButton(),
          hasNextSection: !!nextSec,
          nextSection: nextSec,
          sectionKey: secKey,
          auto: AUTO.on,
          loggedIn: login.loggedIn,
          bankId: X.bankIdOf(probe.context)
        });
        return true;
      }

      if (msg.type === 'DO_CAN_PAGE') {
        // 后台用它来挑「握着下一题按钮的那个帧」
        var probe = X.scanDocument();
        sendResponse({
          ok: true,
          hasNext: !!X.findNextButton(),
          blocks: probe.questions.length,
          top: IS_TOP,
          url: location.href
        });
        return true;
      }

      if (msg.type === 'DO_AUTOPAGE') {
        if (X.isAutoPaging()) {
          sendResponse({ ok: false, error: '已经有一个翻页任务在跑了' });
          return true;
        }

        // 先立刻回一个「已启动」。翻完整套卷子可能要几分钟，
        // 把消息通道挂那么久会被 MV3 掐掉，所以改成完成后用 AUTOPAGE_DONE 回报。
        sendResponse({ ok: true, started: true });

        X.autoPage(null, {
          maxPages: msg.maxPages || 300,
          // 注入跨帧能力：题目在 iframe 里时，本帧的 DOM 变化检测不到，
          // 得靠「所有 frame 的题干指纹」来判断页面到底换没换
          scanAll: makeCrossFrameScan(),
          remoteSignature: makeCrossFrameSignature(),
          onProgress: function (p) {
            send({ type: 'PAGING_PROGRESS', payload: p });
          }
        }).then(function (r) {
          send({
            type: 'AUTOPAGE_DONE',
            payload: {
              ok: true,
              questions: r.questions,
              context: r.context,
              pages: r.pages,
              endedReason: r.endedReason,
              endedCode: r.endedCode,
              aborted: r.aborted
            }
          });
        }).catch(function (e) {
          send({ type: 'AUTOPAGE_DONE', payload: { ok: false, error: e.message } });
        });

        return true;
      }

      if (msg.type === 'DO_STOP_AUTOPAGE') {
        var stoppedChain = stopChapterHarvest(true);
        sendResponse({ ok: true, stopped: X.stopAutoPage() || stoppedChain });
        return true;
      }

      if (msg.type === 'DO_START_CHAIN') {
        if (!IS_TOP) { sendResponse({ ok: false, error: '要在最外层页面上操作' }); return true; }
        if (chainRunning()) { sendResponse({ ok: false, error: '连续采集已经在跑了' }); return true; }
        startChapterHarvest();
        sendResponse({ ok: true, started: true });
        return true;
      }

      if (msg.type === 'DO_CHAIN_STATUS') {
        sendResponse({
          ok: true,
          running: chainRunning(),
          steps: readSteps()
        });
        return true;
      }

      if (msg.type === 'PAGING_PROGRESS') {
        // 后台把执行帧的进度转发到 TOP 帧来展示
        if (IS_TOP) showPagingProgress(msg.payload);
        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === 'AUTOPAGE_DONE') {
        // 无论是哪个帧执行的，收尾统一由 TOP 帧的面板展示
        if (IS_TOP) showPagingResult(msg.payload);
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'CHECK_LOGIN') {
        sendResponse(Object.assign({ ok: true }, X.checkLoginState()));
        return true;
      }
      if (msg.type === 'SHOW_TOAST') {
        if (IS_TOP) notify(msg.message, msg.kind);
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'PING') {
        sendResponse({ ok: true, top: IS_TOP, url: location.href });
        return true;
      }
    });
  } catch (e) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
