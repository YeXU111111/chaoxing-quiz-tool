/*!
 * service-worker.js —— MV3 后台（非持久）
 *
 * 职责很窄：
 *   1. 所有题库写入的唯一入口（content script 只上报，不直接写 storage）。
 *      这么做是为了让「去重 / 合并 / 排序」只有一份实现，避免多 frame 并发写坏数据。
 *   2. 跨 frame 汇总抓取。
 *   3. 徽标计数、打开刷题台、导出下载。
 *
 * 注意：MV3 的 SW 随时会被杀掉，所以这里不能有任何内存态。
 * 所有状态都放 chrome.storage.local，每次收到消息现读现写。
 */

importScripts('/src/shared/schema.js');

const CQB = self.CQB;

const BANKS_KEY = 'banks';
const SETTINGS_KEY = 'settings';

const DEFAULT_SETTINGS = {
  autoCapture: true,        // 打开作业页自动抓
  openQuizTab: true,        // 章节页没有题目时，自动点开「章节测验」标签抓完再切回来
  autoPage: false,          // 自动翻页（默认关，太激进）
  pageDelayMs: 1000,
  showBadge: true
};

/* ================================================================== *
 * 存储
 * ================================================================== */

async function getBanks() {
  const res = await chrome.storage.local.get(BANKS_KEY);
  return res[BANKS_KEY] || {};
}

async function setBanks(banks) {
  await chrome.storage.local.set({ [BANKS_KEY]: banks });
}

async function getSettings() {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY] || {});
}

/* ================================================================== *
 * 核心：写入并合并
 * ================================================================== */

/**
 * 收到一批题目 → 合并进对应题库。
 * 返回 { ok, added, updated, total, totalBanks, totalQuestions }。
 *
 * 并发安全说明：MV3 里多个 frame 可能几乎同时发 CAPTURE。
 * 这里没有加锁 —— 因为 chrome.storage 的读改写窗口极短（毫秒级），
 * 而且 content 侧已经按题干哈希做过一次去重；
 * 最坏情况是同一题被合并两次，而 mergeIntoBank 是幂等的（同 ID 覆盖），
 * 不会丢数据，也不会出现重复题。
 */
/*
 * 所有写题库的操作排进同一条串行队列。
 *
 * capture 是「读 → 合并 → 写」三步。两个 CAPTURE 几乎同时到达时
 * ——超星章节页里顶层帧和 iframe 会各自上报一次，这是常态——
 * 两次读都可能拿到同一份旧状态，后写的那次把先写的整批覆盖掉，题目就这么丢了。
 *
 * mergeIntoBank 的幂等只保证「同 ID 覆盖」，救不了「读改写穿插」。
 * MV3 的 service worker 虽然是单线程，但 await 之间照样会让出控制权，
 * 所以这里必须自己排队。
 */
let captureChain = Promise.resolve();

function capture(payload) {
  const task = captureChain.then(
    () => doCapture(payload),
    () => doCapture(payload)     // 上一次失败了也不能卡住队列
  );
  captureChain = task.catch(() => {});
  return task;
}

async function doCapture(payload) {
  if (!payload || !payload.bankId) return { ok: false, error: '缺少 bankId' };

  const banks = await getBanks();
  const r = CQB.mergeIntoBank(banks, payload);
  await setBanks(r.banks);

  const summary = summarize(r.banks);
  await updateBadge(summary.totalQuestions);

  return Object.assign({ ok: true }, r, summary);
}

function summarize(banks) {
  const ids = Object.keys(banks || {});
  let total = 0, withAnswer = 0;
  ids.forEach(id => {
    banks[id].questions.forEach(q => {
      total++;
      if (q.hasAnswer) withAnswer++;
    });
  });
  return { totalBanks: ids.length, totalQuestions: total, withAnswer };
}

async function updateBadge(n) {
  const s = await getSettings();
  try {
    if (!s.showBadge) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' });
    await chrome.action.setBadgeText({ text: n > 0 ? (n > 999 ? '999+' : String(n)) : '' });
  } catch (e) {
    // setBadgeText 在 SW 冷启动瞬间偶尔会抛，忽略即可
  }
}

/* ================================================================== *
 * 跨 frame 汇总抓取
 * ================================================================== */

/**
 * 题目经常整个装在 iframe 里（超星的章节内嵌作业就是这样）。
 * 顶层 frame 抓不到东西时，这里挨个问一遍所有 frame，把结果汇总合并。
 *
 * 冗余处理：同一个题库里的题目按题干哈希去重，
 * 所以就算多个 frame 报回了重叠内容也不会污染题库。
 */
async function listFrames(tabId) {
  try {
    return await chrome.webNavigation.getAllFrames({ tabId });
  } catch (e) {
    return [{ frameId: 0 }];
  }
}

/**
 * 挨个问所有 frame 要题目，汇总。
 *
 * dryRun: true 时只返回结果、不落库 —— 翻页循环每一步都要来问一次，
 * 不能每问一次就写一遍 storage。
 */
async function scanAllFrames(tabId, opts) {
  opts = opts || {};
  if (tabId == null) return { ok: false, error: '没拿到标签页 ID' };

  const frames = await listFrames(tabId);

  const results = await Promise.all(frames.map(f =>
    chrome.tabs.sendMessage(tabId, { type: 'DO_SCAN' }, { frameId: f.frameId })
      .catch(() => null)
  ));

  const all = [];
  let context = null;
  results.forEach(r => {
    if (!r || !r.ok || !r.questions || !r.questions.length) return;
    if (!context) context = r.context;
    r.questions.forEach(q => all.push(Object.assign({}, q, { sourceUrl: r.pageUrl })));
  });

  // 所有 frame 的题干合起来算一个指纹，翻页循环用它判断「页面到底换没换」
  const signature = CQB.hash64(all.map(q => q.stem).join('|'));

  if (opts.dryRun) {
    return { ok: true, count: all.length, questions: all, context, signature, frames: frames.length };
  }

  if (!all.length) return { ok: true, count: 0, signature, frames: frames.length };

  const res = await capture({
    bankId: [context.courseId || 'nocourse', context.workId || context.workTitle || 'nowork'].join('::'),
    courseId: context.courseId,
    courseName: context.courseName,
    workId: context.workId,
    workTitle: context.workTitle,
    kind: context.kind,
    chapter: context.chapter,
    sourceUrl: context.sourceUrl,
    capturedAt: new Date().toISOString(),
    questions: all
  });

  return Object.assign({ ok: true, count: all.length, signature }, res);
}

/* ================================================================== *
 * 整卷翻页抓取
 * ================================================================== */

/**
 * 翻页循环必须跑在「握着下一题按钮的那个帧」里 ——
 * 超星常把整个作业塞进跨域 iframe，顶层根本碰不到那个按钮。
 *
 * 这里只做两件事：挑帧、发车。循环本身在 content script 里跑，
 * 跑完它再通过 AUTOPAGE_DONE 回报。
 *
 * 为什么不等结果：一整套卷子翻完可能要几分钟，
 * 而 MV3 的 service worker 单个事件有 5 分钟上限，挂在一条消息上等会被杀。
 * 所以这里立刻返回，用回调收尾。
 */
async function startAutoPage(tabId) {
  // 弹窗发来的消息没有 sender.tab，必须由调用方显式传 tabId，
  // 否则这里是 undefined，chrome.webNavigation 会直接抛
  if (tabId == null) return { ok: false, error: '没拿到标签页 ID，请重新打开扩展弹窗' };

  const frames = await listFrames(tabId);

  const probes = await Promise.all(frames.map(f =>
    chrome.tabs.sendMessage(tabId, { type: 'DO_CAN_PAGE' }, { frameId: f.frameId })
      .catch(() => null)
  ));

  const cands = frames
    .map((f, i) => ({ frameId: f.frameId, url: frames[i].url, probe: probes[i] }))
    .filter(c => c.probe && c.probe.ok);

  if (!cands.length) {
    return { ok: false, error: '页面脚本未就绪。如果是刚装的扩展，刷新一下学习通页面再试。' };
  }

  // 选执行帧：先要有「下一题」按钮，都有按钮就挑题目多的那个
  const score = c => (c.probe.hasNext ? 1000 : 0) + (c.probe.blocks || 0);
  cands.sort((a, b) => score(b) - score(a));
  const target = cands[0];

  /*
   * 没有「下一题」按钮，不代表没东西可抓。
   * 章节测验、单页作业、已经翻到最后一题的页面都是这样 ——
   * 之前这里直接返回错误、一题都不抓，用户点一次白点一次。
   * 现在退化成「把当前所有 frame 的题目一次性抓下来」。
   */
  if (!target.probe.hasNext) {
    const res = await scanAllFrames(tabId);

    if (!res.ok) return { ok: false, error: res.error || '抓取失败' };

    return {
      ok: true,
      started: false,
      noPaging: true,
      count: res.count || 0,
      added: res.added || 0,
      updated: res.updated || 0,
      pages: res.count ? 1 : 0,
      endedCode: 'single-page',
      endedReason: '这些页面里没有「下一题」按钮，已改为一次性抓取当前页面上所有框架的题目'
    };
  }

  const started = await chrome.tabs.sendMessage(
    tabId, { type: 'DO_AUTOPAGE' }, { frameId: target.frameId }
  ).catch(e => ({ ok: false, error: e.message }));

  if (!started || !started.ok) {
    return { ok: false, error: (started && started.error) || '无法在该页面启动翻页任务' };
  }

  return { ok: true, started: true, frameId: target.frameId, framesProbed: cands.length };
}

/**
 * 诊断：把每个 frame 的实际情况摊开。
 * 用于排查「自动抓取没反应」这类本地复现不了的问题。
 */
async function diagnose(tabId) {
  if (tabId == null) return { ok: false, error: '没拿到标签页 ID' };

  const frames = await listFrames(tabId);
  const probes = await Promise.all(frames.map(f =>
    chrome.tabs.sendMessage(tabId, { type: 'DO_DIAGNOSE' }, { frameId: f.frameId }).catch(() => null)
  ));

  const banks = await getBanks();
  const sum = summarize(banks);
  const settings = await getSettings();

  return {
    ok: true,
    autoOn: settings.autoCapture !== false,
    totalBanks: sum.totalBanks,
    totalQuestions: sum.totalQuestions,
    withAnswer: sum.withAnswer,
    frames: frames.map((f, i) => {
      const p = probes[i];
      return {
        frameId: f.frameId,
        url: f.url || '',
        injected: !!(p && p.ok),
        questions: p && p.ok ? p.questions : -1,
        withAnswer: p && p.ok ? p.withAnswer : 0,
        hasNext: p && p.ok ? p.hasNext : false,
        hasNextSection: p && p.ok ? !!p.hasNextSection : false,
        nextSection: p && p.ok ? (p.nextSection || null) : null,
        sectionKey: p && p.ok ? (p.sectionKey || '') : '',
        loggedIn: p && p.ok ? p.loggedIn : null,
        bankId: p && p.ok ? p.bankId : ''
      };
    })
  };
}

async function stopAutoPage(tabId) {
  if (tabId == null) return { ok: false, error: '没拿到标签页 ID' };
  const frames = await listFrames(tabId);
  const results = await Promise.all(frames.map(f =>
    chrome.tabs.sendMessage(tabId, { type: 'DO_STOP_AUTOPAGE' }, { frameId: f.frameId }).catch(() => null)
  ));
  return { ok: true, stopped: results.some(r => r && r.stopped) };
}

/**
 * 执行帧跑完后的收尾：落库 + 把结果转给 TOP 帧的面板展示。
 */
async function finishAutoPage(payload, sender) {
  if (!payload || !payload.ok) {
    return { ok: false, error: (payload && payload.error) || '翻页任务异常结束' };
  }

  const tabId = sender && sender.tab && sender.tab.id;
  let summary = {
    ok: true,
    count: payload.questions ? payload.questions.length : 0,
    added: 0,
    updated: 0,
    pages: payload.pages || 0,
    endedReason: payload.endedReason || '',
    endedCode: payload.endedCode || '',
    aborted: !!payload.aborted
  };

  if (summary.count) {
    const ctx = payload.context || {};
    const saved = await capture({
      bankId: [ctx.courseId || 'nocourse', ctx.workId || ctx.workTitle || 'nowork'].join('::'),
      courseId: ctx.courseId,
      courseName: ctx.courseName,
      workId: ctx.workId,
      workTitle: ctx.workTitle,
      kind: ctx.kind,
      chapter: ctx.chapter,
      sourceUrl: ctx.sourceUrl,
      capturedAt: ctx.capturedAt,
      questions: payload.questions
    });
    summary.added = saved.added || 0;
    summary.updated = saved.updated || 0;
  }

  // 结果统一交给 TOP 帧的面板显示（执行帧可能是某个 iframe）
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'AUTOPAGE_DONE', payload: summary }, { frameId: 0 })
      .catch(() => {});
  }

  return summary;
}

/* ================================================================== *
 * 导出
 * ================================================================== */

async function exportBanks(bankId) {
  const banks = await getBanks();
  const target = bankId && banks[bankId] ? { [bankId]: banks[bankId] } : banks;
  const payload = CQB.buildExport(target);
  if (!payload.stats.questions) return { ok: false, error: '题库为空' };

  const name = 'chaoxing-bank-' +
    (bankId ? bankId.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) + '-' : '') +
    new Date().toISOString().slice(0, 10) + '.json';

  // data URL 比 Blob URL 稳：SW 被回收时 Blob URL 会失效
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
  await chrome.downloads.download({ url: dataUrl, filename: name, saveAs: true });

  return { ok: true, filename: name, count: payload.stats.questions };
}

/* ================================================================== *
 * 打开刷题台
 * ================================================================== */

async function openPractice(bankId, status) {
  const url = new URL(chrome.runtime.getURL('src/practice/index.html'));
  if (bankId) url.searchParams.set('bank', bankId);
  if (status) url.searchParams.set('status', status);

  // 已经开着就聚焦，避免开一堆标签页
  const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('src/practice/index.html') + '*' });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true, url: url.toString() });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: url.toString() });
  }
  return { ok: true };
}

/* ================================================================== *
 * 消息路由
 * ================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'CAPTURE':
      capture(msg.payload)
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'GET_BANKS':
      getBanks().then(banks => sendResponse({ ok: true, banks })).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'GET_SUMMARY':
      getBanks()
        .then(banks => sendResponse(Object.assign({ ok: true }, summarize(banks))))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'GET_SETTINGS':
      getSettings().then(s => sendResponse({ ok: true, settings: s })).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'SET_SETTINGS':
      chrome.storage.local.set({ [SETTINGS_KEY]: Object.assign({}, msg.settings || {}) })
        .then(async () => {
          await updateBadge(summarize(await getBanks()).totalQuestions);
          sendResponse({ ok: true });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'SCAN_ALL_FRAMES':
      scanAllFrames(msg.tabId || (sender.tab && sender.tab.id), { dryRun: !!msg.dryRun })
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'AUTOPAGE':
      startAutoPage(msg.tabId || (sender.tab && sender.tab.id))
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'DIAGNOSE':
      diagnose(msg.tabId || (sender.tab && sender.tab.id))
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'STOP_AUTOPAGE':
      stopAutoPage(msg.tabId || (sender.tab && sender.tab.id))
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'AUTOPAGE_DONE':
      finishAutoPage(msg.payload, sender)
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'PAGING_PROGRESS':
      // 执行帧 → 后台 → TOP 帧，面板上显示进度
      if (sender.tab && sender.tab.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'PAGING_PROGRESS', payload: msg.payload }, { frameId: 0 })
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return true;

    case 'EXPORT':
      exportBanks(msg.bankId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'OPEN_PRACTICE':
      openPractice(msg.bankId, msg.status).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'CLEAR_BANKS':
      chrome.storage.local.set({ [BANKS_KEY]: {} })
        .then(() => updateBadge(0))
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'TOAST':
      // iframe 里的提示转发到顶层帧展示
      if (sender.tab && sender.tab.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'SHOW_TOAST', message: msg.message, kind: msg.kind }, { frameId: 0 })
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return true;

    case 'DELETE_BANK':
      (async () => {
        const banks = await getBanks();
        delete banks[msg.bankId];
        await setBanks(banks);
        const s = summarize(banks);
        await updateBadge(s.totalQuestions);
        sendResponse(Object.assign({ ok: true }, s));
      })().catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    default:
      sendResponse({ ok: false, error: '未知消息类型：' + msg.type });
  }
});

/* ================================================================== *
 * content script 侧还有一个 SHOW_TOAST 的接收方在 TOP 帧
 * ================================================================== */

// （顶层 content.js 里已注册 onMessage，这里不需要额外处理）

/* ================================================================== *
 * 右键菜单
 * ================================================================== */

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'cqb-scan',
      title: '抓取本页题目到题库',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'cqb-open',
      title: '打开刷题台',
      contexts: ['page']
    });
  });
}

if (chrome.contextMenus) {
  chrome.runtime.onInstalled.addListener(async () => {
    buildMenus();
    const s = await getSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
    await updateBadge(summarize(await getBanks()).totalQuestions);
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'cqb-open') { openPractice(); return; }
    if (info.menuItemId === 'cqb-scan') {
      const res = await scanAllFrames(tab.id).catch(e => ({ ok: false, error: e.message }));
      chrome.tabs.sendMessage(tab.id, {
        type: 'SHOW_TOAST',
        message: res && res.ok
          ? '抓取完成：' + (res.count || 0) + ' 题，新增 ' + (res.added || 0) + ' 题'
          : '抓取失败：' + ((res && res.error) || '未知错误'),
        kind: res && res.ok ? null : 'err'
      }, { frameId: 0 }).catch(() => {});
    }
  });
}

/* 冷启动时把徽标补上（SW 重启后 badge 还在，但数量可能过期） */
chrome.runtime.onStartup.addListener(async () => {
  await updateBadge(summarize(await getBanks()).totalQuestions);
});
