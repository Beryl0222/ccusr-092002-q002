import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createServer } from "../src/service.js";
import { canonical, DomainError, trialInputFromBatch } from "../src/trial/domain.js";
import { createTrialStore } from "../src/trial/store.js";

const propagationBatch = JSON.parse(
  await readFile(new URL("../contracts/propagation_batch.json", import.meta.url), "utf8"),
);
const trialContract = JSON.parse(
  await readFile(new URL("../contracts/variety_trial.json", import.meta.url), "utf8"),
);

const FREEZE_AT = "2026-10-05T08:00:00.000Z";
const SOW_AT = "2026-11-01T08:00:00.000Z";
const UNBLIND_AT = "2027-03-01T08:00:00.000Z";
const ANALYSIS_AT = "2027-03-05T08:00:00.000Z";

function protocolDraft() {
  return structuredClone(trialContract.sample.protocol);
}

function newTrial(store) {
  return store.createTrial(
    trialInputFromBatch(propagationBatch.sample, {
      title: trialContract.sample.trial.title,
      planned_sowing_date: trialContract.sample.trial.planned_sowing_date,
      created_by: trialContract.sample.trial.created_by,
      at: "2026-10-01T08:00:00.000Z",
    }),
  );
}

function frozenTrial(store) {
  const trial = newTrial(store);
  store.freezeProtocol(trial.trial_id, protocolDraft(), { by: "li.researcher", at: FREEZE_AT });
  return trial;
}

function ingestAll(store, trial, overrides = {}) {
  const plan = [
    { calendar_id: "OBS-SURV-30", kind: "survival", metric: "survival", at: "2026-11-25", values: { "T-CAND": 0.92, "T-CTRL": 0.88 } },
    { calendar_id: "OBS-DIS-60", kind: "disease", metric: "disease_index", at: "2027-01-20", values: { "T-CAND": 4, "T-CTRL": 11 } },
    { calendar_id: "OBS-VASE", kind: "vase_life", metric: "vase_life_days", at: "2027-02-20", values: { "T-CAND": 14, "T-CTRL": 9 } },
  ];
  let seq = 0;
  for (const plot of trial.plots) {
    for (const step of plan) {
      seq += 1;
      const key = `${plot.plot_id}:${step.metric}`;
      store.ingestObservation(
        trial.trial_id,
        {
          record_id: `R-${String(seq).padStart(4, "0")}`,
          site_id: plot.site_id,
          plot_id: plot.plot_id,
          calendar_id: step.calendar_id,
          kind: step.kind,
          metric: step.metric,
          value: overrides[key] ?? step.values[plot.treatment_id],
          observer_id: `obs-${plot.site_id}`,
          observed_at: step.at,
        },
        { at: step.at },
      );
    }
  }
}

function analyzedTrial(store, overrides) {
  const trial = frozenTrial(store);
  store.recordSowing(trial.trial_id, { by: "li.researcher", at: SOW_AT });
  ingestAll(store, trial, overrides);
  store.unblind(trial.trial_id, { by: "li.researcher", at: UNBLIND_AT });
  return trial;
}

function expectError(code, fn) {
  assert.throws(fn, (error) => error instanceof DomainError && error.code === code);
}

test("以 propagation_batch 为起点建试验并冻结方案，区组与盲码由种子确定", () => {
  const store = createTrialStore();
  const trial = frozenTrial(store);
  assert.equal(trial.variety_code, "YN-RS-26");
  assert.equal(trial.generation, 2);
  assert.equal(trial.batch_id, "PB-0042");
  assert.equal(trial.protocol_versions.length, 1);
  assert.equal(trial.protocol_versions[0].status, "frozen");
  assert.deepEqual(trial.protocol_versions[0].primary_metrics.sort(), ["disease_index", "vase_life_days"]);
  // 2 站点 × 3 区组 × 2 处理 = 12 个小区，每个区组内两个处理各一次
  assert.equal(trial.plots.length, 12);
  for (const site of ["YX-01", "DL-02"]) {
    for (const block of [1, 2, 3]) {
      const inBlock = trial.plots.filter((p) => p.site_id === site && p.block === block);
      assert.deepEqual(inBlock.map((p) => p.treatment_id).sort(), ["T-CAND", "T-CTRL"]);
    }
  }
  assert.deepEqual(Object.keys(trial.blind_map).sort(), ["BLIND-1", "BLIND-2"]);
  // 相同种子重放得到完全一致的区组排列
  const replay = createTrialStore();
  const replayTrial = frozenTrial(replay);
  assert.equal(canonical(replayTrial.plots), canonical(trial.plots));
});

test("播种前必须冻结方案，冻结后设计要素锁定", () => {
  const store = createTrialStore();
  const trial = newTrial(store);
  expectError("freeze_before_sowing", () => store.recordSowing(trial.trial_id, { by: "li.researcher", at: SOW_AT }));
  store.freezeProtocol(trial.trial_id, protocolDraft(), { by: "li.researcher", at: FREEZE_AT });
  store.recordSowing(trial.trial_id, { by: "li.researcher", at: SOW_AT });
  expectError("already_sown", () => store.recordSowing(trial.trial_id, { by: "li.researcher", at: SOW_AT }));
  // 修订必须说明理由，且不得变更站点、处理与区组设计
  expectError("amendment_reason_required", () =>
    store.freezeProtocol(trial.trial_id, protocolDraft(), { by: "li.researcher", at: "2026-12-01T08:00:00.000Z" }),
  );
  const changedDesign = protocolDraft();
  changedDesign.design.random_seed += 1;
  expectError("design_locked", () =>
    store.freezeProtocol(trial.trial_id, changedDesign, {
      by: "li.researcher",
      at: "2026-12-01T08:00:00.000Z",
      amendment_reason: "调整种子",
    }),
  );
  // 带理由修订观察日历允许，版本递增且保留历史
  const amended = protocolDraft();
  amended.calendar.find((e) => e.calendar_id === "OBS-YIELD").due_date = "2027-03-20";
  const v2 = store.freezeProtocol(trial.trial_id, amended, {
    by: "li.researcher",
    at: "2026-12-01T08:00:00.000Z",
    amendment_reason: "采收期延后一周",
  });
  assert.equal(v2.version, 2);
  assert.equal(v2.post_sowing, true);
  assert.equal(trial.protocol_versions.length, 2);
});

test("离线记录幂等汇入：重放去重、冲突拒绝", () => {
  const store = createTrialStore();
  const trial = frozenTrial(store);
  const plot = trial.plots[0];
  const record = {
    record_id: "R-0001",
    site_id: plot.site_id,
    plot_id: plot.plot_id,
    calendar_id: "OBS-SURV-30",
    kind: "survival",
    metric: "survival",
    value: 0.9,
    observer_id: "obs-1",
    observed_at: "2026-11-25",
  };
  const first = store.ingestObservation(trial.trial_id, record, { at: "2026-11-26" });
  assert.equal(first.deduplicated, false);
  const replay = store.ingestObservation(trial.trial_id, record, { at: "2026-11-27" });
  assert.equal(replay.deduplicated, true);
  assert.equal(Object.keys(trial.observations).length, 1);
  expectError("idempotency_conflict", () =>
    store.ingestObservation(trial.trial_id, { ...record, value: 0.5 }, { at: "2026-11-27" }),
  );
  expectError("unknown_plot", () =>
    store.ingestObservation(trial.trial_id, { ...record, record_id: "R-0002", plot_id: "YX-01-B9-P1" }, {}),
  );
});

test("漏测、换苗、越区栽种、提前淘汰作为方案偏离保留", () => {
  const store = createTrialStore();
  const trial = frozenTrial(store);
  // 漏测检测：5 个日历项 × 12 个小区，全部缺失
  const missed = store.detectMissedObservations(trial.trial_id, "2027-03-15T08:00:00.000Z");
  assert.equal(missed.length, 60);
  assert.ok(missed.every((d) => d.type === "missed_observation"));
  // 重复检测不产生重复偏离
  assert.equal(store.detectMissedObservations(trial.trial_id, "2027-03-16T08:00:00.000Z").length, 0);
  // 换苗与提前淘汰由站点上报
  const plot = trial.plots[0];
  const replaced = store.reportDeviation(trial.trial_id, {
    type: "seedling_replacement",
    plot_id: plot.plot_id,
    details: "补苗 2 株",
    reported_by: "obs-1",
    at: "2026-11-20",
  });
  assert.equal(replaced.type, "seedling_replacement");
  // 越区栽种：记录声明的盲码与地块分配不一致时自动登记
  const wrongCode = plot.blind_code === "BLIND-1" ? "BLIND-2" : "BLIND-1";
  store.ingestObservation(
    trial.trial_id,
    {
      record_id: "R-X1",
      site_id: plot.site_id,
      plot_id: plot.plot_id,
      kind: "survival",
      metric: "survival",
      value: 0.9,
      observer_id: "obs-1",
      observed_at: "2026-11-25",
      blind_code: wrongCode,
    },
    {},
  );
  const crossZone = trial.deviations.find((d) => d.type === "cross_zone_planting");
  assert.ok(crossZone);
  assert.equal(trial.observations["R-X1"].suspect, true);
});

test("研究负责人可纠正录入错误，原值保留；揭盲后主要指标锁定", () => {
  const store = createTrialStore();
  const trial = frozenTrial(store);
  store.recordSowing(trial.trial_id, { by: "li.researcher", at: SOW_AT });
  ingestAll(store, trial);
  const recordId = "R-0002";
  const before = trial.observations[recordId];
  assert.equal(before.metric, "disease_index");
  expectError("forbidden", () =>
    store.correctObservation(trial.trial_id, recordId, { role: "observer", value: 5, reason: "录入错误", by: "obs-1" }),
  );
  const corrected = store.correctObservation(trial.trial_id, recordId, {
    role: "research_lead",
    value: 5,
    reason: "录入错误，原始记录为 4",
    by: "li.researcher",
    at: "2027-01-21",
  });
  assert.equal(corrected.version, 2);
  assert.equal(corrected.original_value, 4);
  assert.equal(corrected.current_value, 5);
  assert.equal(corrected.corrections.length, 1);
  store.unblind(trial.trial_id, { by: "li.researcher", at: UNBLIND_AT });
  // 揭盲后主要指标锁定，非主要指标仍可纠错
  expectError("primary_locked", () =>
    store.correctObservation(trial.trial_id, recordId, {
      role: "research_lead",
      value: 6,
      reason: "再次纠错",
      by: "li.researcher",
    }),
  );
  const survivalRecord = Object.values(trial.observations).find((r) => r.metric === "survival");
  const again = store.correctObservation(trial.trial_id, survivalRecord.record_id, {
    role: "research_lead",
    value: 0.95,
    reason: "复核成活率",
    by: "li.researcher",
    at: "2027-03-02",
  });
  assert.equal(again.current_value, 0.95);
});

test("统计只用达到质量门槛的数据，结果带输入快照且可复核", () => {
  const store = createTrialStore();
  // 一个候选小区成活率低于门槛，应被排除并说明依据
  const trial = analyzedTrial(store, { "YX-01-B1-P1:survival": 0.4 });
  const excludedPlot = trial.plots.find((p) => p.plot_id === "YX-01-B1-P1");
  const { analysis, reused } = store.runAnalysis(trial.trial_id, {
    role: "statistician",
    by: "stat-1",
    at: ANALYSIS_AT,
  });
  assert.equal(reused, false);
  assert.ok(analysis.snapshot_hash);
  assert.equal(analysis.protocol_version, 1);
  const exclusion = analysis.snapshot.exclusions.find((e) => e.plot_id === excludedPlot.plot_id);
  assert.ok(exclusion && exclusion.reason.includes("成活率"));
  assert.ok(analysis.snapshot.records.every((r) => r.plot_id !== excludedPlot.plot_id));
  // 候选品种抗病性优于对照（数值越低越好），瓶插期更久
  const results = analysis.results;
  assert.equal(results.treatments["T-CAND"].metrics.disease_index.mean, 4);
  assert.equal(results.treatments["T-CTRL"].metrics.disease_index.mean, 11);
  assert.equal(results.rankings.disease_index[0], "T-CAND");
  assert.equal(results.rankings.vase_life_days[0], "T-CAND");
  const comparison = results.comparisons.find((c) => c.metric === "disease_index");
  assert.equal(comparison.diff, -7);
  // 相同状态重跑返回同一分析（相同快照一致结果）
  const again = store.runAnalysis(trial.trial_id, { role: "statistician", by: "stat-1", at: ANALYSIS_AT });
  assert.equal(again.reused, true);
  assert.equal(again.analysis.analysis_id, analysis.analysis_id);
  // 评审复核：在相同快照上重算一致
  const verification = store.verifyAnalysis(trial.trial_id, analysis.analysis_id);
  assert.deepEqual(verification, {
    analysis_id: analysis.analysis_id,
    consistent: true,
    snapshot_hash_ok: true,
    results_ok: true,
  });
});

test("纠错产生新快照，历史分析不被重写", () => {
  const store = createTrialStore();
  const trial = analyzedTrial(store);
  const metrics = ["disease_index", "vase_life_days", "survival"];
  const first = store.runAnalysis(trial.trial_id, { role: "statistician", by: "stat-1", metrics, at: ANALYSIS_AT });
  const snapshotBefore = canonical(first.analysis);
  // 揭盲后非主要指标仍可纠错，快照随之变化
  const survivalRecord = Object.values(trial.observations).find((r) => r.metric === "survival");
  store.correctObservation(trial.trial_id, survivalRecord.record_id, {
    role: "research_lead",
    value: 0.99,
    reason: "复核成活率",
    by: "li.researcher",
    at: "2027-03-02",
  });
  const second = store.runAnalysis(trial.trial_id, { role: "statistician", by: "stat-1", metrics, at: "2027-03-06T08:00:00.000Z" });
  assert.equal(second.reused, false);
  assert.notEqual(second.analysis.snapshot_hash, first.analysis.snapshot_hash);
  assert.equal(trial.analyses.length, 2);
  // 旧分析保持原样且仍可复核
  assert.equal(canonical(trial.analyses[0]), snapshotBefore);
  assert.equal(store.verifyAnalysis(trial.trial_id, first.analysis.analysis_id).consistent, true);
});

test("苗批检疫状态变化标出受影响的结论而不重写历史", () => {
  const store = createTrialStore();
  const trial = analyzedTrial(store);
  const { analysis } = store.runAnalysis(trial.trial_id, { role: "statistician", by: "stat-1", at: ANALYSIS_AT });
  const recommendation = store.createRecommendation(trial.trial_id, {
    role: "research_lead",
    analysis_id: analysis.analysis_id,
    recommended_variety_code: "YN-RS-26",
    conclusion: "候选品种抗病性与瓶插期显著优于对照，建议扩大试种",
    by: "li.researcher",
    at: "2027-03-06",
  });
  const resultsBefore = canonical(analysis.results);
  const { event, affected } = store.applyQuarantineStatus("PB-0042", {
    status: "recalled",
    by: "quarantine-office",
    at: "2027-03-10",
  });
  assert.equal(event.batch_id, "PB-0042");
  assert.deepEqual(affected, [
    { trial_id: trial.trial_id, analyses: [analysis.analysis_id], recommendations: [recommendation.recommendation_id] },
  ]);
  // 影响被标记，历史结果不变
  assert.equal(analysis.quarantine_impacts.length, 1);
  assert.equal(analysis.quarantine_impacts[0].status, "recalled");
  assert.equal(recommendation.quarantine_impacts.length, 1);
  assert.equal(canonical(analysis.results), resultsBefore);
  assert.equal(store.batchEvents("PB-0042").length, 1);
});

test("从推荐意见追到地块、观察者、协议版本与排除依据", () => {
  const store = createTrialStore();
  const trial = analyzedTrial(store);
  // 让 YX-01-B1-P1 完全缺测主要指标，超过门槛被排除
  for (const record of Object.values(trial.observations)) {
    if (record.plot_id === "YX-01-B1-P1") delete trial.observations[record.record_id];
  }
  const { analysis } = store.runAnalysis(trial.trial_id, { role: "statistician", by: "stat-1", at: ANALYSIS_AT });
  const recommendation = store.createRecommendation(trial.trial_id, {
    role: "research_lead",
    analysis_id: analysis.analysis_id,
    conclusion: "建议通过评审",
    by: "li.researcher",
    at: "2027-03-06",
  });
  const trace = store.traceRecommendation(trial.trial_id, recommendation.recommendation_id);
  assert.equal(trace.recommendation.recommendation_id, recommendation.recommendation_id);
  assert.equal(trace.protocol.version, 1);
  assert.equal(trace.protocol.frozen_by, "li.researcher");
  assert.ok(trace.treatments.some((t) => t.variety_code === "YN-RS-26" && t.blind_code));
  assert.ok(trace.inputs.length > 0);
  for (const input of trace.inputs) {
    assert.ok(input.plot_id && input.observer_id && input.observed_at);
  }
  const exclusion = trace.exclusions.find((e) => e.plot_id === "YX-01-B1-P1");
  assert.ok(exclusion && exclusion.reason.includes("漏测"));
  assert.equal(trace.analysis.snapshot_hash, analysis.snapshot_hash);
});

test("角色与状态约束：只有统计人员能分析，揭盲前不能分析", () => {
  const store = createTrialStore();
  const trial = frozenTrial(store);
  store.recordSowing(trial.trial_id, { by: "li.researcher", at: SOW_AT });
  ingestAll(store, trial);
  expectError("still_blinded", () =>
    store.runAnalysis(trial.trial_id, { role: "statistician", by: "stat-1", at: ANALYSIS_AT }),
  );
  store.unblind(trial.trial_id, { by: "li.researcher", at: UNBLIND_AT });
  expectError("forbidden", () =>
    store.runAnalysis(trial.trial_id, { role: "research_lead", by: "li.researcher", at: ANALYSIS_AT }),
  );
  expectError("forbidden", () =>
    store.createRecommendation(trial.trial_id, { role: "statistician", analysis_id: "AN-0001", conclusion: "x", by: "stat-1" }),
  );
});

test("HTTP 接口冒烟：健康检查、建试验、未知资源与冲突", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.service, "seedling-rights");

    const created = await fetch(`${base}/trials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        trialInputFromBatch(propagationBatch.sample, {
          title: "YN-RS-26 多点品种试验",
          planned_sowing_date: "2026-11-01",
          created_by: "li.researcher",
        }),
      ),
    });
    assert.equal(created.status, 201);
    const trial = await created.json();
    assert.equal(trial.batch_id, "PB-0042");

    const frozen = await fetch(`${base}/trials/${trial.trial_id}/protocol/freeze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...protocolDraft(), by: "li.researcher", at: FREEZE_AT }),
    });
    assert.equal(frozen.status, 200);
    const protocol = await frozen.json();
    assert.equal(protocol.status, "frozen");

    const missing = await fetch(`${base}/trials/TR-9999`);
    assert.equal(missing.status, 404);

    const detail = await (await fetch(`${base}/trials/${trial.trial_id}`)).json();
    const plot = detail.plots[0];
    assert.ok(plot);
    const record = {
      record_id: "R-0001",
      site_id: plot.site_id,
      plot_id: plot.plot_id,
      kind: "survival",
      metric: "survival",
      value: 0.9,
      observer_id: "obs-1",
      observed_at: "2026-11-25",
    };
    const first = await fetch(`${base}/trials/${trial.trial_id}/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    assert.equal(first.status, 201);
    const replay = await fetch(`${base}/trials/${trial.trial_id}/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    assert.equal(replay.status, 200);
    const conflict = await fetch(`${base}/trials/${trial.trial_id}/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...record, value: 0.5 }),
    });
    assert.equal(conflict.status, 409);
    const badJson = await fetch(`${base}/trials/${trial.trial_id}/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
  } finally {
    server.close();
  }
});
