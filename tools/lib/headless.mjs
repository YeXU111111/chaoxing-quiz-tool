/**
 * 无头浏览器测试的公共部分。
 *
 * 不依赖 puppeteer / playwright —— 直接用系统自带的 Edge。
 * 详见 skill: headless-browser-ui-test
 *
 * ★ 这里刻意用 spawn 而不是 execFile。
 *   execFile 的 timeout 只杀直接子进程，而 msedge.exe 是个启动器 ——
 *   它退出后真正的浏览器进程还活着并占着 stdout 管道，
 *   node 就会一直等下去（实测挂过 6 分钟）。
 *   必须自己拿 PID 去杀整棵进程树，并且自己上计时器。
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

export function findEdge() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

export function fileUrl(p) {
  return 'file:///' + String(p).replace(/\\/g, '/');
}

function killTree(pid) {
  return new Promise(resolve => {
    if (pid == null) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (e) {
        try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* 已经退了 */ }
      }
      resolve();
    }
  });
}

/** 找一个可用的 powershell.exe。PATH 上不一定有，所以优先用绝对路径。 */
function findPowerShell() {
  if (process.platform !== 'win32') return null;
  const root = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    process.env.PSHOME,
    root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    root + '\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
    'powershell.exe'
  ].filter(Boolean);
  for (const p of candidates) if (p === 'powershell.exe' || existsSync(p)) return p;
  return null;
}

/**
 * 按命令行里的唯一标记杀掉浏览器进程。尽力而为，失败也不抛。
 *
 * 背景：msedge.exe 是启动器，它 fork 出真正的浏览器进程后自己先退出。
 * 所以「直接子进程已结束」不代表浏览器没了 —— 它可能还活着、还占着
 * --user-data-dir。实测症状是：测试全部通过、结果也打印完了，
 * 但进程卡在最后的 rm -rf 上不动，一挂十分钟。
 * taskkill /PID 也没用，因为拿到的 PID 早就退了。
 *
 * 注意这只是一个「锦上添花」的手段：某些环境下（沙箱、无 powershell）
 * 根本调不通，所以真正兜底的是 safeRm() 的超时，不能指望这里。
 */
async function killByToken(token) {
  if (!token || process.platform !== 'win32') return;

  const psExe = findPowerShell();
  if (!psExe) return;

  const ps =
    'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.CommandLine -like \'*' + token + '*\' } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';

  await new Promise(resolve => {
    try {
      execFile(psExe, ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, timeout: 20000 }, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

/**
 * 删目录，但**绝不允许卡住**。
 *
 * Windows 上只要还有进程占着目录里的文件，rm 就会一直重试。
 * 测试工具挂死比测试失败糟糕得多 —— 宁可留一个残留目录，也必须让进程退出。
 */
export async function safeRm(dir, ms = 12000) {
  if (!dir) return true;

  // settled = 「这次删除有结果了」，ok = 「结果是真的删掉了」。
  // ★ 这两个必须分开。之前写成一个 done 变量，删除失败也把它置 true，
  //   于是 safeRm 永远返回「清理成功」—— 目录还在，调用方却以为清干净了。
  //   工具对自己撒谎比工具报错更糟糕。
  let settled = false;
  let ok = false;

  rm(dir, { recursive: true, force: true, maxRetries: 2 })
    .then(() => { ok = true; settled = true; })
    .catch(() => { ok = false; settled = true; });

  await Promise.race([
    new Promise(r => { const t = setInterval(() => { if (settled) { clearInterval(t); r(); } }, 100); }),
    new Promise(r => setTimeout(r, ms))
  ]);

  return ok;
}

/** profile 目录放系统临时目录，别放在项目里 —— 万一被占住也影响不到我们的清理 */
export function makeProfileDir(tag) {
  return join(tmpdir(), 'cqb-headless-' + tag + '-' + Date.now() + '-' +
    Math.floor(Math.random() * 1e6));
}

function runOnce(edge, args, timeoutMs, token) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(edge, args, {
        windowsHide: true,
        detached: process.platform !== 'win32'   // 便于按进程组整组杀
      });
    } catch (e) {
      return reject(e);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    /** 无论成功失败，收尾时都要把浏览器进程清干净 */
    const cleanup = async () => {
      await killTree(child.pid);
      await killByToken(token);
    };

    const finish = async (err, out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await cleanup();
      err ? reject(err) : resolve(out);
    };

    const timer = setTimeout(() => {
      finish(new Error('浏览器在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有返回，已强制结束'));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

    child.on('error', e => finish(e));

    child.on('close', code => {
      if (settled) return;
      if (!stdout.trim()) {
        finish(new Error('浏览器没有输出内容（退出码 ' + code + '）：' + stderr.slice(0, 400)));
        return;
      }
      finish(null, stdout);
    });
  });
}

/**
 * 用无头浏览器打开一个本地页面，返回转储出来的 DOM。
 *
 * 两个参数最关键，缺一个测试就会莫名其妙地失败：
 *   --virtual-time-budget  让虚拟时钟快进，把所有 setTimeout 跑完再转储。
 *                          不加的话 --dump-dom 在 load 事件后就转储了，
 *                          测试还没开始跑就结束了。
 *   --window-size          默认是 800x600，会触发页面的响应式断点，
 *                          所有桌面布局的断言都会挂。
 *
 * 每次尝试都用全新的 profile 目录：
 * 上一轮如果被强杀，旧 profile 可能还锁着，复用会直接卡住。
 */
export async function dumpDom(pagePath, opts = {}) {
  const edge = opts.edgePath || findEdge();
  if (!edge) throw new Error('找不到可用的浏览器，请设置环境变量 EDGE_PATH');

  const perTryTimeout = opts.timeout || 90000;
  const target = fileUrl(pagePath);
  const tag = opts.profileTag || 'run';

  // 先把上一轮崩掉时留下的浏览器收掉（尽力而为，失败不影响本轮）
  await killByToken('cqb-headless-' + tag);

  // 第一次用 new headless；失败或超时就换旧参数再试一次。
  // 两次都失败才报错 —— headless 偶尔会莫名卡一次，不值得让人重跑整个套件。
  const attempts = [
    { label: 'headless=new', flag: 'new' },
    { label: 'headless=old', flag: 'old' }
  ];

  const problems = [];

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    // 每次唯一、且落在系统临时目录：被占住也污染不到项目目录
    const profile = makeProfileDir(tag + '-' + i);

    const args = [
      '--headless=' + a.flag,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-crash-reporter',
      '--force-device-scale-factor=1',
      '--window-size=' + (opts.windowSize || '1440,1000'),
      '--virtual-time-budget=' + (opts.virtualTimeBudget || 20000),
      '--user-data-dir=' + profile,
      '--dump-dom',
      target
    ];

    try {
      // 把 profile 路径当令牌传下去，收尾时按它精确杀进程
      return await runOnce(edge, args, perTryTimeout, profile);
    } catch (e) {
      problems.push(a.label + '：' + e.message);
      if (opts.verbose) console.error('  [' + a.label + '] ' + e.message);
    }
  }

  throw new Error('浏览器执行失败\n  ' + problems.join('\n  '));
}

/** 从转储的 DOM 里抠出测试结果 */
export function extractResult(dom, id = '__result') {
  const re = new RegExp('<pre id="' + id + '">([\\s\\S]*?)</pre>');
  const m = dom.match(re);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** 把 `PASS xxx` / `FAIL xxx` / `# 分组` 格式的结果打印出来 */
export function printResult(result) {
  let pass = 0, fail = 0;
  const failures = [];

  for (const line of result.split('\n')) {
    if (line.startsWith('# ')) { console.log('\n【' + line.slice(2) + '】'); continue; }
    if (line.startsWith('PASS ')) { pass++; console.log('  ✓ ' + line.slice(5)); continue; }
    if (line.startsWith('FAIL ')) {
      fail++;
      const [name, detail] = line.slice(5).split(' :: ');
      failures.push(name + (detail ? ' — ' + detail : ''));
      console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
      continue;
    }
    if (line.startsWith('===SUMMARY')) continue;
    if (line.trim()) console.log('    ' + line);
  }

  return { pass, fail, failures };
}
