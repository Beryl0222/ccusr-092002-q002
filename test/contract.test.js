import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { healthPayload, serviceId } from "../src/service.js";

test("服务身份稳定", () => {
  assert.equal(healthPayload().service, serviceId);
});

test("领域样例与服务一致", async () => {
  const raw = await readFile(new URL("../contracts/propagation_batch.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.service, serviceId);
  assert.ok(data.sample);
});

test("多点试验契约以 propagation_batch 的品种/代次/苗批为起点", async () => {
  const raw = await readFile(new URL("../contracts/multi_site_trial.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.service, serviceId);
  assert.equal(data.starts_from, "contracts/propagation_batch.json");

  const originRaw = await readFile(new URL("../contracts/propagation_batch.json", import.meta.url), "utf8");
  const origin = JSON.parse(originRaw).sample;
  assert.equal(data.sample.origin.variety_code, origin.variety_code);
  assert.equal(data.sample.origin.batch.id, origin.batch.id);
  assert.equal(data.sample.origin.batch.generation, origin.batch.generation);
  assert.equal(data.sample.origin.batch.status, origin.batch.status);

  // 契约声明的四类方案偏离与系统一致
  assert.deepEqual(data.sample.deviation_types, [
    "missed_measurement",
    "seedling_replacement",
    "out_of_zone_planting",
    "early_elimination",
  ]);
  // 分析必须锚定快照
  assert.match(data.sample.analysis.snapshot_head, /^[0-9a-f]{64}$/);
  assert.match(data.sample.analysis.input_snapshot_hash, /^[0-9a-f]{64}$/);
});
