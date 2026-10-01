import assert from "node:assert/strict";
import test from "node:test";

import {
  LEAD,
  PROTOCOL_ID,
  draftAndFreeze,
  newApp,
  registerBaseline,
  siteCtx,
} from "./helpers/scenario.js";

function clockAt(iso) {
  let t = Date.parse(iso);
  return () => new Date((t += 1000)).toISOString();
}

async function frozenApp() {
  const app = await newApp(clockAt("2026-10-01T00:00:00Z"));
  registerBaseline(app);
  draftAndFreeze(app);
  return app;
}

function plotMap(app) {
  return new Map(
    app.trial.state().protocols.get(PROTOCOL_ID).layout.map((p) => [
      `${p.site_code}#${p.block_no}#${p.position}`,
      p,
    ]),
  );
}

test("幂等：整包重发不产生新事件；跨包同记录重发跳过、异内容拒绝", async () => {
  const app = await frozenApp();
  const plots = plotMap(app);
  const p = plots.get("S-LOW#1#1");

  const records = [
    {
      kind: "observation",
      record_id: "RR-1",
      blind_code: p.blind_code,
      metric_code: "vase_days",
      value: 13,
      observed_at: "2027-01-10T08:00Z",
      observer: "阿梅",
    },
  ];
  const payload = {
    protocol_id: PROTOCOL_ID,
    bundle_id: "B1",
    site_code: "S-LOW",
    records,
  };
  const first = app.ingest.ingestBundle(siteCtx("S-LOW"), payload);
  const eventsAfterFirst = app.store.events.length;
  assert.equal(first.status, "accepted");

  const again = app.ingest.ingestBundle(siteCtx("S-LOW"), payload);
  assert.equal(again.status, "duplicate");
  assert.equal(again.event_seq, first.event_seq);
  assert.equal(app.store.events.length, eventsAfterFirst);

  // 同 record_id、不同 bundle、相同内容 -> 跳过计数
  const resend = app.ingest.ingestBundle(siteCtx("S-LOW"), {
    ...payload,
    bundle_id: "B2",
  });
  assert.equal(resend.duplicates, 1);

  // 同 record_id 不同值 -> 真冲突
  assert.throws(
    () =>
      app.ingest.ingestBundle(siteCtx("S-LOW"), {
        protocol_id: PROTOCOL_ID,
        bundle_id: "B3",
        site_code: "S-LOW",
        records: [{ ...records[0], value: 99 }],
      }),
    /已用于不同内容/,
  );
});

test("站点只能提交本站数据；坏盲码/越界值整包拒绝", async () => {
  const app = await frozenApp();
  const plots = plotMap(app);
  const low = plots.get("S-LOW#1#1");
  const high = plots.get("S-HIGH#1#1");

  assert.throws(
    () =>
      app.ingest.ingestBundle(siteCtx("S-HIGH"), {
        protocol_id: PROTOCOL_ID,
        bundle_id: "BX",
        site_code: "S-HIGH",
        records: [
          {
            kind: "observation",
            record_id: "X1",
            blind_code: low.blind_code, // 低站盲码
            metric_code: "survival",
            value: 0.9,
            observed_at: "2026-11-20T08:00Z",
            observer: "扎西",
          },
        ],
      }),
    /不属于本站地块/,
  );

  assert.throws(
    () =>
      app.ingest.ingestBundle(siteCtx("S-LOW"), {
        protocol_id: PROTOCOL_ID,
        bundle_id: "BY",
        site_code: "S-LOW",
        records: [
          {
            kind: "observation",
            record_id: "X2",
            blind_code: high.blind_code, // header 是 LOW 但提交 LOW 盲码才合法；这里用 HIGH
            metric_code: "survival",
            value: 1.5,
            observed_at: "2026-11-20T08:00Z",
            observer: "阿梅",
          },
        ],
      }),
    /不属于本站地块/,
  );
});

test("方案偏离原样留存：漏测/换苗/越区/提前淘汰四类均入库", async () => {
  const app = await frozenApp();
  const plots = plotMap(app);
  const p = (key) => plots.get(key);
  const records = [
    {
      kind: "deviation",
      record_id: "D1",
      blind_code: p("S-LOW#1#1").blind_code,
      deviation_type: "missed_measurement",
      occurred_at: "2027-01-12T08:00Z",
      reason: "无人值守",
      detail: { metric_code: "vase_days" },
      observer: "阿梅",
    },
    {
      kind: "deviation",
      record_id: "D2",
      blind_code: p("S-LOW#1#2").blind_code,
      deviation_type: "seedling_replacement",
      occurred_at: "2026-11-05T08:00Z",
      reason: "缓苗失败",
      detail: { count: 5 },
      observer: "阿梅",
    },
    {
      kind: "deviation",
      record_id: "D3",
      blind_code: p("S-LOW#2#1").blind_code,
      deviation_type: "out_of_zone_planting",
      occurred_at: "2026-11-06T08:00Z",
      reason: "整地越界",
      detail: {},
      observer: "阿梅",
    },
    {
      kind: "deviation",
      record_id: "D4",
      blind_code: p("S-LOW#2#2").blind_code,
      deviation_type: "early_elimination",
      occurred_at: "2026-12-10T08:00Z",
      reason: "霜冻",
      detail: { eliminated_at: "2026-12-10T08:00Z" },
      observer: "阿梅",
    },
    // 缺原因的偏离必须拒绝
    {
      kind: "deviation",
      record_id: "D5",
      blind_code: p("S-LOW#2#3").blind_code,
      deviation_type: "missed_measurement",
      occurred_at: "2027-01-12T08:00Z",
      reason: "   ",
      detail: {},
      observer: "阿梅",
    },
  ];
  assert.throws(
    () =>
      app.ingest.ingestBundle(siteCtx("S-LOW"), {
        protocol_id: PROTOCOL_ID,
        bundle_id: "BD",
        site_code: "S-LOW",
        records,
      }),
    /整包未接收/,
  );
  // 整包拒绝 -> 一条偏离都不留
  assert.equal(app.trial.state().deviations.size, 0);

  // 去掉坏记录后成功接收四类偏离
  app.ingest.ingestBundle(siteCtx("S-LOW"), {
    protocol_id: PROTOCOL_ID,
    bundle_id: "BD",
    site_code: "S-LOW",
    records: records.slice(0, 4),
  });
  const state = app.trial.state();
  assert.deepEqual(
    [...state.deviations.values()].map((d) => d.deviation_type).sort(),
    [
      "early_elimination",
      "missed_measurement",
      "out_of_zone_planting",
      "seedling_replacement",
    ],
  );
});

test("更正保留原值与轨迹；揭盲后主要指标锁定，非主要指标仍可改", async () => {
  const app = await frozenApp();
  const plots = plotMap(app);
  const p = plots.get("S-LOW#1#1");
  app.ingest.ingestBundle(siteCtx("S-LOW"), {
    protocol_id: PROTOCOL_ID,
    bundle_id: "BC",
    site_code: "S-LOW",
    records: [
      {
        kind: "observation",
        record_id: "C1",
        blind_code: p.blind_code,
        metric_code: "vase_days", // primary
        value: 5,
        observed_at: "2027-01-10T08:00Z",
        observer: "阿梅",
      },
      {
        kind: "observation",
        record_id: "C2",
        blind_code: p.blind_code,
        metric_code: "yield", // 非 primary
        value: 10,
        observed_at: "2027-01-11T08:00Z",
        observer: "阿梅",
      },
    ],
  });

  // 站点不能更正
  assert.throws(
    () =>
      app.ingest.correctObservation(siteCtx("S-LOW"), {
        record_id: "C1",
        new_value: 15,
        reason: "录错",
      }),
    /无权/,
  );

  // 负责人无理由不能更正
  assert.throws(
    () => app.ingest.correctObservation(LEAD, { record_id: "C1", new_value: 15 }),
    /更正必须填写原因/,
  );

  app.ingest.correctObservation(LEAD, {
    record_id: "C1",
    new_value: 15,
    reason: "小数点错误",
  });
  const rec = app.trial.state().records.get("C1");
  assert.equal(rec.original_value, 5);
  assert.equal(rec.current_value, 15);
  assert.equal(rec.corrections[0].from, 5);
  assert.equal(rec.corrections[0].to, 15);
  assert.equal(rec.corrections[0].reason, "小数点错误");

  app.trial.unblind(LEAD, PROTOCOL_ID);
  assert.throws(
    () =>
      app.ingest.correctObservation(LEAD, {
        record_id: "C1",
        new_value: 16,
        reason: "揭盲后想改主要指标",
      }),
    (error) => error.code === "PRIMARY_LOCKED",
  );
  // 非主要指标揭盲后仍允许更正
  const ok = app.ingest.correctObservation(LEAD, {
    record_id: "C2",
    new_value: 11,
    reason: "计数更正",
  });
  assert.ok(ok.hash);
});

test("原始值无法删除：不存在删除接口，更正只追加事件", async () => {
  const app = await frozenApp();
  assert.equal(typeof app.ingest.deleteRecord, "undefined");
  const types = new Set([
    "variety_registered",
    "batch_registered",
    "site_registered",
    "protocol_drafted",
    "protocol_frozen",
    "ingest_bundle_accepted",
    "observation_corrected",
  ]);
  for (const event of app.store.events) {
    if (types.has(event.type)) {
      assert.ok(event.hash.length === 64);
      assert.ok(event.prev_hash);
    }
  }
});
