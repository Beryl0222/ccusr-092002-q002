import { readFile, appendFile } from "node:fs/promises";
import { canonical, sha256 } from "./util.js";

/**
 * 仅追加事件日志（append-only log）。
 *
 * 这是整个服务的唯一事实来源：
 *  - 事件一经接受只能追加，绝不更新或删除；录入错误用"更正事件"对冲。
 *  - 每条事件携带 prev_hash，形成哈希链，任何历史篡改都会断链。
 *  - 投影（model.js）从事件流重放得到当前状态；快照分析则固定在某个
 *    链头哈希上，保证评审者在同一快照上得到一致结果。
 *
 * 事件信封字段：
 *  seq / ts / actor / role / type / data / idempotency_key / prev_hash / hash
 */

const GENESIS_HASH = "0".repeat(64);

export class EventStore {
  constructor({ clock, persist } = {}) {
    this.clock = clock ?? (() => new Date().toISOString());
    this.persist = persist ?? null;
    this.events = [];
    this.listeners = new Set();
    this.pending = Promise.resolve();
    this.persistError = null;
  }

  headHash() {
    return this.events.length === 0
      ? GENESIS_HASH
      : this.events[this.events.length - 1].hash;
  }

  /** 追加事件。idempotencyKey 用于站点离线汇入的去重。 */
  append(type, data, { actor, role, idempotencyKey } = {}) {
    const prevHash = this.headHash();
    const event = {
      seq: this.events.length + 1,
      ts: this.clock(),
      actor: actor ?? "system",
      role: role ?? "system",
      type,
      data: structuredClone(data),
      idempotency_key: idempotencyKey ?? null,
      prev_hash: prevHash,
    };
    event.hash = eventHash(event);
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    if (this.persist) {
      // 落盘串行化，保证 JSONL 顺序与事件顺序一致。
      this.pending = this.pending
        .then(() => this.persist(event))
        .catch((error) => {
          this.persistError = error;
        });
    }
    return event;
  }

  /** 等待所有事件落盘完成（测试与优雅停机使用）。 */
  async drain() {
    await this.pending;
    if (this.persistError) throw this.persistError;
  }

  /** 重放到某个链头（含），用于快照与复核；不传则为当前全量。 */
  replay(untilHash) {
    if (!untilHash || untilHash === this.headHash()) return this.events;
    const cut = this.events.findIndex((event) => event.hash === untilHash);
    if (cut < 0) {
      throw new Error(`快照链头不存在: ${untilHash}`);
    }
    return this.events.slice(0, cut + 1);
  }

  /** 校验哈希链完整性：任何对历史事件的删改都会在此暴露。 */
  verifyChain() {
    let prev = GENESIS_HASH;
    for (const event of this.events) {
      if (event.prev_hash !== prev) {
        return { ok: false, at: event.seq, reason: "链断裂（prev_hash 不匹配）" };
      }
      if (event.hash !== eventHash(event)) {
        return { ok: false, at: event.seq, reason: "事件内容与哈希不符（历史被改写）" };
      }
      prev = event.hash;
    }
    return { ok: true, count: this.events.length, head: prev };
  }

  /** 从 JSONL 引导（重启恢复）。逐行复核链，拒绝被改动过的日志。 */
  async loadJsonl(file) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { loaded: 0 };
      throw error;
    }
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    let prev = GENESIS_HASH;
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.prev_hash !== prev || event.hash !== eventHash(event)) {
        throw new Error(`日志在第 ${event.seq} 条事件处校验失败，拒绝引导`);
      }
      this.events.push(event);
      prev = event.hash;
    }
    return { loaded: this.events.length, head: prev };
  }

  async persistJsonl(file, event) {
    await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  }
}

/** 不含 hash 字段本身的事件体哈希；规范化保证字节级可复现。 */
export function eventHash(event) {
  const { hash, ...body } = event;
  return sha256(canonical(body));
}

export { GENESIS_HASH };
