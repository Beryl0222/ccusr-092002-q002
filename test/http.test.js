import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";
import { createServer } from "../src/service.js";

function clockAt(iso) {
  let t = Date.parse(iso);
  return () => new Date((t += 1000)).toISOString();
}

async function harness() {
  const app = await createApp({ clock: clockAt("2026-10-01T00:00:00Z") });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  async function call(method, path, body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, json };
  }

  const close = () =>
    new Promise((resolve) => server.close(() => resolve()));
  return { app, call, close };
}

test("健康检查保持原服务身份", async () => {
  const h = await harness();
  try {
    const { status, json } = await h.call("GET", "/health");
    assert.equal(status, 200);
    assert.equal(json.service, "seedling-rights");
  } finally {
    await h.close();
  }
});

test("盲态保护：揭盲前比较结果与事件流不可读", async () => {
  const h = await harness();
  const { call } = h;
  try {
    const lead = { "X-Role": "lead", "X-Actor": "lead-zhang" };
    const stat = { "X-Role": "statistician", "X-Actor": "stat-li" };

    await call("POST", "/admin/varieties", {
      variety_code: "YN-RS-26", name: "玫瑰", license: { max_generation: 4 },
    }, lead);
    await call("POST", "/admin/varieties", {
      variety_code: "CK", name: "对照", license: { max_generation: 4 },
    }, lead);
    await call("POST", "/admin/batches", {
      variety_code: "YN-RS-26", batch_id: "PB-1", generation: 2,
    }, lead);
    await call("POST", "/admin/batches", {
      variety_code: "CK", batch_id: "PB-2", generation: 1,
      quarantine_status: "quarantine_passed",
    }, lead);
    await call("POST", "/admin/sites", {
      site_code: "S1", altitude_m: 800, facility: "钢架大棚",
    }, lead);
    await call("POST", "/admin/sites", {
      site_code: "S2", altitude_m: 2200, facility: "露天",
    }, lead);
    await call("POST", "/protocols", {
      protocol_id: "PT-B",
      sowing_at: "2026-11-01T00:00:00Z",
      sites: ["S1", "S2"],
      blocks_per_site: 1,
      plot_size: 50,
      candidates: [{ variety_code: "YN-RS-26", batch_id: "PB-1" }],
      control: { variety_code: "CK", batch_id: "PB-2" },
      metrics: [{ code: "vase_days", type: "days", primary: true, higher_is_better: true }],
      calendar: [
        { code: "f", window: { from: "2026-12-01", to: "2027-02-01" }, metrics: ["vase_days"] },
        { code: "e", window: { from: "2026-11-02", to: "2027-02-01" }, environmental: true },
      ],
    }, lead);
    await call("POST", "/protocols/PT-B/freeze", {}, lead);

    let r = await call("GET", "/protocols/PT-B/results", undefined, stat);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "BLINDED");

    // 事件流无角色头不可读（含盲码对应关系）
    r = await call("GET", "/events");
    assert.equal(r.status, 403);

    // 站点也不能读事件流
    r = await call("GET", "/events", undefined, { "X-Role": "site", "X-Site": "S1" });
    assert.equal(r.status, 403);

    await call("POST", "/protocols/PT-B/unblind", {}, lead);
    r = await call("GET", "/protocols/PT-B/results", undefined, stat);
    assert.equal(r.status, 200);
  } finally {
    await h.close();
  }
});

test("完整 HTTP 流程：冻结->盲态采集->揭盲->分析->复核->检疫标记", async () => {
  const h = await harness();
  const { call } = h;
  try {
    const lead = { "X-Role": "lead", "X-Actor": "lead-zhang" };
    const stat = { "X-Role": "statistician", "X-Actor": "stat-li" };
    const rev = { "X-Role": "reviewer", "X-Actor": "review-wang" };

    const post = async (path, body, headers) => call("POST", path, body, headers);

    await post("/admin/varieties", {
      variety_code: "YN-RS-26", name: "滇红雪山玫瑰",
      license: { region: "玉溪市", max_generation: 4 },
    }, lead);
    await post("/admin/varieties", {
      variety_code: "CK-STD-01", name: "对照",
      license: { max_generation: 4 },
    }, lead);
    await post("/admin/batches", {
      variety_code: "YN-RS-26", batch_id: "PB-0042", generation: 2,
      quarantine_status: "quarantine_pending",
    }, lead);
    await post("/admin/batches", {
      variety_code: "CK-STD-01", batch_id: "PB-CK-1", generation: 1,
      quarantine_status: "quarantine_passed",
    }, lead);
    await post("/admin/sites", {
      site_code: "S-LOW", altitude_m: 800, facility: "钢架大棚",
    }, lead);
    await post("/admin/sites", {
      site_code: "S-HIGH", altitude_m: 2200, facility: "露天",
    }, lead);

    await post("/protocols", {
      protocol_id: "PT-1",
      sowing_at: "2026-11-01T00:00:00Z",
      sites: ["S-LOW", "S-HIGH"],
      blocks_per_site: 2,
      plot_size: 50,
      candidates: [{ variety_code: "YN-RS-26", batch_id: "PB-0042" }],
      control: { variety_code: "CK-STD-01", batch_id: "PB-CK-1" },
      metrics: [
        { code: "vase_days", type: "days", primary: true, higher_is_better: true },
      ],
      calendar: [
        { code: "f", window: { from: "2026-12-01", to: "2027-02-01" }, metrics: ["vase_days"] },
        { code: "e", window: { from: "2026-11-02", to: "2027-02-01" }, environmental: true },
      ],
      quality_gate: { max_replacement_ratio: 0.1, min_env_coverage: 0.8 },
    }, lead);
    const frozen = await post("/protocols/PT-1/freeze", {}, lead);
    assert.equal(frozen.status, 201);
    assert.equal(frozen.json.data.layout.length, 8);

    // 揭盲前站点视图无品种信息
    const blind = await call("GET", "/protocols/PT-1/sites/S-LOW");
    assert.equal(blind.status, 200);
    assert.equal(blind.json.status, "blinded");

    // 站点汇入
    for (const site of ["S-LOW", "S-HIGH"]) {
      const plots = blind.json.plots; // 只需要合法盲码：从各站视图取
      const view = await call("GET", `/protocols/PT-1/sites/${site}`);
      const records = view.json.plots.flatMap((p) => ({
        kind: "observation",
        record_id: `${site}-${p.blind_code}`,
        blind_code: p.blind_code,
        metric_code: "vase_days",
        value: p.blind_code === view.json.plots[0].blind_code ? 14 : 10,
        observed_at: "2027-01-10T08:00Z",
        observer: `${site}观察员`,
      }));
      records.push({
        kind: "environment",
        record_id: `${site}-env`,
        window_code: "e",
        readings: { temp_c: 18 },
        coverage: 0.95,
        observed_at: "2027-01-30T00:00Z",
        observer: `${site}观察员`,
      });
      const r = await post("/ingest/bundles", {
        protocol_id: "PT-1",
        bundle_id: `B-${site}`,
        site_code: site,
        records,
      }, { "X-Role": "site", "X-Actor": `obs-${site}`, "X-Site": site });
      assert.equal(r.status, 202);
    }

    // 无角色头的操作被拒绝
    const denied = await post("/protocols/PT-1/unblind", {});
    assert.equal(denied.status, 403);

    await post("/protocols/PT-1/unblind", {}, lead);

    // 评审者不能生成分析
    const forbidden = await post("/protocols/PT-1/analyses", {}, rev);
    assert.equal(forbidden.status, 403);

    const analysis = await post("/protocols/PT-1/analyses", {}, stat);
    assert.equal(analysis.status, 201);

    const review = await post(`/analyses/${analysis.json.analysis_id}/review`, {}, rev);
    assert.equal(review.status, 201);
    assert.equal(review.json.reproducible, true);

    const rec = await post("/recommendations", {
      recommendation_id: "R-1",
      analysis_id: analysis.json.analysis_id,
      decision: "继续试验",
      rationale: "区组数偏少，扩大试种",
    }, lead);
    assert.equal(rec.status, 201);

    const trace = await call("GET", "/recommendations/R-1/trace", undefined, rev);
    assert.equal(trace.status, 200);
    assert.equal(trace.json.reproducible, true);
    assert.equal(trace.json.plots.length, 8);

    const q = await post("/quarantine/changes", {
      batch_id: "PB-0042",
      to: "quarantine_revoked",
      reason: "复检阳性",
    }, lead);
    assert.equal(q.status, 201);
    assert.ok(q.json.impact_flag_event_seq);

    const chain = await call("GET", "/audit/chain");
    assert.equal(chain.json.ok, true);
  } finally {
    await h.close();
  }
});
