#!/usr/bin/env node
/**
 * 在真实 Edge 里跑刷题站的界面集成测试。
 *
 *   node tools/browser-test.mjs
 *
 * 做法：
 *   1. 把 site/ 下的产物拷到一个临时目录
 *   2. 在 index.html 末尾追加测试脚本
 *   3. 用 msedge --headless --dump-dom 打开它，把测试结果读回来
 *
 * 为什么不直接在 site/ 里塞测试页：那个目录是交付物，要保持干净。
 * 为什么不改动 site/index.html 的内容：我们要测的就是用户真正会打开的那个页面，
 * 只追加脚本、不修改结构。
 *
 * 环境变量：
 *   EDGE_PATH   指定 msedge.exe 路径
 *   KEEP_TMP=1  保留临时目录，方便查问题
 */

import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findEdge, dumpDom, extractResult, printResult, safeRm } from './lib/headless.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const TMP = join(ROOT, 'tools', '.tmp',
  '.uitest-' + Date.now().toString(36) + '-' + process.pid);

// 收尾要不要删临时目录。这个环境有「单回合批量删除」保护，
// 反复跑测试会把配额用光，所以留个开关跳过。
const NO_CLEAN = process.env.NO_CLEAN === '1' || process.env.KEEP_TMP === '1';

async function buildTestPage() {
  // 目录是本次运行独有的，不需要前置清理
  await mkdir(join(TMP, 'js'), { recursive: true });

  await cp(join(SITE, 'styles.css'), join(TMP, 'styles.css'));
  for (const f of await readdir(join(SITE, 'js'))) {
    await cp(join(SITE, 'js', f), join(TMP, 'js', f));
  }
  await cp(join(ROOT, 'tools', 'ui-test-browser.js'), join(TMP, '__runner.js'));

  let html = await readFile(join(SITE, 'index.html'), 'utf8');

  // 去掉 MathJax CDN：无头环境没网，外链会把加载卡住直到超时
  html = html.replace(/<script[^>]*src="https:\/\/[^"]*"[^>]*><\/script>/g, '');
  html = html.replace(/<script>\s*window\.MathJax[\s\S]*?<\/script>/, '');

  // 注入测试脚本（放在最后，等所有站点脚本都执行完）
  if (!html.includes('__runner.js')) {
    html = html.replace('</body>', '<script src="__runner.js"></script>\n</body>');
  }

  await writeFile(join(TMP, 'index.html'), html, 'utf8');
}

async function main() {
  const edge = findEdge();
  if (!edge) {
    console.error('找不到 Edge。设置环境变量 EDGE_PATH 指向 msedge.exe 后重试。');
    process.exit(2);
  }
  console.log('浏览器：' + edge);

  console.log('构建测试页…');
  await buildTestPage();

  console.log('运行…\n');
  const dom = await dumpDom(join(TMP, 'index.html'), {
    edgePath: edge,
    profileTag: 'uitest',
    virtualTimeBudget: 20000,
    verbose: process.env.VERBOSE === '1'
  });
  const result = extractResult(dom);

  if (!result) {
    console.error('没拿到测试结果。可能页面脚本在初始化阶段就崩了。');
    console.error('DOM 片段：');
    console.error(dom.slice(0, 1500));
    process.exit(1);
  }

  const { pass, fail, failures } = printResult(result);

  console.log('\n' + '─'.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);

  if (fail) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log('  · ' + f));
    console.log('\n临时目录保留在 ' + TMP + '，可直接用浏览器打开排查。');
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
