import assert from "node:assert/strict";
import test from "node:test";

import {
  LEAD,
  PROTOCOL_ID,
  REV,
  STAT,
  draftAndFreeze,
  newApp,
  registerBaseline,
  seedFullObservations,
  siteCtx,
} from "./helpers/scenario.js";

function clockAt(iso) {
  let t = Date.parse(iso);
  return () => new Date((t += 1000)).toISOString();
}

async function readyApp(valueFor) {
  const app = await newApp(clockAt("2026-10-01T00:00:00Z"));
  registerBaseline(app);
  draftAndFreeze(app);
  seedFullObservations(app, {
    valueFor:
      valueFor ??
      ((plot, metric) => {
        if (metric === "survival") {
          if (plot.batch_id === "PB-CK-1") return 0.85;
          return plot.batch_id === "PB-0042" ? 0.92 : 0.90;
        }
        if (metric === "vase_days") {
          if (plot.batch_id === "PB-CK-1") return 11;
          return plot.batch_id === "PB-0042" ? 15 : 13;
        }
        return 40;
      }),
  });
  app.trial.unblind(LEAD, PROTOCOL_ID);
  return app;
}

test("揭盲前统计人员不能生成比较结果", async () => {
  const app = await newApp(clockAt("2026-10-01T00:00:00Z"));
  registerBaseline(app);
  draftAndFreeze(app);
  assert.throws(
    () => app.analysis.generateAnalysis(STAT, PROTOCOL_ID),
    /揭盲前/,
  );
});

test("区组比较：参试苗批相对对照的差值与方向正确，站点/跨点均输出", async () => {
  const app = await readyApp();
  const result = app.analysis.compute(PROTOCOL_ID);
  const vase = result.metrics.find((m) => m.metric_code === "vase_days");

  const find = (site, batch) => {
    const layer = site === null ? vase.pooled : vase.sites.find((s) => s.site_code === site);
    return layer.contrasts.find((c) => c.batch_id === batch);
  };
  assert.equal(find(null, "PB-0042").delta, 4);
  assert.equal(find(null, "PB-0043").delta, 2);
  assert.equal(find(null, "PB-0042").favors_test, true);
  // 两站点各 3 个区组可配对
  assert.equal(find("S-LOW", "PB-0042").paired_blocks, 3);
  assert.equal(find("S-HIGH", "PB-0042").paired_blocks, 3);
  assert.equal(find(null, "PB-0042").paired_blocks, 6);
});

test("质量门槛：换苗超比例、越区、提前淘汰、环境覆盖率不足均排除并留依据", async () => {
  const app = await readyApp();
  const plots = app.trial.state().protocols.get(PROTOCOL_ID).layout;
  const low = plots.filter((p) => p.site_code === "S-LOW");

  app.ingest.ingestBundle(siteCtx("S-LOW", "阿梅"), {
    protocol_id: PROTOCOL_ID,
    bundle_id: "B-DEVIATIONS",
    site_code: "S-LOW",
    records: [
      {
        kind: "deviation", record_id: "DV-1", blind_code: low[0].blind_code,
        deviation_type: "seedling_replacement", occurred_at: "2026-11-05T08:00Z",
        reason: "缓苗失败", detail: { count: 20 }, observer: "阿梅",
      },
      {
        kind: "deviation", record_id: "DV-2", blind_code: low[1].blind_code,
        deviation_type: "out_of_zone_planting", occurred_at: "2026-11-06T08:00Z",
        reason: "整地越界", detail: {}, observer: "阿梅",
      },
      {
        kind: "deviation", record_id: "DV-3", blind_code: low[2].blind_code,
        deviation_type: "early_elimination", occurred_at: "2026-12-10T08:00Z",
        reason: "霜冻", detail: { eliminated_at: "2026-12-10T08:00Z" }, observer: "阿梅",
      },
    ],
  });

  // 高海拔环境覆盖率不足（重新用一条 0.5 覆盖率覆盖取最新）
  app.ingest.ingestBundle(siteCtx("S-HIGH", "扎西"), {
    protocol_id: PROTOCOL_ID,
    bundle_id: "B-ENV-BAD",
    site_code: "S-HIGH",
    records: [
      {
        kind: "environment", record_id: "ENV-BAD", window_code: "env-season",
        readings: { temp_c: 12 }, coverage: 0.5,
        observed_at: "2027-02-10T00:00Z", observer: "扎西",
      },
    ],
  });

  const result = app.analysis.compute(PROTOCOL_ID);
  const quality = new Map(result.plot_quality.map((p) => [p.plot_id, p]));
  assert.ok(quality.get(low[0].plot_id).excluded);
  assert.ok(
    quality.get(low[0].plot_id).exclusion_reasons.some((r) => r.code === "excessive_replacement"),
  );
  assert.ok(
    quality.get(low[1].plot_id).exclusion_reasons.some((r) => r.code === "out_of_zone_planting"),
  );
  assert.ok(
    quality.get(low[2].plot_id).exclusion_reasons.some((r) => r.code === "early_elimination"),
  );
  // 高海拔所有小区因环境覆盖率被排除
  for (const plot of plots.filter((p) => p.site_code === "S-HIGH")) {
    assert.ok(
      quality.get(plot.plot_id).exclusion_reasons.some(
        (r) => r.code === "environmental_coverage_below_gate",
      ),
    );
  }
  // 偏离数据仍然完整保留在快照中，没有被删除
  assert.equal(result.input_snapshot.deviations.length, 3);
});

test("漏测仅排除该数据点；同小区其他指标仍可用", async () => {
  const app = await readyApp();
  const plots = app.trial.state().protocols.get(PROTOCOL_ID).layout;
  const target = plots.find((p) => p.site_code === "S-LOW");
  app.ingest.ingestBundle(siteCtx("S-LOW", "阿梅"), {
    protocol_id: PROTOCOL_ID,
    bundle_id: "B-MISS",
    site_code: "S-LOW",
    records: [
      {
        kind: "deviation", record_id: "DM-1", blind_code: target.blind_code,
        deviation_type: "missed_measurement", occurred_at: "2027-01-12T08:00Z",
        reason: "采花期无人值守", detail: { metric_code: "vase_days" }, observer: "阿梅",
      },
    ],
  });
  const result = app.analysis.compute(PROTOCOL_ID);
  const vase = result.metrics.find((m) => m.metric_code === "vase_days");
  const survival = result.metrics.find((m) => m.metric_code === "survival");
  assert.ok(
    vase.excluded_points.some(
      (p) => p.plot_id === target.plot_id && p.reasons[0].code === "missed_measurement",
    ),
  );
  assert.ok(
    !survival.excluded_points.some((p) => p.plot_id === target.plot_id),
  );
  // 小区整体未因单点漏测被排除
  assert.equal(
    result.plot_quality.find((p) => p.plot_id === target.plot_id).excluded,
    false,
  );
});

test("输入快照：分析固定链头；同快照复算一致，追加事件后旧分析仍可复核", async () => {
  const app = await readyApp();
  const generated = app.analysis.generateAnalysis(STAT, PROTOCOL_ID);
  // 快照链头是分析事件追加"之前"的链头（分析不可能包含自身事件）
  const headAtAnalysis = generated.snapshot_head;

  const review = app.analysis.reviewAnalysis(REV, generated.analysis_id);
  assert.equal(review.reproducible, true);
  assert.equal(review.snapshot_head, headAtAnalysis);

  // 事后新增一条更正（非主要指标），当前链头变化
  const plots = app.trial.state().protocols.get(PROTOCOL_ID).layout;
  const target = plots.find((p) => p.site_code === "S-LOW");
  const yieldRec = [...app.trial.state().records.values()].find(
    (r) => r.plot_id === target.plot_id && r.metric_code === "yield",
  );
  app.ingest.correctObservation(LEAD, {
    record_id: yieldRec.record_id,
    new_value: 41,
    reason: "收获后复核计数",
  });
  assert.notEqual(app.store.headHash(), headAtAnalysis);

  // 旧分析在旧快照上复算仍然一致
  const reviewAgain = app.analysis.reviewAnalysis(REV, generated.analysis_id);
  assert.equal(reviewAgain.reproducible, true);

  // 当前重算结果不同（快照变了），但这是新版本而非覆盖旧版本
  const current = app.analysis.compute(PROTOCOL_ID);
  assert.notEqual(current.input_snapshot_hash, generated.input_snapshot_hash);
});

test("检疫状态变化：标出受影响分析与推荐，历史分析事件字节不变", async () => {
  const app = await readyApp();
  const generated = app.analysis.generateAnalysis(STAT, PROTOCOL_ID);
  app.analysis.issueRecommendation(LEAD, {
    recommendation_id: "REC-1",
    analysis_id: generated.analysis_id,
    decision: "有条件推广",
    rationale: "瓶插期优于对照",
    scope_sites: ["S-LOW"],
  });

  const analysisEvent = app.store.events.find((e) => e.type === "analysis_generated");
  const before = JSON.stringify(analysisEvent);

  const change = app.changeQuarantine(LEAD, {
    batch_id: "PB-0042",
    to: "quarantine_revoked",
    reason: "出口复检发现管制病原",
  });
  assert.ok(change.impact_flag_event_seq);

  const after = JSON.stringify(
    app.store.events.find((e) => e.type === "analysis_generated"),
  );
  assert.equal(before, after);

  const trace = app.analysis.traceRecommendation(REV, "REC-1");
  assert.equal(trace.reproducible, true);
  assert.equal(trace.quarantine_impacts.length, 1);
  assert.equal(trace.quarantine_impacts[0].batch_id, "PB-0042");

  // 状态变化也体现在追溯的地块检疫字段
  const flaggedPlots = trace.plots.filter((p) => p.batch_id === "PB-0042");
  assert.ok(flaggedPlots.length > 0);
});

test("追溯链包含地块、观察者、协议版本与排除依据", async () => {
  const app = await readyApp();
  const generated = app.analysis.generateAnalysis(STAT, PROTOCOL_ID);
  app.analysis.issueRecommendation(LEAD, {
    recommendation_id: "REC-2",
    analysis_id: generated.analysis_id,
    decision: "推荐推广",
    rationale: "各项主要指标优于对照",
  });
  const trace = app.analysis.traceRecommendation(REV, "REC-2");
  assert.equal(trace.plots.length, 18);
  assert.ok(trace.observers.includes("S-LOW-员"));
  assert.ok(trace.observers.includes("S-HIGH-员"));
  assert.equal(trace.protocol_version.frozen_event_seq, 9);
  assert.match(trace.protocol_version.draft_sealed_hash, /^[0-9a-f]{64}$/);
  assert.ok(trace.protocol_version.seed);
  assert.ok(Array.isArray(trace.exclusion_index));
  for (const plot of trace.plots) {
    assert.ok(plot.site_code && plot.blind_code && plot.batch_id);
  }
});
