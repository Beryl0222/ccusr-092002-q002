import { EventStore } from "./store.js";
import { appendFile } from "node:fs/promises";
import { TrialService } from "./trial.js";
import { IngestService } from "./ingest.js";
import { AnalysisService } from "./analysis.js";

function appendJsonl(file, event) {
  return appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

/**
 * 应用门面：聚合三个域服务，集中角色上下文与跨域编排
 * （检疫状态变化 -> 自动标出受影响结论）。
 *
 * file 给定时事件以 JSONL 持久化：启动时校验哈希链并引导，
 * 每条新事件顺序落盘，进程重启后历史可完整恢复（await app.drain()）。
 */
export async function createApp({ clock, file } = {}) {
  const store = new EventStore({
    clock,
    persist: file
      ? (event) => appendJsonl(file, event)
      : null,
  });
  if (file) await store.loadJsonl(file);
  const trial = new TrialService(store);
  const ingest = new IngestService(store);
  const analysis = new AnalysisService(store);

  function contextFrom(headers) {
    const role = headers["x-role"] ?? "system";
    return {
      role,
      actor: headers["x-actor"] ?? role,
      site: headers["x-site"] ?? null,
    };
  }

  /** 检疫状态变化登记后，立即标出受影响的既有分析与推荐意见。 */
  function changeQuarantine(context, input) {
    const event = ingest.changeQuarantineStatus(context, input);
    const flag = analysis.flagQuarantineImpact(input.batch_id, event.seq);
    return {
      event_seq: event.seq,
      batch_id: input.batch_id,
      to: input.to,
      impact_flag_event_seq: flag ? flag.seq : null,
    };
  }

  return {
    store,
    trial,
    ingest,
    analysis,
    contextFrom,
    changeQuarantine,
    drain: () => store.drain(),
  };
}
