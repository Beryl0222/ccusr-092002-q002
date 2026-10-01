/**
 * 测试共用场景：登记两个品种/三个苗批/两个站点并冻结一份两站点三区组方案。
 * 各用例在该场景上做不同变体，避免重复样板。
 */
import { createApp } from "../../src/app.js";

export async function newApp(clock) {
  return createApp(clock ? { clock } : {});
}

export const LEAD = { role: "lead", actor: "张负责人" };
export const STAT = { role: "statistician", actor: "李统计" };
export const REV = { role: "reviewer", actor: "王评审" };
export const siteCtx = (code, actor = "观察员") => ({ role: "site", actor, site: code });

export const PROTOCOL_ID = "PT-2026-01";
export const SOWING = "2026-11-01T00:00:00Z";

export function registerBaseline(app, ctx = LEAD) {
  const { trial } = app;
  trial.registerVariety(ctx, {
    variety_code: "YN-RS-26",
    name: "滇红雪山玫瑰",
    license: { region: "玉溪市", max_generation: 4 },
  });
  trial.registerVariety(ctx, {
    variety_code: "CK-STD-01",
    name: "标准对照玫瑰",
    license: { region: "玉溪市", max_generation: 4 },
  });
  trial.registerBatch(ctx, {
    variety_code: "YN-RS-26",
    batch_id: "PB-0042",
    generation: 2,
    quarantine_status: "quarantine_pending",
  });
  trial.registerBatch(ctx, {
    variety_code: "YN-RS-26",
    batch_id: "PB-0043",
    generation: 3,
    quarantine_status: "quarantine_pending",
  });
  trial.registerBatch(ctx, {
    variety_code: "CK-STD-01",
    batch_id: "PB-CK-1",
    generation: 1,
    quarantine_status: "quarantine_passed",
  });
  trial.registerSite(ctx, {
    site_code: "S-LOW",
    name: "低海拔基地",
    altitude_m: 800,
    facility: "钢架大棚",
  });
  trial.registerSite(ctx, {
    site_code: "S-HIGH",
    name: "高海拔基地",
    altitude_m: 2200,
    facility: "露天",
  });
}

export function draftAndFreeze(app, override = {}, ctx = LEAD) {
  const { trial } = app;
  trial.draftProtocol(ctx, {
    protocol_id: PROTOCOL_ID,
    sowing_at: SOWING,
    sites: ["S-LOW", "S-HIGH"],
    blocks_per_site: 3,
    plot_size: 100,
    candidates: [
      { variety_code: "YN-RS-26", batch_id: "PB-0042" },
      { variety_code: "YN-RS-26", batch_id: "PB-0043" },
    ],
    control: { variety_code: "CK-STD-01", batch_id: "PB-CK-1" },
    metrics: [
      { code: "survival", name: "成活率", type: "proportion", primary: true, higher_is_better: true },
      { code: "vase_days", name: "瓶插期", type: "days", primary: true, higher_is_better: true },
      { code: "yield", name: "产量", type: "count", primary: false, higher_is_better: true },
    ],
    calendar: [
      {
        code: "establish",
        window: { from: "2026-11-02", to: "2026-12-01" },
        metrics: ["survival"],
      },
      {
        code: "flower",
        window: { from: "2026-12-05", to: "2027-03-01" },
        metrics: ["vase_days", "yield"],
      },
      {
        code: "env-season",
        window: { from: "2026-11-02", to: "2027-03-01" },
        environmental: true,
      },
    ],
    quality_gate: { max_replacement_ratio: 0.1, min_env_coverage: 0.8 },
    ...override,
  });
  return trial.freezeProtocol(ctx, PROTOCOL_ID);
}

/** 为冻结方案所有小区生成观察记录与合格环境记录（无偏离的"干净"世界）。 */
export function seedFullObservations(
  app,
  { protocolId = PROTOCOL_ID, valueFor = () => 12, envCoverage = 0.9 } = {},
) {
  const state = app.trial.state();
  const protocol = state.protocols.get(protocolId);
  let counter = 0;
  const id = () => `OBS-${String(++counter).padStart(4, "0")}`;
  for (const siteCode of protocol.sites) {
    const records = [];
    const plots = protocol.layout.filter((p) => p.site_code === siteCode);
    for (const plot of plots) {
      records.push({
        kind: "observation",
        record_id: id(),
        blind_code: plot.blind_code,
        metric_code: "survival",
        value: valueFor(plot, "survival"),
        observed_at: "2026-11-20T08:00Z",
        observer: `${siteCode}-员`,
      });
      records.push({
        kind: "observation",
        record_id: id(),
        blind_code: plot.blind_code,
        metric_code: "vase_days",
        value: valueFor(plot, "vase_days"),
        observed_at: "2027-01-20T08:00Z",
        observer: `${siteCode}-员`,
      });
      records.push({
        kind: "observation",
        record_id: id(),
        blind_code: plot.blind_code,
        metric_code: "yield",
        value: valueFor(plot, "yield"),
        observed_at: "2027-01-21T08:00Z",
        observer: `${siteCode}-员`,
      });
    }
    records.push({
      kind: "environment",
      record_id: id(),
      window_code: "env-season",
      readings: { temp_c: 18 },
      coverage: envCoverage,
      observed_at: "2027-02-01T00:00Z",
      observer: `${siteCode}-员`,
    });
    app.ingest.ingestBundle(siteCtx(siteCode), {
      protocol_id: protocolId,
      bundle_id: `B-${siteCode}-1`,
      site_code: siteCode,
      records,
    });
  }
}
