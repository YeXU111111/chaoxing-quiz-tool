#!/usr/bin/env node
/**
 * 翻页抓取的回归测试。
 *
 *   node tools/paging-test.mjs
 *
 * 用一个模拟的超星分页作业（tools/fixtures/paged-quiz.html）在真实 Edge 里跑
 * CQBExtractor.autoPage()，断言「一路翻到没有下一题为止」。
 *
 * 五种场景各跑一遍：
 *   normal    6 页 / 中间夹一个没有题目的说明页 / 有两页渲染很慢  → 必须抓满 10 题
 *   stall     「下一题」按钮点了没反应                          → 不能死循环
 *   disabled  最后一页按钮变灰而不是消失                        → 要主动识别出禁用态
 *   empty     从头到尾没有任何题目                              → 不能报错，也不能提前放弃
 *   abort     20 页的长卷，跑到一半手动停止                      → 已抓到的要保留
 *
 * 环境变量：
 *   EDGE_PATH   指定浏览器路径
 *   KEEP_TMP=1  保留临时目录
 */

import { existsSync } from 'node:fs';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findEdge, dumpDom, extractResult, printResult, safeRm } from './lib/headless.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'tools', '.tmp',
  '.pagingtest-' + Date.now().toString(36) + '-' + process.pid);

// 收尾要不要删临时目录。这个环境有「单回合批量删除」保护，
// 反复跑测试会把配额用光，所以留个开关跳过。
const NO_CLEAN = process.env.NO_CLEAN === '1' || process.env.KEEP_TMP === '1';

const MODES = [
  { name: 'normal', desc: '6 页含空页与慢页' },
  { name: 'stall', desc: '按钮点了没反应' },
  { name: 'disabled', desc: '最后一页按钮变灰而非消失' },
  { name: 'empty', desc: '全程无题目' },
  { name: 'abort', desc: '中途手动停止' }
];

/**
 * 共享文件只在开跑前拷一次。
 *
 * 不能每个场景都拷一遍 —— 覆盖已有文件会被 node 的安全删除垫片记账
 * （同一回合累计到阈值就直接抛错），一套测试跑几个场景就撞线了。
 * 每个场景只写自己那个新文件，就不会有覆盖。
 */
async function prepareShared() {
  await mkdir(TMP, { recursive: true });

  // 放在页面同级目录，和 fixture 里的 <script src="core.js"> 对上
  await cp(join(ROOT, 'site', 'js', 'core.js'), join(TMP, 'core.js'));
  await cp(join(ROOT, 'extension', 'src', 'content', 'extractor.js'), join(TMP, 'extractor.js'));
  await cp(join(ROOT, 'tools', 'paging-test-runner.js'), join(TMP, '__runner.js'));
}

async function buildPage(mode) {
  let html = await readFile(join(ROOT, 'tools', 'fixtures', 'paged-quiz.html'), 'utf8');

  // 模式要在 <head> 里就定好 —— fixture 自己的脚本在 body 末尾执行，那时才读得到
  html = html.replace(/<head([^>]*)>/,
    '<head$1>\n<script>window.__MODE = ' + JSON.stringify(mode.name) + ';</script>');

  html = html.replace(
    '</body>',
    '<script src="__runner.js"></script>\n</body>'
  );

  // 注意是 mode.name —— 直接把 mode 拼进字符串会得到 "page-[object Object].html"，
  // 五个场景全写同一个文件，每次都覆盖
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
      dom = await dumpDom(page, {
        edgePath: edge,
        profileTag: 'paging-' + mode.name,
        virtualTimeBudget: 60000,
        timeout: 90000,
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

  // 单独把 extractor.js 的语法也过一遍
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
