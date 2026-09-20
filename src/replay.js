'use strict';

/**
 * 覆盖路线逐步回放
 *
 * 选项覆盖路线是针对**某一版草稿**生成的（路线 = 起点出发的一串稳定选项
 * UID，路径上每个场景 / 选项节点都记录了当时的变量状态）。用户随后可能
 * 继续编辑草稿：删选项、改条件 / 前置 / 赋值 / 跳转目标、增删变量。
 * 本模块用**当前草稿**把一条已生成的路线从起点开始逐步重新走一遍，逐步
 * 重新校验：
 *
 *   1. 起点场景与起点前置条件（含初始状态赋值是否与路线记录一致）；
 *   2. 期望的下一个选项 UID 在当前草稿中是否仍存在、是否仍在原场景；
 *   3. 该选项在当前变量状态下显示条件是否成立；
 *   4. 跳转目标是否仍存在、是否仍是路线记录的那个场景；
 *   5. 跳转后目标场景的前置条件是否成立；
 *   6. 应用选项赋值 + 目标场景进入赋值后的**实际状态**，与路线生成时记录
 *      的**期望状态**是否逐变量一致。
 *
 * 一旦出现首个分歧，立即停在该分歧点，返回期望 / 实际对照（选项、目标、
 * 变量取值、未满足条件解释树与原因），前端可据此一键重新生成覆盖路线。
 *
 * 回放是纯计算：**不保存、不修改草稿**，与分析 / 路径查询 / 概率推演 /
 * 覆盖路线生成的“草稿不落盘”约定一致。
 */

const { compile } = require('./expression');
const { applyAssigns, collectStateVars } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 分歧类型 -> 中文原因（供前端直接展示） */
const DIVERGENCE_TEXT = {
  startSceneChanged: '路线的起点场景与当前草稿的起点不一致（起点可能已被修改）',
  startPreconditionFailed: '起点场景的前置条件在初始状态下不成立，剧情无法开始',
  stateMismatch: '按当前草稿的状态赋值计算出的变量状态与路线记录不一致（赋值可能已被修改）',
  optionUidMissing: '路线中的选项 UID 在当前草稿中已不存在（选项可能已被删除）',
  optionSceneMoved: '该 UID 的选项已不在路线记录的原场景中（选项可能被移动或场景被改动）',
  optionConditionFalse: '选项的显示条件在当前状态下不成立（条件或前置赋值可能已被修改）',
  optionOrphan: '选项没有跳转目标，或目标场景在当前草稿中不存在（悬空跳转）',
  optionTargetChanged: '选项的跳转目标与路线记录不一致（目标场景可能已被修改）',
  targetPreconditionFalse: '跳转后目标场景的前置条件不成立（状态赋值与前置条件冲突）',
};

/**
 * 从路线 path（覆盖路线结果中的 scene / option 交替节点）中提取逐步期望。
 * 正常形状：scene(start) -> option -> scene -> option -> ... -> scene
 */
function extractExpectations(route) {
  const path = Array.isArray(route.path) ? route.path : null;
  if (path && path.length) {
    const steps = [];
    let start = null;
    let prevScene = null;
    for (const node of path) {
      if (!node || typeof node !== 'object') continue;
      if (node.kind === 'scene') {
        if (!start) start = { sceneId: node.sceneId, state: node.state || {} };
        prevScene = { sceneId: node.sceneId, state: node.state || {} };
      } else if (node.kind === 'option') {
        steps.push({
          uid: node.optionUid || null,
          fromSceneId: prevScene ? prevScene.sceneId : null,
          target: node.target || '',
          stateBefore: prevScene ? prevScene.state : {},
          stateAfter: node.stateAfter || null,
          optionIndex: node.optionIndex,
        });
      }
    }
    if (start && steps.length && steps.every((s) => s.uid)) {
      return { start, steps, source: 'path' };
    }
  }
  // 退化形式：只有有序 UID 序列（无逐步状态 / 目标期望，状态一致性与
  // 目标变更检测将被跳过）。显式传入（含空数组）时不再回退到 path。
  if (Array.isArray(route.optionUids)) {
    if (!route.optionUids.length) {
      throw badRequest('路线的选项 UID 序列为空，无法回放');
    }
    return {
      start: null,
      steps: route.optionUids.map((uid) => ({ uid: String(uid), fromSceneId: null, target: '', stateBefore: null, stateAfter: null })),
      source: 'uids',
    };
  }
  throw badRequest('路线缺少可回放的选项序列（path 为空或其中选项节点缺少稳定 UID）');
}

/**
 * 对当前草稿回放一条覆盖路线。
 *
 * @param storyInput 当前草稿剧情对象（不落盘）
 * @param routeInput 覆盖路线结果中的一条 route（含 path），或
 *                    { optionUids: [...] }
 */
function replayRoute(storyInput, routeInput = {}) {
  const story = storyInput || {};
  if (!routeInput || typeof routeInput !== 'object') {
    throw badRequest('回放需要指定一条覆盖路线');
  }
  const routeIndex = Number.isInteger(routeInput.index) ? routeInput.index : null;
  const expectation = extractExpectations(routeInput);
  const { start: expectedStart, steps, source: expectSource } = expectation;
  const optionUids = steps.map((s) => s.uid);
  if (optionUids.some((u) => !u)) {
    throw badRequest('路线中存在缺少稳定 UID 的选项节点，无法按 UID 回放');
  }
  const dupUid = optionUids.find((u, i) => optionUids.indexOf(u) !== i);
  if (dupUid) throw badRequest(`路线的选项 UID 序列存在重复（${dupUid}），无法回放`);

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法回放覆盖路线');
  }

  // ---- 编译当前草稿的全部条件（语法错误按恒真处理，与其他引擎一致） ----
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const uidIndex = new Map();   // uid -> { sceneId, index, option }
  const optAt = new Map();      // `${sceneId}#${idx}` -> { option, cond, assigns }
  for (const scene of sceneMap.values()) {
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((option, idx) => {
      const key = `${scene.id}#${idx}`;
      optAt.set(key, {
        option: option || {},
        cond: safeCompile(option && option.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((option && option.assigns) || []).filter((a) => a && a.variable),
      });
      if (option && option.uid && !uidIndex.has(option.uid)) {
        uidIndex.set(option.uid, { sceneId: scene.id, index: idx, option });
      }
    });
  }

  // 状态空间变量以**当前草稿**为准；状态对比时与路线记录的变量集合并，
  // 使“新增变量 / 已删变量”的差异也可见
  const knownVars = collectStateVars({ ...story, scenes });
  const expectedVars = new Set();
  for (const s of steps) {
    Object.keys(s.stateBefore || {}).forEach((v) => expectedVars.add(v));
    Object.keys(s.stateAfter || {}).forEach((v) => expectedVars.add(v));
  }
  if (expectedStart) Object.keys(expectedStart.state || {}).forEach((v) => expectedVars.add(v));
  const compareVars = [...new Set([...knownVars, ...expectedVars])];

  /** 逐变量对比（缺失键按 false）：返回不一致清单 */
  const diffStates = (expected, actual) => compareVars
    .filter((v) => !!(expected && expected[v]) !== !!actual[v])
    .map((v) => ({ variable: v, expected: !!(expected && expected[v]), actual: !!actual[v] }));

  /** 当前场景中各选项在当前状态下的可见 / 可走情况（供界面展示“下一步选项”） */
  const visibleOptions = (sceneId, state, expectedNextUid) => {
    const scene = sceneMap.get(sceneId);
    if (!scene) return [];
    return (scene.options || []).map((opt, idx) => {
      const rec = optAt.get(`${sceneId}#${idx}`) || { option: opt || {}, cond: null, assigns: [] };
      const targetId = ((opt && opt.target) || '').trim();
      const conditionOk = !rec.cond || rec.cond.evaluate(state);
      let entryOk = false;
      if (targetId && sceneMap.has(targetId)) {
        let st = applyAssigns(state, rec.assigns);
        st = applyAssigns(st, sceneAssigns.get(targetId) || []);
        const tc = sceneCond.get(targetId);
        entryOk = !tc || tc.evaluate(st);
      }
      return {
        index: idx,
        uid: (opt && opt.uid) || null,
        text: (opt && opt.text) || '',
        target: targetId,
        condition: (opt && opt.condition) || '',
        conditionOk,
        targetExists: !!targetId && sceneMap.has(targetId),
        entryOk,
        walkable: conditionOk && !!targetId && sceneMap.has(targetId) && entryOk,
        isExpectedNext: !!expectedNextUid && (opt && opt.uid) === expectedNextUid,
      };
    });
  };

  const frames = [];
  const sceneFrame = (sceneId, state, step, expectedState) => {
    const scene = sceneMap.get(sceneId);
    const diff = expectedState ? diffStates(expectedState, state) : [];
    return {
      kind: 'scene',
      step,
      sceneId,
      title: scene ? (scene.title || '') : '',
      text: scene ? (scene.text || '') : '',
      state,
      expectedState: expectedState || null,
      stateMatches: expectedState ? diff.length === 0 : null,
      stateDiff: diff,
      options: visibleOptions(sceneId, state, null),
    };
  };

  // ---- 标记某场景帧中“路线期望的下一选项” ----
  const markNext = (uid) => {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].kind !== 'scene') continue;
      frames[i].options = visibleOptions(frames[i].sceneId, frames[i].state, uid);
      return;
    }
  };

  const finish = (completed, divergence) => {
    // stopStep：回放界面应停在的场景步位。多数分歧发生在“选项尚未执行”时
    // （stopStep = step）；状态不一致发生在“选项已执行、已进入目标场景”后，
    // 由分支显式给 step + 1。
    if (divergence && divergence.stopStep === undefined) divergence.stopStep = divergence.step;
    return {
      ok: true,
      completed,
      routeIndex,
      totalSteps: optionUids.length,
      replayLength: frames.filter((f) => f.kind === 'option').length,
      startScene: story.startScene,
      currentSceneId: currentSceneId0,
      currentState: currentState0,
      knownVars,
      frames,
      divergence,
      conditionErrors,
    };
  };

  // ---- 起点校验 ----
  let currentSceneId0 = story.startScene;
  let currentState0 = applyAssigns({}, sceneAssigns.get(story.startScene) || []);

  if (expectedStart && expectedStart.sceneId && expectedStart.sceneId !== story.startScene) {
    // 起点场景都变了：路线整体不再适用，直接停在第 0 步
    frames.push(sceneFrame(story.startScene, currentState0, 0, null));
    return finish(false, {
      step: 0,
      kind: 'startSceneChanged',
      reason: DIVERGENCE_TEXT.startSceneChanged,
      expectedSceneId: expectedStart.sceneId,
      actualSceneId: story.startScene,
      expectedState: expectedStart.state || {},
      actualState: currentState0,
      stateDiff: diffStates(expectedStart.state, currentState0),
    });
  }

  const startPc = sceneCond.get(story.startScene);
  if (startPc && !startPc.evaluate(currentState0)) {
    frames.push(sceneFrame(story.startScene, currentState0, 0,
      expectedStart ? expectedStart.state : null));
    return finish(false, {
      step: 0,
      kind: 'startPreconditionFailed',
      reason: DIVERGENCE_TEXT.startPreconditionFailed,
      expectedSceneId: story.startScene,
      actualSceneId: story.startScene,
      expectedState: expectedStart ? expectedStart.state : null,
      actualState: currentState0,
      unmet: startPc.explain(currentState0, true),
    });
  }

  if (expectedStart) {
    const startDiff = diffStates(expectedStart.state, currentState0);
    frames.push(sceneFrame(story.startScene, currentState0, 0, expectedStart.state));
    if (startDiff.length) {
      markNext(steps[0] ? steps[0].uid : null);
      return finish(false, {
        step: 0,
        kind: 'stateMismatch',
        reason: DIVERGENCE_TEXT.stateMismatch,
        expectedSceneId: story.startScene,
        actualSceneId: story.startScene,
        expectedState: expectedStart.state,
        actualState: currentState0,
        stateDiff: startDiff,
      });
    }
  } else {
    frames.push(sceneFrame(story.startScene, currentState0, 0, null));
  }

  // ---- 沿路线中的稳定选项 UID 逐步前进 ----
  for (let i = 0; i < steps.length; i++) {
    const exp = steps[i];
    markNext(exp.uid); // 当前场景帧标注路线期望的下一选项

    // 在当前草稿中定位该 UID（idx: 兜底标识按“场景#下标”解析）
    let located = uidIndex.get(exp.uid) || null;
    if (!located && exp.uid.startsWith('idx:')) {
      const m = /^idx:(.+)#(\d+)$/.exec(exp.uid);
      if (m) {
        const rec = optAt.get(`${m[1]}#${m[2]}`);
        if (rec) located = { sceneId: m[1], index: Number(m[2]), option: rec.option };
      }
    }

    // 分歧：UID 在草稿中整体缺失
    if (!located) {
      return finish(false, {
        step: i,
        kind: 'optionUidMissing',
        reason: DIVERGENCE_TEXT.optionUidMissing,
        expectedUid: exp.uid,
        expectedSceneId: exp.fromSceneId,
        actualSceneId: currentSceneId0,
        expectedState: exp.stateBefore,
        actualState: currentState0,
      });
    }

    // 分歧：UID 还在，但已不在路线记录的场景里
    if (exp.fromSceneId && located.sceneId !== exp.fromSceneId) {
      return finish(false, {
        step: i,
        kind: 'optionSceneMoved',
        reason: DIVERGENCE_TEXT.optionSceneMoved,
        expectedUid: exp.uid,
        expectedSceneId: exp.fromSceneId,
        actualSceneId: currentSceneId0,
        foundSceneId: located.sceneId,
        optionIndex: located.index,
        optionText: located.option.text || '',
        expectedState: exp.stateBefore,
        actualState: currentState0,
      });
    }

    const rec = optAt.get(`${located.sceneId}#${located.index}`);
    const option = located.option;
    const optionText = option.text || '';

    // 分歧：选项显示条件在当前状态下不成立
    if (rec && rec.cond && !rec.cond.evaluate(currentState0)) {
      return finish(false, {
        step: i,
        kind: 'optionConditionFalse',
        reason: DIVERGENCE_TEXT.optionConditionFalse,
        expectedUid: exp.uid,
        expectedSceneId: located.sceneId,
        actualSceneId: currentSceneId0,
        optionIndex: located.index,
        optionText,
        target: (option.target || '').trim(),
        expectedState: exp.stateBefore,
        actualState: currentState0,
        unmet: rec.cond.explain(currentState0, true),
      });
    }

    const actualTarget = (option.target || '').trim();

    // 分歧：悬空跳转（无目标或目标场景已删除）
    if (!actualTarget || !sceneMap.has(actualTarget)) {
      return finish(false, {
        step: i,
        kind: 'optionOrphan',
        reason: DIVERGENCE_TEXT.optionOrphan,
        expectedUid: exp.uid,
        expectedSceneId: located.sceneId,
        actualSceneId: currentSceneId0,
        optionIndex: located.index,
        optionText,
        expectedTarget: exp.target || null,
        target: actualTarget,
        targetExists: !!actualTarget && sceneMap.has(actualTarget),
        expectedState: exp.stateBefore,
        actualState: currentState0,
      });
    }

    // 分歧：跳转目标与路线记录不一致（目标被改成另一个存在的场景）
    if (expectSource === 'path' && exp.target && actualTarget !== exp.target) {
      return finish(false, {
        step: i,
        kind: 'optionTargetChanged',
        reason: DIVERGENCE_TEXT.optionTargetChanged,
        expectedUid: exp.uid,
        expectedSceneId: located.sceneId,
        actualSceneId: currentSceneId0,
        optionIndex: located.index,
        optionText,
        expectedTarget: exp.target,
        actualTarget,
        expectedState: exp.stateBefore,
        actualState: currentState0,
      });
    }

    // 应用当前草稿的选项赋值 + 目标场景进入赋值
    let nextState = applyAssigns(currentState0, rec ? rec.assigns
      : ((option.assigns || []).filter((a) => a && a.variable)));
    nextState = applyAssigns(nextState, sceneAssigns.get(actualTarget) || []);

    // 分歧：目标场景前置条件在跳转后的状态下不成立
    const targetPc = sceneCond.get(actualTarget);
    if (targetPc && !targetPc.evaluate(nextState)) {
      frames.push({
        kind: 'option',
        step: i,
        optionUid: exp.uid,
        optionIndex: located.index,
        optionText,
        condition: option.condition || '',
        conditionOk: true,
        fromSceneId: located.sceneId,
        target: actualTarget,
        targetTitle: (sceneMap.get(actualTarget) || {}).title || '',
        stateAfter: nextState,
        expectedStateAfter: exp.stateAfter,
        stateMatches: null,
        stateDiff: [],
      });
      const blockedFrame = sceneFrame(actualTarget, nextState, i + 1, exp.stateAfter);
      blockedFrame.blockedEntry = true;
      frames.push(blockedFrame);
      return finish(false, {
        step: i,
        stopStep: i + 1,
        kind: 'targetPreconditionFalse',
        reason: DIVERGENCE_TEXT.targetPreconditionFalse,
        expectedUid: exp.uid,
        expectedSceneId: located.sceneId,
        actualSceneId: currentSceneId0,
        optionIndex: located.index,
        optionText,
        target: actualTarget,
        targetTitle: (sceneMap.get(actualTarget) || {}).title || '',
        expectedState: exp.stateBefore,
        actualState: currentState0,
        stateAfterOption: nextState,
        expectedStateAfter: exp.stateAfter,
        unmet: targetPc.explain(nextState, true),
      });
    }

    // 分歧：状态赋值结果与路线记录不一致（逐变量期望 / 实际）
    const stateDiff = exp.stateAfter ? diffStates(exp.stateAfter, nextState) : [];
    frames.push({
      kind: 'option',
      step: i,
      optionUid: exp.uid,
      optionIndex: located.index,
      optionText,
      condition: option.condition || '',
      conditionOk: true,
      fromSceneId: located.sceneId,
      target: actualTarget,
      targetTitle: (sceneMap.get(actualTarget) || {}).title || '',
      stateAfter: nextState,
      expectedStateAfter: exp.stateAfter,
      stateMatches: exp.stateAfter ? stateDiff.length === 0 : null,
      stateDiff,
    });
    currentSceneId0 = actualTarget;
    currentState0 = nextState;
    frames.push(sceneFrame(actualTarget, nextState, i + 1,
      steps[i + 1] ? steps[i + 1].stateBefore : exp.stateAfter));

    if (stateDiff.length) {
      markNext(steps[i + 1] ? steps[i + 1].uid : null);
      return finish(false, {
        step: i,
        stopStep: i + 1,
        kind: 'stateMismatch',
        reason: DIVERGENCE_TEXT.stateMismatch,
        expectedUid: exp.uid,
        expectedSceneId: located.sceneId,
        actualSceneId: currentSceneId0,
        optionIndex: located.index,
        optionText,
        target: actualTarget,
        expectedState: exp.stateAfter,
        actualState: nextState,
        stateDiff,
      });
    }
  }

  markNext(null);
  return finish(true, null);
}

module.exports = { replayRoute, DIVERGENCE_TEXT };
