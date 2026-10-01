import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/util.js";
import {
  LEAD,
  PROTOCOL_ID,
  SOWING,
  draftAndFreeze,
  newApp,
  registerBaseline,
} from "./helpers/scenario.js";

function clockAt(iso) {
  let t = Date.parse(iso);
  return () => new Date((t += 1000)).toISOString();
}

test("以 propagation_batch 的品种/代次/苗批登记：代次超授权被拒绝", async () => {
  const app = await newApp();
  registerBaseline(app);
  assert.throws(
    () =>
      app.trial.registerBatch(LEAD, {
        variety_code: "YN-RS-26",
        batch_id: "PB-BAD",
        generation: 5,
      }),
    /超过品种授权最大代次/,
  );
});

test("角色控制：站点不能登记品种或建方案", async () => {
  const app = await newApp();
  registerBaseline(app);
  const site = { role: "site", actor: "x", site: "S-LOW" };
  assert.throws(
    () => app.trial.registerVariety(site, {
      variety_code: "V", name: "v", license: { max_generation: 1 },
    }),
    /无权/,
  );
});

test("方案必须在播种前冻结；冻结后不可改", async () => {
  const lateApp = await newApp(clockAt("2026-11-02T00:00:00Z"));
  registerBaseline(lateApp);
  lateApp.trial.draftProtocol(LEAD, {
    protocol_id: "PT-LATE",
    sowing_at: SOWING,
    sites: ["S-LOW", "S-HIGH"],
    blocks_per_site: 2,
    plot_size: 50,
    candidates: [{ variety_code: "YN-RS-26", batch_id: "PB-0042" }],
    control: { variety_code: "CK-STD-01", batch_id: "PB-CK-1" },
    metrics: [{ code: "m", type: "days", primary: true, higher_is_better: true }],
    calendar: [
      { code: "c", window: { from: "2026-11-03", to: "2026-12-01" }, metrics: ["m"] },
    ],
  });
  assert.throws(() => lateApp.trial.freezeProtocol(LEAD, "PT-LATE"), /播种前/);

  const app = await newApp(clockAt("2026-10-01T00:00:00Z"));
  registerBaseline(app);
  draftAndFreeze(app);
  assert.throws(() => draftAndFreeze(app), /方案已冻结/);
});

test("冻结产出随机区组布局：每区组含全部苗批各一次，盲码全局唯一", async () => {
  const app = await newApp(clockAt("2026-10-01T00:00:00Z"));
  registerBaseline(app);
  const frozen = draftAndFreeze(app, { blocks_per_site: 4 });
  const { layout, seed } = frozen.data;

  assert.equal(layout.length, 2 * 4 * 3); // 站点 × 区组 × (2参试+1对照)
  const blindCodes = layout.map((p) => p.blind_code);
  assert.equal(new Set(blindCodes).size, blindCodes.length);

  const groups = new Map();
  for (const plot of layout) {
    const key = `${plot.site_code}|${plot.block_no}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(plot.batch_id);
  }
  for (const batches of groups.values()) {
    assert.deepEqual(batches.sort(), ["PB-0042", "PB-0043", "PB-CK-1"]);
  }

  // 同一方案内容再次冻结，布局完全一致（确定性随机，可审计复算）
  const app2 = await newApp(clockAt("2026-10-01T00:00:00Z"));
  registerBaseline(app2);
  const frozen2 = draftAndFreeze(app2, { blocks_per_site: 4 });
  assert.equal(frozen2.data.seed, seed);
  assert.deepEqual(
    frozen2.data.layout.map((p) => p.blind_code),
    layout.map((p) => p.blind_code),
  );
});

test("盲态：站点视图揭盲前不暴露品种/苗批，且越站不可见", async () => {
  const app = await newApp(clockAt("2026-10-01T00:00:00Z"));
  registerBaseline(app);
  draftAndFreeze(app);

  const view = app.trial.siteView(PROTOCOL_ID, "S-LOW");
  assert.equal(view.status, "blinded");
  assert.equal(view.plots.length, 9);
  for (const plot of view.plots) {
    assert.equal(plot.variety_code, undefined);
    assert.equal(plot.batch_id, undefined);
    assert.match(plot.blind_code, /^M[0-9A-F]{8}$/);
  }
  assert.ok(view.calendar.length >= 1);

  app.trial.unblind(LEAD, PROTOCOL_ID);
  const open = app.trial.siteView(PROTOCOL_ID, "S-LOW");
  assert.equal(open.status, "unblinded");
  assert.ok(open.plots[0].variety_code);
  assert.throws(
    () => app.trial.siteView(PROTOCOL_ID, "S-OTHER"),
    /不在该方案内/,
  );
});
