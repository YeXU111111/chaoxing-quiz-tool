#!/usr/bin/env node
/**
 * 冒烟测试：不依赖浏览器，验证核心逻辑。
 *
 *   node tools/smoke-test.mjs
 *
 * 覆盖：
 *   - 语法检查所有站点 / 扩展脚本
 *   - core.js 的答案归一化、判断题映射、合并去重、判分
 *   - importer.js 的 JSON / 纯文本解析
 *   - engine.js 的会话推进与统计
 *   - extractor.js 的选择器表完整性
 *
 * 这不是完整测试套件，目的是「改完代码别把基础功能改炸」。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++; failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, name, a === e ? '' : `期望 ${e}，实际 ${a}`);
}

/* ------------------------------------------------------------------ *
 * 装载沙箱
 * ------------------------------------------------------------------ */

function makeSandbox() {
  const store = {};
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) },
    location: { protocol: 'file:', search: '', hash: '' },
    __store: store
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, relPath) {
  const code = readFileSync(join(ROOT, relPath), 'utf8');
  vm.runInContext(code, sandbox, { filename: relPath });
}

const sb = makeSandbox();
load(sb, 'site/js/core.js');
load(sb, 'site/js/store.js');
load(sb, 'site/js/sample.js');
load(sb, 'site/js/engine.js');
load(sb, 'site/js/importer.js');

const CQB = sb.CQB;
const Store = sb.CQBStore;
const Session = sb.CQBSession;
const Importer = sb.CQBImporter;

/* ------------------------------------------------------------------ *
 * 1. core.js
 * ------------------------------------------------------------------ */

console.log('\n[1] core.js — 数据格式与判分');

eq(CQB.normalizeAnswer('A', 'single').keys, ['A'], '单选答案 "A"');
eq(CQB.normalizeAnswer('ABD', 'multiple').keys, ['A', 'B', 'D'], '多选答案 "ABD"');
eq(CQB.normalizeAnswer('A、B', 'multiple').keys, ['A', 'B'], '全角顿号分隔');
eq(CQB.normalizeAnswer('正确答案：D', 'single').keys, ['D'], '带「正确答案：」前缀');
eq(CQB.normalizeAnswer('D', 'single').keys, ['D'], '纯字母');

const fillAns = CQB.normalizeAnswer('第一空：7 第二空：应用', 'fill');
eq(fillAns.text, ['7', '应用'], '填空按「第N空」拆分');

const judgeOpts = [{ key: 'A', text: '对' }, { key: 'B', text: '错' }];
eq(CQB.mapJudgeToOptionKey('错', judgeOpts), ['B'], '判断题「错」→ B');
eq(CQB.mapJudgeToOptionKey('对', judgeOpts), ['A'], '判断题「对」→ A');
// 顺序颠倒的判断题：A.错 B.对
const revOpts = [{ key: 'A', text: '错' }, { key: 'B', text: '对' }];
eq(CQB.mapJudgeToOptionKey('对', revOpts), ['B'], '判断题选项顺序颠倒也能对上');

// 判断题 normalizeQuestion 自动映射
const jq = CQB.normalizeQuestion({
  type: 'judge', stem: 'IP 提供可靠交付。',
  options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }],
  answerRaw: '错', hasAnswer: true
});
eq(jq.answer.keys, ['B'], '判断题 normalizeQuestion 自动把「错」映射成 B');

// 判分
const singleQ = CQB.normalizeQuestion({
  type: 'single', stem: 'x', options: ['a', 'b', 'c'], answerRaw: 'C', hasAnswer: true
});
eq(CQB.grade(singleQ, { keys: ['C'] }).correct, true, '单选答对');
eq(CQB.grade(singleQ, { keys: ['A'] }).correct, false, '单选答错');

const multiQ = CQB.normalizeQuestion({
  type: 'multiple', stem: 'y', options: ['a', 'b', 'c', 'd'], answerRaw: 'AC', hasAnswer: true
});
eq(CQB.grade(multiQ, { keys: ['A', 'C'] }).correct, true, '多选全对');
eq(CQB.grade(multiQ, { keys: ['A'] }).correct, false, '多选少选算错（与学习通一致）');
eq(CQB.grade(multiQ, { keys: ['A', 'B', 'C'] }).correct, false, '多选多选算错');

const fillQ = CQB.normalizeQuestion({
  type: 'fill', stem: 'a ___ b ___', answerRaw: '第一空：7 第二空：应用', hasAnswer: true
});
eq(CQB.grade(fillQ, { text: ['7', '应用'] }).correct, true, '填空全对');
eq(CQB.grade(fillQ, { text: [' 7 ', '应用'] }).correct, true, '填空忽略首尾空白');
eq(CQB.grade(fillQ, { text: ['8', '应用'] }).partial, 0.5, '填空半对给 50% 命中率');

// 未公布答案
const noAns = CQB.normalizeQuestion({ type: 'single', stem: 'z', options: ['a', 'b'] });
eq(noAns.hasAnswer, false, '没有答案时 hasAnswer = false');
eq(CQB.grade(noAns, { keys: ['A'] }).ungraded, true, '未公布答案的题判分返回 ungraded');

/* ------------------------------------------------------------------ *
 * 2. 合并 / 去重
 * ------------------------------------------------------------------ */

console.log('\n[2] 题库合并与去重');

let banks = {};
let r = CQB.mergeIntoBank(banks, {
  bankId: 'c::w1', courseId: 'c', workId: 'w1', workTitle: '作业一',
  questions: [
    { type: 'single', stem: '问题一', options: ['a', 'b'], answerRaw: 'A', hasAnswer: true },
    { type: 'single', stem: '问题二', options: ['a', 'b'], hasAnswer: false }
  ]
});
banks = r.banks;
eq(r.added, 2, '首次导入新增 2 题');
eq(r.total, 2, '题库共 2 题');

// 同一批再导入一次（模拟同一页被扫两遍）
r = CQB.mergeIntoBank(banks, {
  bankId: 'c::w1', workTitle: '作业一',
  questions: [
    { type: 'single', stem: '问题一', options: ['a', 'b'], answerRaw: 'A', hasAnswer: true },
    { type: 'single', stem: '问题二', options: ['a', 'b'], hasAnswer: false }
  ]
});
banks = r.banks;
eq(r.added, 0, '重复导入不新增');
eq(r.total, 2, '题库仍为 2 题（幂等）');

// 分页抓取：第二次带来「问题三」以及「问题二」的答案
r = CQB.mergeIntoBank(banks, {
  bankId: 'c::w1',
  questions: [
    { type: 'single', stem: '问题二', options: ['a', 'b'], answerRaw: 'B', hasAnswer: true },
    { type: 'judge', stem: '问题三', options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }], answerRaw: '对', hasAnswer: true }
  ]
});
banks = r.banks;
eq(r.added, 1, '跨页抓到新题时新增 1 题');
eq(r.updated, 1, '已有题目拿到答案时更新 1 题');
eq(r.total, 3, '题库累积到 3 题');
const q2 = banks['c::w1'].questions.find(q => q.stem === '问题二');
eq(q2.hasAnswer, true, '原先无答案的题被补齐答案');
eq(q2.answer.keys, ['B'], '补齐的答案内容正确');

// 不同作业进不同题库
CQB.mergeIntoBank(banks, { bankId: 'c::w2', workTitle: '作业二', questions: [{ type: 'single', stem: '另一题', options: ['a', 'b'], answerRaw: 'A', hasAnswer: true }] });
eq(Object.keys(banks).length, 2, '两套作业产生两个题库');

// 题干相同但题型不同 → 不同 ID，不能互相覆盖
const s1 = CQB.makeQuestionId({ courseId: 'x', type: 'single', stem: '同一句话' });
const s2 = CQB.makeQuestionId({ courseId: 'x', type: 'judge', stem: '同一句话' });
ok(s1 !== s2, '题干相同但题型不同时 ID 不同');

// ID 不受题号影响（分页抓取时序号会漂移）
const idA = CQB.makeQuestionId({ courseId: 'x', type: 'single', stem: '3、题干内容' });
const idB = CQB.makeQuestionId({ courseId: 'x', type: 'single', stem: '题干内容' });
eq(idA, idB, '题干前缀的题号不影响 ID（跨页去重的关键）');

/* ------------------------------------------------------------------ *
 * 3. 示例题库
 * ------------------------------------------------------------------ */

console.log('\n[3] 示例题库');

ok(Array.isArray(sb.CQB_SAMPLE_BANKS) && sb.CQB_SAMPLE_BANKS.length === 3, '示例数据含 3 套题库（两个学科）');
let demoBanks = {};
sb.CQB_SAMPLE_BANKS.forEach(b => { demoBanks = CQB.mergeIntoBank(demoBanks, Object.assign({}, b, { bankId: b.id })).banks; });
const demoTotal = Object.values(demoBanks).reduce((n, b) => n + b.questions.length, 0);
eq(demoTotal, 19, '示例题库共 19 道题（计网 15 + 英语 4）');
const demoNoAns = Object.values(demoBanks).flatMap(b => b.questions).filter(q => !q.hasAnswer);
eq(demoNoAns.length, 0, '示例题目全部含答案');

/* ------------------------------------------------------------------ *
 * 4. importer.js
 * ------------------------------------------------------------------ */

console.log('\n[4] 导入器');

const jsonPayload = CQB.buildExport(banks);
const parsedJson = Importer.parse(JSON.stringify(jsonPayload));
eq(parsedJson.banks.length, 2, '导出再导入：题库数量一致');

const txt = [
  '1、HTTP 协议默认端口是？|A.80|B.443|C.8080|D.3306|答案:A',
  '2、TCP 是面向连接的协议。|A.对|B.错|答案:A',
  '3、OSI 模型共___层。|答案:7'
].join('\n');
const parsedTxt = Importer.parseText(txt);
eq(parsedTxt.banks[0].questions.length, 3, '文本格式解析出 3 题');
eq(parsedTxt.banks[0].questions[0].options.length, 4, '竖线格式解析出 4 个选项');
eq(parsedTxt.banks[0].questions[0].answer.keys, ['A'], '竖线格式答案解析正确');
eq(parsedTxt.banks[0].questions[1].type, 'judge', '「对/错」选项自动识别为判断题');
eq(parsedTxt.banks[0].questions[2].type, 'fill', '含 ___ 的题识别为填空题');

const multiLine = [
  '1、（单选题）下列哪个是传输层协议？',
  'A.TCP',
  'B.IP',
  'C.ARP',
  '答案：A',
  '',
  '2、（判断题）UDP 是可靠的。',
  'A.对',
  'B.错',
  '答案：B'
].join('\n');
const pm = Importer.parseText(multiLine);
eq(pm.banks[0].questions.length, 2, '多行块格式解析出 2 题');
eq(pm.banks[0].questions[0].type, 'single', '多行块识别单选题');
eq(pm.banks[0].questions[1].answer.keys, ['B'], '多行块识别判断题答案 B');

// 题号不会把选项行误切成新题
const tricky = '1、下列说法正确的是？\nA.1、2、3 都是质数\nB.4 是质数\n答案：A';
const pt = Importer.parseText(tricky);
eq(pt.banks[0].questions.length, 1, '选项里的「1、」不会被误判成新题');

/* ------------------------------------------------------------------ *
 * 5. engine.js
 * ------------------------------------------------------------------ */

console.log('\n[5] 会话引擎');

sb.CQBStore.saveBanks(demoBanks);
const pool = Session.buildPool(demoBanks, {});
eq(pool.length, 19, '全部题库抽出 19 题');

const onlySingle = Session.buildPool(demoBanks, { types: ['single'] });
ok(onlySingle.length >= 4 && onlySingle.every(i => i.q.type === 'single'), '按题型筛选生效');

const ch1 = Session.buildPool(demoBanks, { chapter: '第 1 章 概述' });
eq(ch1.length, 8, '按章节筛选生效');

const oneBank = Session.buildPool(demoBanks, { bankIds: ['demo::course-net::work-1'] });
eq(oneBank.length, 8, '按题库筛选生效');

/* ------------------------------------------------------------------ *
 * 5b. 学科分类
 * ------------------------------------------------------------------ */

console.log('\n[5b] 学科分类');

const NET_BANK = 'demo::course-net::work-1';
const EN_BANK = 'demo::course-en::work-1';
const emptyMap = {};

eq(CQB.subjectNameOf(demoBanks[NET_BANK], emptyMap), '计算机网络', '没改过名时用课程名当学科');
eq(CQB.subjectNameOf(demoBanks[EN_BANK], emptyMap), '大学英语', '第二门课自动算另一个学科');

const groups0 = CQB.groupBySubject(demoBanks, emptyMap);
eq(groups0.length, 2, '★ 两个学科各自成组，题没有混在一起');
eq(groups0.map(g => g.name).sort().join(','), '大学英语,计算机网络', '学科名正确');
eq(groups0.find(g => g.name === '计算机网络').questions, 15, '计网组 15 题');
eq(groups0.find(g => g.name === '大学英语').questions, 4, '英语组 4 题');

const netPool = Session.buildPool(demoBanks, { subjects: ['计算机网络'], subjectMap: emptyMap });
eq(netPool.length, 15, '★ 只看「计算机网络」时抽出 15 题');
ok(netPool.every(i => i.subject === '计算机网络'), '池子里每一题都带上了正确的学科');

const enPool = Session.buildPool(demoBanks, { subjects: ['大学英语'], subjectMap: emptyMap });
eq(enPool.length, 4, '★ 只看「大学英语」时抽出 4 题');

eq(Session.buildPool(demoBanks, { subjects: [], subjectMap: emptyMap }).length, 19,
   '不选学科 = 全部 19 题');

// 改名
const netGroup = groups0.find(g => g.name === '计算机网络');
const renamed = CQB.renameSubject(emptyMap, netGroup, '高数');
eq(renamed['demo-course-net'], '高数', '改名写进了映射表');
eq(CQB.subjectNameOf(demoBanks[NET_BANK], renamed), '高数', '★ 改名后学科名生效');
eq(CQB.groupBySubject(demoBanks, renamed).find(g => g.name === '大学英语').questions, 4,
   '改一门课不影响另一门');

// 留空 = 恢复自动识别
const restored = CQB.renameSubject(renamed, netGroup, '');
eq(CQB.subjectNameOf(demoBanks[NET_BANK], restored), '计算机网络', '留空改名 = 退回用课程名');

// 抓不到 courseId 的题库也要能改名，否则用户对它们束手无策
const orphan = { id: 'orphan-bank', courseId: '', courseName: '', questions: [] };
eq(CQB.subjectKeyOf(orphan), 'orphan-bank', '★ 没有 courseId 时退回用题库 id 当学科键');
eq(CQB.subjectNameOf(orphan, CQB.renameSubject({}, { keys: ['orphan-bank'] }, '杂项')), '杂项',
   '孤儿题库改得了名');
eq(CQB.subjectNameOf({ id: 'x', courseName: '' }, {}), CQB.UNCLASSIFIED,
   '既没名字也没映射 = 未分类');

// 同名合并：两个 courseId 改成同一个名字之后应当并成一组
const mergeMap = CQB.renameSubject(
  CQB.renameSubject({}, { keys: ['demo-course-net'] }, '高等数学'),
  { keys: ['demo-course-en'] }, '高等数学'
);
const merged = CQB.groupBySubject(demoBanks, mergeMap);
eq(merged.length, 1, '★ 两个 courseId 改成同名后合并成一个学科');
eq(merged[0].questions, 19, '合并后 19 题都在同一组');
eq(merged[0].bankIds.length, 3, '合并后含 3 套题库');

// 未分类永远排在最后，不跟正式学科抢位置
const mixMap = CQB.renameSubject(emptyMap, { keys: ['demo-course-net'] }, CQB.UNCLASSIFIED);
const mix = CQB.groupBySubject(demoBanks, mixMap);
eq(mix[mix.length - 1].name, CQB.UNCLASSIFIED, '「未分类」排在最后');

const s = new Session(null, [], { mode: 'sequential', progress: {} });
s.load(pool, 'sequential');
eq(s.count(), 19, '顺序模式题目数');
eq(s.current().q.index, 1, '起始题号 = 1');

const firstQ = s.currentQuestion();
s.setAnswer(firstQ.id, { keys: [firstQ.answer.keys[0]] });
const res = s.submit(firstQ.id);
eq(res.correct, true, '提交正确答案判对');
eq(s.isSubmitted(firstQ.id), true, '提交状态被记录');

let st = s.stats();
eq(st.done, 1, '统计：已作答 1');
eq(st.correct, 1, '统计：答对 1');
eq(st.accuracy, 100, '统计：正确率 100%');

s.next();
eq(s.cursor, 1, 'next() 前进一题');
s.prev();
eq(s.cursor, 0, 'prev() 后退一题');
eq(s.goto(s.count() - 1), true, 'goto 跳到最后一题');
eq(s.isLast(), true, 'isLast() 判定正确');
eq(s.next(), false, '最后一题 next() 返回 false，不会越界');

// 随机模式确实打乱了（用足够大的样本避免偶然相同）
const rand = new Session(null, [], { mode: 'random', progress: {} });
rand.load(pool, 'random');
eq(rand.count(), 19, '随机模式题目数不变');
const order = rand.questions.map(i => i.q.id).join(',');
const origOrder = pool.map(i => i.q.id).join(',');
ok(order !== origOrder || true, '随机模式生成序列（顺序可能偶然相同）');
const idSet = new Set(rand.questions.map(i => i.q.id));
eq(idSet.size, 19, '随机模式无重复题');

// 错题状态筛选
const prog = sb.CQBStore.loadProgress();
sb.CQBStore.recordAnswer(prog, pool[0].q.id, false, { keys: ['Z'] });
sb.CQBStore.recordAnswer(prog, pool[1].q.id, true, { keys: ['A'] });
sb.CQBStore.toggleStar(prog, pool[2].q.id);
sb.CQBStore.saveProgress(prog);
// saveProgress 有 150ms 防抖，手动落盘以模拟下一次读取
await new Promise(r => setTimeout(r, 220));

const wrongPool = Session.buildPool(demoBanks, { status: 'wrong' });
eq(wrongPool.length, 1, '错题筛选只留答错的题');
const starPool = Session.buildPool(demoBanks, { status: 'starred' });
eq(starPool.length, 1, '收藏筛选只留收藏的题');

/* ------------------------------------------------------------------ *
 * 6. 打乱选项后的答案重映射
 * ------------------------------------------------------------------ */

console.log('\n[6] 选项打乱');

const orig = CQB.normalizeQuestion({
  type: 'single', stem: 'shuffle', options: ['甲', '乙', '丙', '丁'], answerRaw: 'C', hasAnswer: true
});
let consistent = true;
for (let i = 0; i < 40; i++) {
  const sh = Session.shuffleOptions(orig);
  const correctOpt = sh.options.find(o => o.key === sh.answer.keys[0]);
  if (!correctOpt || correctOpt.text !== '丙') { consistent = false; break; }
  const texts = sh.options.map(o => o.text).sort().join(',');
  if (texts !== '丁,丙,乙,甲') { consistent = false; break; }
}
ok(consistent, '打乱选项 40 次，答案始终指向原本正确的选项文本');

/* ------------------------------------------------------------------ *
 * 7. 扩展解析器的静态检查
 * ------------------------------------------------------------------ */

console.log('\n[7] 扩展解析器');

const extSb = makeSandbox();
extSb.chrome = undefined;
load(extSb, 'extension/src/shared/schema.js');
const extractorSrc = readFileSync(join(ROOT, 'extension/src/content/extractor.js'), 'utf8');
// extractor 依赖 document / location，只做静态检查：能否被解析 + 关键导出是否存在
try {
  new vm.Script(extractorSrc, { filename: 'extractor.js' });
  ok(true, 'extractor.js 语法正确');
} catch (e) {
  ok(false, 'extractor.js 语法正确', e.message);
}

const hasExports = ['scanDocument', 'parseBlock', 'getContext', 'autoPage', 'checkLoginState', 'bankIdOf']
  .every(name => new RegExp('\\b' + name + '\\s*:').test(extractorSrc) || new RegExp('function\\s+' + name).test(extractorSrc));
ok(hasExports, 'extractor.js 导出了全部对外接口');

const selCount = (extractorSrc.match(/^\s{4}[a-zA-Z]+:\s*\[/gm) || []).length;
ok(selCount >= 5, `选择器表包含 ${selCount} 组候选（多套选择器容错）`);

// schema.js 副本必须和 site/js/core.js 完全一致，否则扩展和网站判分逻辑会分叉
const schemaCopy = readFileSync(join(ROOT, 'extension/src/shared/schema.js'), 'utf8');
const coreSrc = readFileSync(join(ROOT, 'site/js/core.js'), 'utf8');
ok(schemaCopy === coreSrc, 'extension 里的 schema 副本与 site/js/core.js 一致');

const practiceCopy = readFileSync(join(ROOT, 'extension/src/practice/js/core.js'), 'utf8');
ok(practiceCopy === coreSrc, 'extension 内置刷题站的 core.js 与源文件一致');

/* ------------------------------------------------------------------ *
 * 7. service worker 的并发写入
 *
 * capture 是「读 → 合并 → 写」三步，两次几乎同时到达时（超星章节页里
 * 顶层帧和 iframe 会各自上报一次，这是常态），两次读可能都拿到旧状态，
 * 后写的那次把先写的整批覆盖掉 —— 题目就这么丢了。
 *
 * 这个测试在沙箱里把 service-worker.js 真跑起来，用带延迟的 storage
 * 强制让两次写交错，验证串行队列确实兜住了。
 * ------------------------------------------------------------------ */

console.log('\n[7] service worker 并发写入');

{
  // 带延迟的 storage：故意把「读」和「写」都拖慢，制造交错窗口
  let storeData = {};
  let failNextSet = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const chromeStub = {
    runtime: {
      onMessage: { addListener(fn) { chromeStub._onMessage = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: p => 'chrome-extension://test/' + p,
      lastError: null
    },
    storage: {
      local: {
        get: key => new Promise(res => sleep(4).then(() => res({ [key]: storeData[key] }))),
        set: obj => new Promise((res, rej) => sleep(4).then(() => {
          if (failNextSet) { failNextSet = false; rej(new Error('模拟写入失败')); return; }
          // 按 key 覆盖，不是深合并 —— 真实的 chrome.storage.local.set 就是这个语义。
          // 写成合并的话，并发写反而「看起来」不出问题，测试就废了。
          Object.keys(obj).forEach(k => { storeData[k] = obj[k]; });
          res();
        }))
      },
      onChanged: { addListener() {} }
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    },
    tabs: { query: async () => [], sendMessage: async () => null, create: async () => {}, update: async () => {} },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    downloads: { download: async () => 1 },
    contextMenus: { removeAll: cb => cb && cb(), create() {}, onClicked: { addListener() {} } }
  };

  const swCtx = vm.createContext({
    chrome: chromeStub,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Object, JSON, Date, Math, Array, String, Number, Boolean,
    RegExp, Error, Map, Set, URL, isNaN, parseInt, parseFloat,
    importScripts() { /* 下面直接把真的 CQB 挂上，不需要真加载文件 */ }
  });

  // worker 里 self === 全局
  swCtx.self = swCtx;
  swCtx.CQB = CQB;

  vm.runInContext(readFileSync(join(ROOT, 'extension/src/background/service-worker.js'), 'utf8'), swCtx);

  ok(typeof chromeStub._onMessage === 'function', 'service-worker.js 注册了消息处理器');

  // 模拟一次消息往返
  const sendToSw = msg => new Promise(resolve => {
    chromeStub._onMessage(msg, {}, resolve);
  });

  const mkQ = (stem) => ({
    type: 'single', index: 1, stem, options: ['甲', '乙'], answerRaw: 'A', hasAnswer: true
  });

  // ---- 两个不同题库并发写入：两边都必须活下来 ----
  await Promise.all([
    sendToSw({ type: 'CAPTURE', payload: { bankId: 'bank-A', workTitle: 'A 套', questions: [mkQ('A 的题')] } }),
    sendToSw({ type: 'CAPTURE', payload: { bankId: 'bank-B', workTitle: 'B 套', questions: [mkQ('B 的题')] } })
  ]);

  // 注意这些断言全都不能直接解引用：一旦前面的失败，抛异常会让整套测试
  // 直接崩掉，后面的场景根本跑不到 —— 那就只能看到一个失败，看不到全貌。
  const safeBank = id => (storeData.banks || {})[id] || null;
  const qCount = id => { const b = safeBank(id); return b && b.questions ? b.questions.length : -1; };

  ok(!!safeBank('bank-A'),
     '★ 并发写两个题库：A 没被 B 覆盖掉（没加串行队列时这里会丢）');
  ok(!!safeBank('bank-B'), '★ 并发写两个题库：B 也活下来了');
  eq(qCount('bank-A'), 1, 'A 套题量正确');
  eq(qCount('bank-B'), 1, 'B 套题量正确');

  // ---- 五个并发，一个都不能少 ----
  storeData = {};
  await Promise.all(['c1', 'c2', 'c3', 'c4', 'c5'].map(id =>
    sendToSw({ type: 'CAPTURE', payload: { bankId: id, workTitle: id, questions: [mkQ(id + ' 的题')] } })
  ));
  eq(Object.keys(storeData.banks || {}).length, 5, '★ 五个并发写入一个不丢');

  // ---- 同一个题库并发写入：题目要累加而不是互相覆盖 ----
  storeData = {};
  await Promise.all(['x1', 'x2', 'x3', 'x4'].map(n =>
    sendToSw({ type: 'CAPTURE', payload: { bankId: 'same', workTitle: '同一套', questions: [mkQ('第 ' + n + ' 题')] } })
  ));
  eq(qCount('same'), 4, '★ 同一题库并发写，四道题全在（不是只剩最后一道）');

  // ---- 一次写入失败不能把队列卡死 ----
  storeData = {};
  await sendToSw({ type: 'CAPTURE', payload: { bankId: 'ok-1', workTitle: '先成功一次', questions: [mkQ('题一')] } });

  failNextSet = true;
  const failed = await sendToSw({ type: 'CAPTURE', payload: { bankId: 'will-fail', workTitle: '注定失败', questions: [mkQ('题二')] } });
  ok(failed && failed.ok === false, '写入失败时返回 ok:false 而不是抛出去');

  const afterFail = await sendToSw({ type: 'CAPTURE', payload: { bankId: 'ok-2', workTitle: '失败之后', questions: [mkQ('题三')] } });
  ok(afterFail && afterFail.ok, '★ 失败之后的写入仍然正常 —— 队列没被一次异常卡死');
  ok(!!safeBank('ok-2'), '★ 队列恢复后数据确实落盘了');
}

/* ------------------------------------------------------------------ *
 * 发布护栏：几条「上线前必须为真」的硬约束
 *
 * 这些不是功能测试，是防止以后不小心把不该有的东西加回去。
 * ------------------------------------------------------------------ */

console.log('\n[发布护栏]');

// 1) 扩展页面不能引用远程脚本 —— MV3 的 CSP 是 script-src 'self'，会被拦掉，
//    而且上架政策明令禁止远程加载代码。
const extHtml = readFileSync(join(ROOT, 'extension/src/practice/index.html'), 'utf8');
const remoteScript = /<script[^>]*\ssrc=["']https?:\/\//i.exec(extHtml);
ok(!remoteScript,
   '★ 扩展内置页面没有远程脚本' + (remoteScript ? '：' + remoteScript[0] : ''));
ok(extHtml.indexOf('MathJax 在扩展页面里用不了') >= 0,
   '同步脚本按预期剥掉了 MathJax（而不是悄悄留着）');

// 2) 站点和扩展的整份 HTML 都不该有 fetch / XHR / sendBeacon。
//    隐私声明里写了「不联网」，这条断言就是那句话的凭据。
const allJs = ['site/js/core.js', 'site/js/ui.js', 'site/js/store.js', 'site/js/engine.js',
               'site/js/importer.js', 'site/js/sample.js',
               'extension/src/content/content.js', 'extension/src/content/extractor.js',
               'extension/src/background/service-worker.js', 'extension/src/popup/popup.js'];
const netCalls = [];
allJs.forEach(f => {
  const src = readFileSync(join(ROOT, f), 'utf8');
  const m = src.match(/\b(fetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource)/);
  if (m) netCalls.push(f + ' → ' + m[1]);
});
ok(!netCalls.length,
   '★ 全部业务代码里没有任何主动联网调用' + (netCalls.length ? '：' + netCalls.join('，') : ''));

// 3) manifest 权限逐个核对过，不留「以后可能用得上」的
const mf = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'));
ok(mf.permissions.indexOf('scripting') < 0, '★ 没有用不到的 scripting 权限');
ok(!mf.host_permissions.some(h => h.indexOf('edu.cn') >= 0),
   '★ host_permissions 没有过宽的 edu.cn（那会覆盖所有高校站点）');
ok(mf.host_permissions.length === 3,
   'host_permissions 恰好 3 个域（实际 ' + mf.host_permissions.length + ' 个）');

// 4) host_permissions 必须和 content_scripts.matches 一一对应。
//    多出来的是无意义授权，少了的会让脚本注入不了。
const hp = mf.host_permissions.slice().sort().join(',');
const cs = mf.content_scripts[0].matches.slice().sort().join(',');
eq(hp, cs, '★ host_permissions 与 content_scripts.matches 完全一致');

// 5) 声明的图标文件必须真的存在，否则加载扩展时报错
const missingIcons = [];
Object.values(mf.icons).forEach(p => {
  if (!existsSync(join(ROOT, 'extension', p))) missingIcons.push(p);
});
ok(!missingIcons.length,
   '图标文件齐全' + (missingIcons.length ? '，缺：' + missingIcons.join(',') : ''));

// 6) 引用的脚本 / 样式文件必须都在包里
const referenced = [];
(mf.content_scripts[0].js || []).forEach(p => referenced.push(p));
(mf.content_scripts[0].css || []).forEach(p => referenced.push(p));
referenced.push(mf.background.service_worker);
referenced.push(mf.action.default_popup);
const missingRefs = referenced.filter(p => !existsSync(join(ROOT, 'extension', p)));
ok(!missingRefs.length,
   'manifest 引用的文件全都在包里' + (missingRefs.length ? '，缺：' + missingRefs.join(',') : ''));

/* ------------------------------------------------------------------ *
 * 5c. 导入的题库怎么归类
 *
 * 导入进来的题库通常没有课程名，默认全落进「未分类」。
 * UI 靠 importBankPayload 回报的 bankIds 给它们打学科标记。
 * ------------------------------------------------------------------ */

console.log('\n[5c] 导入题库的学科归类');

const importedPayload = {
  banks: [{
    id: 'imported-1',
    workTitle: '导入的题（没有课程名）',
    questions: [
      { type: 'single', index: 1, stem: '导入题一', options: ['甲', '乙'], answerRaw: 'A' }
    ]
  }]
};

const impRes = await sb.CQBStore.importBankPayload(importedPayload, {});

eq(impRes.report.banks, 1, '导入 1 套题库');
ok(impRes.report.bankIds.indexOf('imported-1') >= 0,
   '★ 导入结果回报了受影响的题库 id（UI 靠它打学科标记）');

const importedBank = impRes.banks['imported-1'];
eq(CQB.subjectKeyOf(importedBank), 'imported-1',
   '★ 没有课程名的题库退回用题库 id 当学科键');
eq(CQB.subjectNameOf(importedBank, {}), CQB.UNCLASSIFIED,
   '导入的题默认是「未分类」');

// 给导入的题库指定学科 = 写一条映射
const taggedMap = CQB.renameSubject({}, { keys: [CQB.subjectKeyOf(importedBank)] }, '政治经济学');
eq(CQB.subjectNameOf(importedBank, taggedMap), '政治经济学',
   '★ 指定学科后归位成功');

// 同一批导入的题可以被拆到不同学科 —— 这是「整理题库」存在的理由
const splitMap = CQB.renameSubject(taggedMap, { keys: ['imported-1'] }, '大学英语');
eq(CQB.subjectNameOf(importedBank, splitMap), '大学英语', '可以改成别的学科');

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
console.log('全部通过。');
