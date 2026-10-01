import crypto from "node:crypto";

/**
 * 领域通用工具：稳定哈希、确定性随机数、编码。
 * 所有需要"相同输入必然得到相同结果"的环节（事件链、快照、复算、
 * 随机区组）都走这里，禁止在别处直接使用 Math.random / Date.now。
 */

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** 规范化 JSON：键排序、无多余空白，保证跨进程字节一致。 */
export function canonical(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/** 规范化后取哈希，作为快照/封存/影响比对的指纹。 */
export function fingerprint(value) {
  return sha256(canonical(value));
}

/** 可复现的 mulberry32 伪随机数；种子相同则区组随机结果相同。 */
export function seededRng(seedHex) {
  let state = BigInt("0x" + seedHex.slice(0, 16).padEnd(16, "0")) & 0xffffffffn;
  if (state === 0n) state = 0x9e3779b9n;
  let a = Number(state) >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 洗牌，随机源由调用方注入（便于审计与复现）。 */
export function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function nowIso(clock = () => new Date().toISOString()) {
  return clock();
}

export function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(`${name} 必须是非空字符串`);
  }
  return value;
}

export class DomainError extends Error {
  constructor(message, code = "DOMAIN_ERROR", status = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

export class ConflictError extends DomainError {
  constructor(message, code = "CONFLICT") {
    super(message, code, 409);
    this.name = "ConflictError";
  }
}

export class ForbiddenError extends DomainError {
  constructor(message, code = "FORBIDDEN") {
    super(message, code, 403);
    this.name = "ForbiddenError";
  }
}
