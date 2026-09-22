#!/usr/bin/env node
/**
 * 「自动打开章节测验标签」的回归测试。
 *
 *   node tools/tab-test.mjs
 *
 * 超星的章节页把测验藏在页内标签里，不点开题目就不会加载。
 * 这个功能就是自动切过去抓完再切回来 —— 但页面上到处都有「章节测验」四个字
 * （左侧目录树里每个章节挂一个），点错就跳到别的章节去了。
 *
 * 五种场景各跑一遍：
 *   chapter  停在视频标签、没有题目   → 自动切到章节测验 → 抓到 → 切回视频，且只切一次
 *   already  章节测验已经开着         → 一次都不点
 *   notabs   没有标签栏只有诱饵       → findQuizTab() 必须返回 null
 *   off      用户关掉了这个功能       → 一次都不点
 *   chain    连续采集本章             → 逐节推进、跳过没有测验的小节、到章末就停
 *
 * 环境变量：
 *   EDGE_PATH   指定浏览器路径
 *   KEEP_TMP=1  保留临时目录
 */

import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findEdge, dumpDom, extractResult, printResult, safeRm } from './lib/headless.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'tools', '.tmp',
  '.tabtest-' + Date.now().toString(36) + '-' + process.pid);

// 收尾要不要删临时目录。这个环境有「单回合批量删除」保护，
// 反复跑测试会把配额用光，所以留个开关跳过。
const NO_CLEAN = process.env.NO_CLEAN === '1' || process.env.KEEP_TMP === '1';

const MODES = [
  { name: 'chapter', desc: '停在视频标签，应自动切换并抓取后切回' },
  { name: 'already', desc: '章节测验已打开，不应有任何点击' },
  { name: 'notabs', desc: '没有标签栏只有目录诱饵，绝不能乱点' },
  { name: 'off', desc: '用户关掉了自动开标签，不应有任何点击' },
  { name: 'chain', desc: '连续采集本章：逐节推进、跳过空节、不跨章', budget: 90000 },
  {
    name: 'nextbtn', desc: '「下一节」按钮的六种写法都得认得出来',
    fixture: 'next-button.html', runner: 'nextbtn', budget: 20000, noContent: true
  }
];

/**
 * 共享文件只在开跑前拷一次。
 * 每个场景都拷一遍的话，覆盖已有文件会被 node 的安全删除垫片记账，
 * 同一回合累计到阈值就直接抛错。
 */
async function prepareShared() {
  await mkdir(TMP, { recursive: true });

  // 夹具里的 <script src="core.js"> 是同目录相对路径
  await cp(join(ROOT, 'site', 'js', 'core.js'), join(TMP, 'core.js'));
  await cp(join(ROOT, 'extension', 'src', 'content', 'extractor.js'), join(TMP, 'extractor.js'));
  await cp(join(ROOT, 'extension', 'src', 'content', 'content.js'), join(TMP, 'content.js'));
  await cp(join(ROOT, 'tools', 'lib', 'chrome-stub.js'), join(TMP, 'chrome-stub.js'));

  // runner 每个场景不同，用各自的名字，别互相覆盖
  for (const mode of MODES) {
    const runnerFile = mode.runner ? mode.runner + '-test-runner.js' : 'tab-test-runner.js';
    await cp(join(ROOT, 'tools', runnerFile), join(TMP, 'runner-' + mode.name + '.js'));
  }
}

async function buildPage(mode) {
  let html = await readFile(join(ROOT, 'tools', 'fixtures', mode.fixture || 'chapter-page.html'), 'utf8');

  // 模式要在夹具自己的脚本之前定好，否则它读不到
  html = html.replace(/<head([^>]*)>/,
    '<head$1>\n<script>window.__MODE = ' + JSON.stringify(mode.name) + ';</script>');

  // content.js 必须排在夹具脚本之后、runner 之前；
  // chrome 桩必须在 content.js 之前，否则它一加载就炸。
  // 有些夹具（next-button）不需要 content.js，就不注入
  var runnerTag = '<script src="runner-' + mode.name + '.js"></script>';
  var inject = mode.noContent
    ? runnerTag + '\n</body>'
    : '<script src="chrome-stub.js"></script>\n' +
      '<script src="content.js"></script>\n' +
      runnerTag + '\n</body>';

  html = html.replace('</body>', inject);

  const page = join(TMP, 'page-' + mode.name + '.html');
  await writeFile(page, html, 'utf8');
  return page;
}

async function main() {
  const edge = findEdge();
  if (!edge) {
    console.error('找不到可用的浏览器。设置环境变量 EDGE_PATH 后重试。');
    process.exit(2);
  }
  console.log('浏览器：' + edge);

  await prepareShared();

  let totalPass = 0, totalFail = 0;
  const allFailures = [];

  for (const mode of MODES) {
    console.log('\n' + '='.repeat(56));
    console.log('场景 ' + mode.name + ' —— ' + mode.desc);
    console.log('='.repeat(56));

    const page = await buildPage(mode);

    let dom;
    try {
      // 端到端链路（首次扫描 + 防抖 + 回切）大约 6 秒，虚拟时间给足
      dom = await dumpDom(page, {
        edgePath: edge,
        profileTag: 'tab-' + mode.name,
        virtualTimeBudget: mode.budget || 40000,
        timeout: 120000,
        verbose: process.env.VERBOSE === '1'
      });
    } catch (e) {
      console.error('浏览器执行失败：' + e.message);
      totalFail++;
      allFailures.push(mode.name + ' — 浏览器执行失败：' + e.message);
      continue;
    }

    const result = extractResult(dom);
    if (!result) {
      console.error('没拿到测试结果，页面脚本可能在初始化阶段就崩了。');
      console.error(dom.slice(0, 1200));
      totalFail++;
      allFailures.push(mode.name + ' — 页面无输出');
      continue;
    }

    const { pass, fail, failures } = printResult(result);
    totalPass += pass;
    totalFail += fail;
    failures.forEach(f => allFailures.push('[' + mode.name + '] ' + f));
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${totalPass} 项，失败 ${totalFail} 项`);

  if (totalFail) {
    console.log('\n失败明细：');
    allFailures.forEach(f => console.log('  · ' + f));
    console.log('\n临时目录保留在 ' + TMP + '，可用浏览器直接打开 page-*.html 复现。');
    process.exit(1);
  }

  if (NO_CLEAN) {
    console.log('临时目录保留在 ' + TMP);
  } else if (!(await safeRm(TMP))) {
    // 被别的进程占着就会删不掉。说一声，别让人以为已经清干净了
    console.log('临时目录没清掉（可能被占用），仍在 ' + TMP);
  }

  console.log('全部通过。');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
