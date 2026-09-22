/*!
 * popup.js —— 扩展弹窗
 *
 * 弹窗的生命周期极短（点到外面就销毁），所以这里不做任何状态缓存，
 * 每次打开都重新拉一遍 storage 和当前标签页状态。
 */
(function () {
  'use strict';

  var CQB = window.CQB;   // 来自 ../shared/schema.js
  var $ = function (id) { return document.getElementById(id); };

  var activeTab = null;
  var IS_CHAOXING = false;

  /* ================================================================ *
   * 工具
   * ================================================================ */

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(res || { ok: true });
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  /** 直接问 content script（弹窗 → 标签页） */
  function askTab(msg, tabId) {
    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(tabId || (activeTab && activeTab.id), msg, function (res) {
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(res || { ok: false });
      });
    });
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
           (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' +
           (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  /* ================================================================ *
   * 渲染
   * ================================================================ */

  function renderSummary(sum) {
    $('summary').textContent = sum.totalQuestions
      ? sum.totalQuestions + ' 题 · ' + sum.totalBanks + ' 套题库'
      : '还没有题目';
  }

  function renderBanks(banks) {
    var ids = Object.keys(banks);
    $('bankCount').textContent = ids.length ? ids.length + ' 套' : '';

    var list = $('bankList');
    if (!ids.length) {
      list.innerHTML = '<div class="empty">' +
        '还没抓到题目。<br>打开学习通的作业页，点上面的「抓取本页」。</div>';
      return;
    }

    // 最近更新的排前面
    ids.sort(function (a, b) {
      return String(banks[b].updatedAt || '').localeCompare(String(banks[a].updatedAt || ''));
    });

    list.innerHTML = ids.map(function (id) {
      var b = banks[id];
      var withAns = b.questions.filter(function (q) { return q.hasAnswer; }).length;
      var noAns = b.questions.length - withAns;
      var title = b.workTitle || b.courseName || id;
      var sub = [b.courseName, fmtDate(b.updatedAt)].filter(Boolean).join(' · ');

      return '' +
        '<div class="bank-item" data-id="' + esc(id) + '">' +
        '  <div class="bank-head">' +
        '    <span class="bank-name" title="' + esc(title) + '">' + esc(title) + '</span>' +
        '    <span class="bank-meta">' + b.questions.length + ' 题</span>' +
        '  </div>' +
        '  <div class="bank-sub">' + esc(sub || '—') +
             (noAns ? '　·　' + noAns + ' 题无答案' : '') + '</div>' +
        '  <div class="bank-ops">' +
        '    <button class="btn mini primary" data-act="open">刷题</button>' +
        '    <button class="btn mini" data-act="wrong" ' + (noAns === b.questions.length ? 'disabled' : '') + '>错题复习</button>' +
        '    <button class="btn mini" data-act="export">导出</button>' +
        '    <button class="btn mini danger" data-act="del">删</button>' +
        '  </div>' +
        '</div>';
    }).join('');

    list.querySelectorAll('.bank-item').forEach(function (item) {
      var id = item.getAttribute('data-id');
      item.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.onclick = function () { onBankAction(btn.getAttribute('data-act'), id, banks[id]); };
      });
    });
  }

  function onBankAction(act, bankId, bank) {
    if (act === 'open') { send({ type: 'OPEN_PRACTICE', bankId: bankId }); window.close(); return; }
    if (act === 'wrong') { send({ type: 'OPEN_PRACTICE', bankId: bankId, status: 'wrong' }); window.close(); return; }
    if (act === 'export') {
      send({ type: 'EXPORT', bankId: bankId }).then(function (res) {
        toast(res && res.ok ? '已导出 ' + res.count + ' 题' : '导出失败：' + ((res && res.error) || ''), !(res && res.ok));
      });
      return;
    }
    if (act === 'del') {
      if (!confirm('删除题库「' + (bank.workTitle || bankId) + '」？练习进度不受影响。')) return;
      send({ type: 'DELETE_BANK', bankId: bankId }).then(function () {
        toast('已删除');
        refresh();
      });
    }
  }

  /* ================================================================ *
   * 当前页面检测
   * ================================================================ */

  async function detectPage() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;

    var statusEl = $('pageStatus');
    var hintEl = $('pageHint');
    $('btnGrab').disabled = true;
    $('btnGrabAll').disabled = true;

    if (!activeTab || !activeTab.url) {
      statusEl.textContent = '读不到当前标签页';
      statusEl.className = 'page-status err';
      return;
    }

    IS_CHAOXING = /^https?:\/\/[^/]*chaoxing\.(com|com\.cn|cn)\//i.test(activeTab.url);
    if (!IS_CHAOXING) {
      statusEl.textContent = '当前不是学习通页面';
      statusEl.className = 'page-status warn';
      hintEl.textContent = '切到作业或考试作答页再抓取。课程目录页、视频页都没有题目。';
      return;
    }

    // 问一下 content script 现在什么情况
    var ping = await askTab({ type: 'PING' });
    if (!ping || !ping.ok) {
      statusEl.textContent = '页面脚本未就绪';
      statusEl.className = 'page-status warn';
      hintEl.textContent = '如果是刚安装扩展，刷新一下学习通页面即可。';
      return;
    }

    // 非顶层帧说明题目在 iframe 里，抓取要走「整卷」通道
    var login = await askTab({ type: 'CHECK_LOGIN' });
    if (login && login.loggedIn === false) {
      statusEl.textContent = '⚠ ' + login.reason;
      statusEl.className = 'page-status err';
      hintEl.textContent = '登录态靠浏览器 Cookie 维持。登录后刷新页面再抓取即可，扩展本身不接触你的账号密码。';
      return;
    }

    // 数一下当前帧能扫到多少题
    var scan = await askTab({ type: 'DO_SCAN' });
    if (scan && scan.ok && scan.count > 0) {
      var ctx = scan.context || {};
      var n = scan.questions.filter(function (q) { return q.hasAnswer; }).length;
      statusEl.textContent = '检测到 ' + scan.count + ' 道题' +
        (n ? '（' + n + ' 题含答案）' : '（暂无答案，老师可能还没公布）');
      statusEl.className = 'page-status ok';
      hintEl.textContent = (ctx.workTitle ? '作业：' + ctx.workTitle + '　' : '') +
        (ctx.chapter ? '章节：' + ctx.chapter : '');
      $('btnGrab').disabled = false;
      $('btnGrabAll').disabled = false;
      if (!ping.top) hintEl.textContent += '　（题目在子框架中，抓取会自动汇总）';
    } else {
      // 当前帧没有，可能是 iframe 或者还没渲染完
      statusEl.textContent = '本页暂未识别到题目';
      statusEl.className = 'page-status warn';
      hintEl.textContent = '若确实是作业页，点「整卷翻页抓取」试试；也可能是答案页需要先提交作业。';
      $('btnGrabAll').disabled = false;
    }
  }

  /* ================================================================ *
   * 动作
   * ================================================================ */

  async function doGrab(force) {
    $('btnGrab').disabled = true;
    $('btnGrabAll').disabled = true;

    // 先问当前帧；当前帧为空时交给后台去汇总所有 frame
    var scan = await askTab({ type: 'DO_SCAN' });
    var done = false;

    if (scan && scan.ok && scan.count > 0) {
      var ctx = scan.context || {};
      var res = await send({
        type: 'CAPTURE',
        payload: {
          bankId: [ctx.courseId || 'nocourse', ctx.workId || ctx.workTitle || 'nowork'].join('::'),
          courseId: ctx.courseId, courseName: ctx.courseName,
          workId: ctx.workId, workTitle: ctx.workTitle, kind: ctx.kind,
          chapter: ctx.chapter, sourceUrl: ctx.sourceUrl, capturedAt: ctx.capturedAt,
          questions: scan.questions
        }
      });
      if (res && res.ok) {
        toast('已抓取 ' + scan.count + ' 题，新增 ' + res.added + ' 题');
        done = true;
      } else {
        toast('保存失败：' + ((res && res.error) || '未知'), true);
      }
    }

    if (!done && !force) {
      // 当前帧没题 → 走汇总通道
      var all = await send({ type: 'SCAN_ALL_FRAMES', tabId: activeTab.id });
      if (all && all.count) {
        toast('已从子框架抓取 ' + all.count + ' 题，新增 ' + (all.added || 0) + ' 题');
        done = true;
      } else {
        toast('没找到题目，确认这是作业/考试作答页', true);
      }
    }

    refresh();
  }

  /**
   * 整卷翻页抓取。
   * 弹窗一点外面就销毁，撑不住几分钟的翻页过程，
   * 所以这里只负责「发车」，进度和结果都在页面右下角的面板上看。
   * 由后台挑出握着「下一题」按钮的那个帧去执行循环。
   */
  async function doGrabAll() {
    $('btnGrab').disabled = true;
    $('btnGrabAll').disabled = true;

    // 必须显式带 tabId —— 弹窗不是内容脚本，后台那边 sender.tab 是 undefined
    var res = await send({ type: 'AUTOPAGE', tabId: activeTab && activeTab.id });

    if (!res || !res.ok) {
      toast('无法开始抓取：' + ((res && res.error) || '未知错误'), true);
      $('btnGrab').disabled = false;
      $('btnGrabAll').disabled = false;
      return;
    }

    // 没有分页：后台已经顺手把当前所有 frame 的题目抓完了
    if (!res.started) {
      toast(res.count
        ? '这页没有分页，已一次性抓取 ' + res.count + ' 题，新增 ' + (res.added || 0) + ' 题'
        : '这个页面上没有找到题目');
      refresh();
      return;
    }

    toast('已开始翻页抓取，进度看页面右下角面板');
    setTimeout(refresh, 1200);
  }

  /**
   * 连续采集本章。
   * 弹窗一点外面就没了，撑不住整个流程，所以只负责发车；
   * 进度和停止都在页面右下角的面板上。
   */
  async function doStartChain() {
    var res = await askTab({ type: 'DO_START_CHAIN' });
    if (!res || !res.ok) {
      toast('无法开始：' + ((res && res.error) || '当前页面没有响应'), true);
      return;
    }
    toast('已开始连续采集，进度看页面右下角面板');
    window.close();
  }

  async function doStopChain() {
    var res = await askTab({ type: 'DO_STOP_AUTOPAGE' });
    toast(res && res.stopped ? '已停止采集' : '当前没有在跑的任务');
    refresh();
  }

  /** 诊断：把每个 frame 的实际情况列出来 */
  async function doDiagnose() {
    var hint = $('pageHint');
    hint.textContent = '正在检测…';

    var r = await send({ type: 'DIAGNOSE', tabId: activeTab && activeTab.id });
    if (!r || !r.ok) {
      hint.textContent = '检测失败：' + ((r && r.error) || '未知错误');
      return;
    }

    var lines = [];
    var injected = r.frames.filter(function (f) { return f.injected; }).length;
    lines.push('框架 ' + r.frames.length + ' 个，脚本已注入 ' + injected + ' 个');

    r.frames.forEach(function (f) {
      var short = String(f.url || '').replace(/^https?:\/\//, '').split('?')[0];
      if (short.length > 46) short = '…' + short.slice(-45);
      var cnt = f.injected
        ? (f.questions + ' 题' + (f.withAnswer ? '(含答案)' : '(无答案)') + (f.hasNext ? ' 有下一页' : ''))
        : '脚本未注入';
      lines.push('  [' + f.frameId + '] ' + cnt + ' — ' + short);
    });

    var withNext = r.frames.filter(function (f) { return f.hasNextSection; });
    if (withNext.length) {
      withNext.forEach(function (f) {
        lines.push('  [' + f.frameId + '] 「' + f.nextSection.label + '」· 经 ' + f.nextSection.via + ' 识别');
      });
    } else {
      lines.push('  ⚠ 没找到「下一节」按钮，连续采集用不了');
    }

    lines.push('题库总计 ' + r.totalQuestions + ' 题 · 自动抓取' + (r.autoOn === false ? '已关闭' : '已开启'));

    if (r.totalQuestions === 0) {
      lines.push('题目为 0：确认当前是「章节测验/作业」的作答页，章节主页本身不含题目。');
    }

    hint.textContent = lines.join('\n');
    hint.style.whiteSpace = 'pre-wrap';
    hint.style.fontFamily = 'ui-monospace, Consolas, monospace';
    hint.style.fontSize = '11px';
    hint.style.lineHeight = '1.6';
  }

  async function refresh() {
    var sum = await send({ type: 'GET_SUMMARY' });
    var banksRes = await send({ type: 'GET_BANKS' });
    if (sum && sum.ok) renderSummary(sum);
    if (banksRes && banksRes.ok) renderBanks(banksRes.banks || {});
    $('btnGrab').disabled = !IS_CHAOXING;

    // 这里不要再调 detectPage()。
    // 它会重新做一遍 tabs.query + PING + CHECK_LOGIN，而页面状态在一次抓取前后
    // 根本不会变；更糟的是它会把 pageHint 覆盖掉 —— 刚跑完「诊断」的内容
    // 会被一句话冲掉。boot() 里已经检测过了，弹窗一失焦就销毁，不存在页面变了的情况。
  }

  /* ================================================================ *
   * 启动
   * ================================================================ */

  async function boot() {
    var s = await send({ type: 'GET_SETTINGS' });
    var settings = (s && s.settings) || {};
    $('setAuto').checked = settings.autoCapture !== false;
    $('setAutoTab').checked = settings.openQuizTab !== false;
    $('setBadge').checked = settings.showBadge !== false;

    $('setAuto').onchange = function () { saveSettings(); toast(this.checked ? '已开启自动抓取' : '已关闭自动抓取'); };
    $('setAutoTab').onchange = function () {
      saveSettings();
      toast(this.checked ? '章节页会自动切到「章节测验」抓完再切回' : '已关闭自动开标签');
    };
    $('setBadge').onchange = function () { saveSettings(); };

    function saveSettings() {
      send({
        type: 'SET_SETTINGS',
        settings: Object.assign({}, settings, {
          autoCapture: $('setAuto').checked,
          openQuizTab: $('setAutoTab').checked,
          showBadge: $('setBadge').checked
        })
      });
    }

    $('btnGrab').onclick = function () { doGrab(true); };
    $('btnGrabAll').onclick = doGrabAll;
    $('btnDiag').onclick = doDiagnose;
    $('btnChain').onclick = doStartChain;
    $('btnStopChain').onclick = doStopChain;
    $('btnOpen').onclick = function () { send({ type: 'OPEN_PRACTICE' }); window.close(); };

    $('btnExportAll').onclick = function () {
      send({ type: 'EXPORT' }).then(function (res) {
        toast(res && res.ok ? '已导出 ' + res.count + ' 题' : '导出失败：' + ((res && res.error) || ''), !(res && res.ok));
      });
    };

    $('btnClear').onclick = function () {
      if (!confirm('清空全部题库？此操作不可撤销。练习进度不受影响。')) return;
      send({ type: 'CLEAR_BANKS' }).then(function () {
        toast('题库已清空');
        refresh();
      });
    };

    await refresh();
    await detectPage();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
