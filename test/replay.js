'use strict';

// 覆盖路线逐步回放自检（node test/replay.js）
// 覆盖：完整回放、逐步帧（当前场景 / 变量状态 / 下一步选项）、
//       各类草稿变更导致的首个分歧点（UID 缺失 / 选项移位 / 条件不成立 /
//       悬空 / 目标变更 / 目标前置不成立 / 状态不一致 / 起点变更 / 起点受阻）、
//       期望/实际状态对照、未满足条件解释树、参数校验 400、回放不落盘、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { planCoverage } = require('../src/coverage');
const { replayRoute, DIVERGENCE_TEXT } = require('../src/replay');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name, a, b) => { assert.strictEqual(a, b, `${name}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`); passed++; console.log(`  ✓ ${name}`); };

// ---------- 基准剧情：线性链 + 变量赋值 + 场景前置 ----------
const base = {
  startScene: 'a',
  variables: ['k', 'x'],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'u1', text: '拿钥匙', target: 'b', assigns: [{ variable: 'k', value: true }] },
      ],
    },
    {
      id: 'b', precondition: 'k', options: [
        { uid: 'u2', text: '开开关', target: 'c', assigns: [{ variable: 'x', value: true }] },
      ],
    },
    { id: 'c', options: [{ uid: 'u3', text: '结束', target: 'd' }] },
    { id: 'd', options: [] },
  ],
};
const cov = planCoverage(base);
const route = cov.routes[0];

console.log('完整回放：');
const rep = replayRoute(base, route);
ok('未改动草稿回放完成', rep.completed === true && rep.divergence === null);
eq('总步数 = 3', rep.totalSteps, 3);
eq('实际走完 3 个选项', rep.replayLength, 3);
eq('终点场景为 d', rep.currentSceneId, 'd');
ok('终点状态 k=true、x=true', rep.currentState.k === true && rep.currentState.x === true);
ok('帧序列为 scene/option 交替（共 7 帧）',
  rep.frames.length === 7 &&
  rep.frames.every((f, i) => f.kind === (i % 2 === 0 ? 'scene' : 'option')));
ok('场景帧带正文标题与状态',
  rep.frames[0].kind === 'scene' && rep.frames[0].sceneId === 'a' &&
  typeof rep.frames[0].text === 'string');
ok('起点帧选项列表标注路线下一步（u1）',
  rep.frames[0].options.length === 1 &&
  rep.frames[0].options[0].uid === 'u1' &&
  rep.frames[0].options[0].isExpectedNext === true &&
  rep.frames[0].options[0].walkable === true);
ok('场景帧期望状态与实际一致', rep.frames.every((f) => f.kind !== 'scene' || f.stateMatches !== false));
ok('选项帧带选择后状态与期望状态',
  rep.frames.filter((f) => f.kind === 'option').every((f) =>
    f.stateAfter && f.expectedStateAfter && f.stateMatches === true));

console.log('分歧点检测：');

// 1) 选项 UID 缺失
const delOpt = JSON.parse(JSON.stringify(base));
delOpt.scenes[1].options = [];
const r1 = replayRoute(delOpt, route);
ok('删除选项 => 未完成且停在 u2', !r1.completed && r1.divergence.kind === 'optionUidMissing');
eq('UID 缺失停在第 2 个选项（step=1）', r1.divergence.step, 1);
ok('UID 缺失带期望 UID 与期望场景',
  r1.divergence.expectedUid === 'u2' && r1.divergence.expectedSceneId === 'b');
ok('已成功走过的帧保留到分歧点前', r1.replayLength === 1);

// 2) 选项被移动到其他场景
const moved = JSON.parse(JSON.stringify(base));
const u2 = moved.scenes[1].options[0];
moved.scenes[1].options = [];
moved.scenes[2].options.push(u2);
const r2 = replayRoute(moved, route);
ok('选项移位 => optionSceneMoved', !r2.completed && r2.divergence.kind === 'optionSceneMoved');
eq('实际在场景 c 找到了它', r2.divergence.foundSceneId, 'c');

// 3) 选项条件被改为当前状态不成立
const condChange = JSON.parse(JSON.stringify(base));
condChange.scenes[1].options[0].condition = 'x'; // 到达 b 时 x 仍为 false
const r3 = replayRoute(condChange, route);
ok('条件不成立 => optionConditionFalse', !r3.completed && r3.divergence.kind === 'optionConditionFalse');
ok('条件不成立带未满足条件解释树',
  r3.divergence.unmet && r3.divergence.unmet.op === 'var' && r3.divergence.unmet.satisfied === false);

// 4) 悬空跳转
const orphan = JSON.parse(JSON.stringify(base));
orphan.scenes[0].options[0].target = 'ghost';
const r4 = replayRoute(orphan, route);
ok('目标场景被删 => optionOrphan', !r4.completed && r4.divergence.kind === 'optionOrphan');
ok('悬空分歧记录路线原目标为 b', r4.divergence.expectedTarget === 'b');
const orphanEmpty = JSON.parse(JSON.stringify(base));
orphanEmpty.scenes[2].options[0].target = '';
const r4b = replayRoute(orphanEmpty, route);
ok('目标被清空 => optionOrphan', r4b.divergence.kind === 'optionOrphan');

// 5) 跳转目标改为另一个存在的场景
const targetChange = JSON.parse(JSON.stringify(base));
targetChange.scenes[0].options[0].target = 'c'; // 原目标 b 改成 c
const r5 = replayRoute(targetChange, route);
ok('目标变更 => optionTargetChanged', !r5.completed && r5.divergence.kind === 'optionTargetChanged');
ok('目标变更带期望/实际目标',
  r5.divergence.expectedTarget === 'b' && r5.divergence.actualTarget === 'c');

// 6) 目标场景前置条件不成立（去掉 u1 的赋值）
const blockEntry = JSON.parse(JSON.stringify(base));
blockEntry.scenes[0].options[0].assigns = [];
const r6 = replayRoute(blockEntry, route);
ok('入口前置不成立 => targetPreconditionFalse',
  !r6.completed && r6.divergence.kind === 'targetPreconditionFalse');
ok('入口受阻带未满足前置解释树',
  r6.divergence.unmet && r6.divergence.unmet.op === 'var' && r6.divergence.unmet.name === 'k');
ok('入口受阻帧包含被挡住的目标场景帧',
  r6.frames[r6.frames.length - 1].kind === 'scene' &&
  r6.frames[r6.frames.length - 1].blockedEntry === true);
eq('入口受阻停在被挡住的目标场景（stopStep=1）', r6.divergence.stopStep, 1);
eq('选项执行前的分歧停在当前场景（UID 缺失 stopStep=1）', r1.divergence.stopStep, 1);

// 7) 状态赋值结果与路线记录不一致（前置放开但赋值被删）
const stateDiff = JSON.parse(JSON.stringify(base));
stateDiff.scenes[0].options[0].assigns = [];
stateDiff.scenes[1].precondition = ''; // 前置放开：能进入 b，但 k 实际为 false
const r7 = replayRoute(stateDiff, route);
ok('赋值结果不一致 => stateMismatch', !r7.completed && r7.divergence.kind === 'stateMismatch');
ok('状态不一致给出期望/实际对照',
  JSON.stringify(r7.divergence.stateDiff) === JSON.stringify([{ variable: 'k', expected: true, actual: false }]));
eq('状态不一致停在执行选项后的场景（stopStep=1）', r7.divergence.stopStep, 1);
ok('状态不一致的原因文案可读', /状态/.test(DIVERGENCE_TEXT.stateMismatch));

// 7b) 起点场景的进入赋值变化导致初始状态不一致
const startAssignChange = JSON.parse(JSON.stringify(base));
startAssignChange.scenes[0].assigns = [{ variable: 'k', value: true }]; // 原起点 k=false
const r7b = replayRoute(startAssignChange, route);
ok('起点初始状态不一致 => 第 0 步 stateMismatch',
  !r7b.completed && r7b.divergence.step === 0 && r7b.divergence.kind === 'stateMismatch');

// 7c) 赋值路径不同但结果状态一致 => 不算分歧
const sameResult = JSON.parse(JSON.stringify(base));
sameResult.scenes[0].options[0].assigns = [{ variable: 'k', value: false }];
sameResult.scenes[1].assigns = [{ variable: 'k', value: true }]; // 进入 b 再置回 true
const r7c = replayRoute(sameResult, route);
ok('赋值路径不同但每步状态一致 => 回放完成', r7c.completed === true);

// 8) 起点场景变更
const startChange = JSON.parse(JSON.stringify(base));
startChange.startScene = 'c';
const r8 = replayRoute(startChange, route);
ok('起点变更 => startSceneChanged', !r8.completed && r8.divergence.kind === 'startSceneChanged');
ok('起点变更带期望/实际起点',
  r8.divergence.expectedSceneId === 'a' && r8.divergence.actualSceneId === 'c');

// 9) 起点前置不成立
const startBlocked = JSON.parse(JSON.stringify(base));
startBlocked.scenes[0].precondition = 'k'; // 初始 k=false
const r9 = replayRoute(startBlocked, route);
ok('起点前置不成立 => startPreconditionFailed',
  !r9.completed && r9.divergence.kind === 'startPreconditionFailed');
ok('起点受阻分歧在 step=0', r9.divergence.step === 0);

// 10) 新增变量在状态对照中可见
const addedVar = JSON.parse(JSON.stringify(base));
addedVar.variables.push('newFlag');
addedVar.scenes[3].assigns = [{ variable: 'newFlag', value: true }]; // 终点 d 进入时置位
const r10 = replayRoute(addedVar, route);
ok('新增变量导致终点状态不一致 => stateMismatch',
  !r10.completed && r10.divergence.kind === 'stateMismatch' &&
  r10.divergence.stateDiff.some((d) => d.variable === 'newFlag' && d.expected === false && d.actual === true));

console.log('循环路线回放（终止性与可重复性）：');
const loop = {
  startScene: 's',
  variables: ['x'],
  scenes: [
    {
      id: 's', options: [
        { uid: 'take', text: '拿', condition: '!x', target: 's', assigns: [{ variable: 'x', value: true }] },
        { uid: 'go', text: '走', condition: 'x', target: 'end' },
      ],
    },
    { id: 'end', options: [] },
  ],
};
const loopRoute = planCoverage(loop).routes[0];
const rl = replayRoute(loop, loopRoute);
ok('含循环路线完整回放', rl.completed === true && rl.replayLength === 2);
ok('同一场景的两次到达分别成帧',
  rl.frames.filter((f) => f.kind === 'scene' && f.sceneId === 's').length === 2);

console.log('条件语法错误容错：');
const badCond = JSON.parse(JSON.stringify(base));
badCond.scenes[0].options[0].condition = 'k &&';
const rb = replayRoute(badCond, route);
ok('语法错误按恒真处理且回放继续', rb.completed === true && rb.conditionErrors.length === 1);

console.log('optionUids 退化形式：');
const ru = replayRoute(base, { optionUids: route.covers, index: 7 });
ok('仅给 UID 序列也能回放', ru.completed === true);
eq('回显 routeIndex', ru.routeIndex, 7);

console.log('参数校验（400）：');
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && (!re || re.test(e.message)); }
  return false;
};
ok('缺少路线 => 400', throws400(() => replayRoute(base, null), /路线/));
ok('UID 序列为空 => 400', throws400(() => replayRoute(base, { optionUids: [] }), /空/));
ok('UID 重复 => 400', throws400(() => replayRoute(base, { optionUids: ['u1', 'u1'] }), /重复/));
ok('path 中缺 UID => 400', throws400(() => replayRoute(base, {
  path: [{ kind: 'scene', sceneId: 'a', state: {} },
    { kind: 'option', optionUid: null, target: 'b', stateAfter: {} },
    { kind: 'scene', sceneId: 'b', state: {} }],
}), /选项序列|UID/));
ok('起点无效 => 400', throws400(() => replayRoute({ startScene: 'zz', scenes: [] }, route), /起点/));

// ---------- HTTP API ----------
(async () => {
  console.log('HTTP API：');
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const req = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    // 完整回放
    const q1 = await req('POST', '/api/coverage/replay', { story: base, route });
    ok('POST /api/coverage/replay 完整回放返回 200',
      q1.status === 200 && q1.body.completed === true && q1.body.totalSteps === 3);

    // 分歧回放（删除选项）
    const q2 = await req('POST', '/api/coverage/replay', { story: delOpt, route });
    ok('分歧回放返回分歧类型与期望/实际',
      q2.status === 200 && q2.body.completed === false &&
      q2.body.divergence.kind === 'optionUidMissing' &&
      Array.isArray(q2.body.frames));

    // { story } 必须提供：请求体直接给剧情（无 route）应 400
    const q3 = await req('POST', '/api/coverage/replay', { story: base });
    ok('缺少 route 返回 400', q3.status === 400);

    // 草稿剧情原样返回（未被服务端修改）：回放不落盘
    const storyClone = JSON.parse(JSON.stringify(base));
    const before = JSON.stringify(storyClone);
    await req('POST', '/api/coverage/replay', { story: storyClone, route });
    ok('回放不修改请求中的草稿对象', JSON.stringify(storyClone) === before);

    // 数据目录中不应因回放产生任何剧情文件
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    ok('回放不在数据目录写入任何剧情文件（不落盘）', files.length === 0);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项逐步回放断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
