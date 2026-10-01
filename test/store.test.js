import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { canonical, fingerprint, seededRng, shuffle } from "../src/util.js";
import { createApp } from "../src/app.js";

function fakeClock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 1) + n++ * 1000).toISOString();
}

test("事件哈希链：追加后可校验，改写历史必然断链", () => {
  const store = new EventStore({ clock: fakeClock() });
  store.append("a", { x: 1 });
  store.append("b", { y: 2 });
  assert.equal(store.verifyChain().ok, true);

  const originalHash = store.events[0].hash;
  store.events[0].data.x = 999; // 模拟篡改
  assert.equal(store.verifyChain().ok, false);
  assert.equal(store.verifyChain().at, 1);
  store.events[0].data.x = 1;
  // 即使内容恢复，链条仍可复核通过
  assert.equal(store.verifyChain().ok, true);
  assert.equal(store.events[0].hash, originalHash);
});

test("规范化指纹稳定：键序不同但内容相同则指纹一致", () => {
  assert.equal(
    fingerprint({ a: 1, b: [1, 2] }),
    fingerprint({ b: [1, 2], a: 1 }),
  );
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  assert.equal(canonical(null), "null");
});

test("随机区组可复现：同种子洗牌结果一致", () => {
  const rng1 = seededRng("abcdef0123456789");
  const rng2 = seededRng("abcdef0123456789");
  const base = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(shuffle(base, rng1), shuffle(base, rng2));
  assert.notDeepEqual(shuffle(base, seededRng("0000000000000001")), base);
});

test("JSONL 持久化：重启引导后状态一致，被改动的日志拒绝加载", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trials-"));
  const file = join(dir, "events.jsonl");
  try {
    const clock = fakeClock();
    const app1 = await createApp({ clock, file });
    app1.trial.registerVariety({ role: "lead", actor: "u" }, {
      variety_code: "V1",
      name: "品种一",
      license: { max_generation: 2 },
    });
    await app1.drain();

    const app2 = await createApp({ clock: fakeClock(), file });
    assert.ok(app2.trial.state().varieties.has("V1"));
    assert.equal(app2.store.verifyChain().ok, true);

    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[0]);
    tampered.data.name = "被篡改";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      [JSON.stringify(tampered), ...lines.slice(1)].join("\n") + "\n",
    );
    await assert.rejects(() => createApp({ file }), /校验失败/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
