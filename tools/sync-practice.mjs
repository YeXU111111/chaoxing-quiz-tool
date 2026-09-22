#!/usr/bin/env node
/**
 * 把 site/ 下的刷题站同步两份产物：
 *
 *   1. extension/src/practice/    —— 扩展内置版（题库从 chrome.storage 读，与抓取实时同步）
 *   2. extension/src/shared/schema.js —— 站点核心逻辑的副本，给 content script / SW 复用
 *
 * 为什么要同步而不是引用：MV3 的扩展包只能加载包内文件，跨目录引用做不到。
 * 所以 site/ 是唯一源，这里是单向复制。改完 site/ 记得跑一次：
 *
 *   node tools/sync-practice.mjs
 *
 * 站点代码靠 store.js 里的 IN_EXTENSION 判断运行环境，两份产物代码完全相同，
 * 不存在「扩展版和网站版行为不一致」的问题。
 */

import { cp, mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const DEST_PRACTICE = join(ROOT, 'extension', 'src', 'practice');
const DEST_SCHEMA = join(ROOT, 'extension', 'src', 'shared', 'schema.js');

const FILES = [
  'index.html',
  'styles.css',
  'js/core.js',
  'js/store.js',
  'js/engine.js',
  'js/importer.js',
  'js/ui.js',
  'js/sample.js'
];

async function main() {
  if (!existsSync(SITE)) {
    console.error('找不到 site/ 目录，确认在项目根目录执行');
    process.exit(1);
  }

  await mkdir(join(DEST_PRACTICE, 'js'), { recursive: true });
  await mkdir(dirname(DEST_SCHEMA), { recursive: true });

  let copied = 0;
  for (const rel of FILES) {
    const src = join(SITE, rel);
    if (!existsSync(src)) {
      console.warn('  跳过（不存在）:', rel);
      continue;
    }
    const dst = join(DEST_PRACTICE, rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    const st = await stat(dst);
    console.log('  ->', 'extension/src/practice/' + rel, `(${st.size}B)`);
    copied++;
  }

  // core.js 同时作为扩展侧的 schema 副本
  await copyFile(join(SITE, 'js', 'core.js'), DEST_SCHEMA);
  console.log('  ->', 'extension/src/shared/schema.js');

  const htmlPath = join(DEST_PRACTICE, 'index.html');
  let html = await readFile(htmlPath, 'utf8');

  // 剥掉 MathJax 的 CDN 引用。
  //
  // MV3 扩展页面的默认 CSP 是 `script-src 'self'`，远程脚本会被浏览器直接拦掉 ——
  // 这行在扩展里是死的，留着只会每次打开都刷一条 CSP 报错，还会误导人以为公式能渲染。
  // 独立站（site/）没有 CSP 限制，那边继续用它。
  const MATHJAX_BLOCK = /<!-- MathJax[\s\S]*?-->\s*<script>[\s\S]*?<\/script>\s*<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax[^"]*"[^>]*><\/script>/;
  const MATHJAX_NOTE = [
    '<!-- MathJax 在扩展页面里用不了：MV3 默认 CSP 是 script-src \'self\'，远程脚本会被拦掉，',
    '     而且上架政策也不允许远程加载代码。所以公式会以原始文本显示（$x^2$ 原样呈现），',
    '     不影响做题。想要渲染公式，得把 MathJax 打包进扩展本地再引用。',
    '     独立站版本（site/index.html）没有这个限制，那边照常渲染。 -->'
  ].join('\n      ');

  if (MATHJAX_BLOCK.test(html)) {
    html = html.replace(MATHJAX_BLOCK, MATHJAX_NOTE);
  } else if (html.indexOf('mathjax') >= 0) {
    console.warn('  ⚠ 没匹配到 MathJax 片段 —— site/index.html 的结构可能改过，去检查一下');
  }

  // 在扩展副本的 HTML 顶部插一段注释，避免以后有人直接改这份产物
  const BANNER = '<!-- ⚠ 这是 tools/sync-practice.mjs 生成的副本，不要直接改这个文件。\n     源文件在 site/index.html，改完执行 node tools/sync-practice.mjs 重新同步。 -->\n';
  if (!html.startsWith('<!-- ⚠')) html = BANNER + html;

  await writeFile(htmlPath, html, 'utf8');

  console.log(`\n同步完成：${copied} 个文件`);
}

main().catch(e => { console.error(e); process.exit(1); });
