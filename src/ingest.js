import {
  ConflictError,
  DomainError,
  ForbiddenError,
  assertNonEmptyString,
  canonical,
  fingerprint,
} from "./util.js";
import { project } from "./model.js";

/**
 * 站点离线采集汇入。
 *
 * 幂等：bundle_id 重复提交直接返回首次接收结果，不产生第二条事件；
 *      跨 bundle 的 record_id 内容一致视为重发跳过，内容不一致拒绝。
 * 留存：漏测、换苗、越区栽种、提前淘汰一律作为 deviation 记录原样保留，
 *      不丢弃、不"修正"成正常值；是否排除由质量门槛决定。
 */

const DEVIATION_TYPES = [
  "missed_measurement",
  "seedling_replacement",
  "out_of_zone_planting",
  "early_elimination",
];

function requireRole(context, ...allowed) {
  if (!allowed.includes(context.role)) {
    throw new ForbiddenError(`角色 ${context.role} 无权执行该操作`);
  }
}

export class IngestService {
  constructor(store) {
    this.store = store;
  }

  state(untilHash) {
    return project(this.store.replay(untilHash));
  }

  ingestBundle(context, input) {
    requireRole(context, "site");
    assertNonEmptyString(input.protocol_id, "protocol_id");
    assertNonEmptyString(input.bundle_id, "bundle_id");
    assertNonEmptyString(input.site_code, "site_code");

    const state = this.state();
    const protocol = state.protocols.get(input.protocol_id);
    if (!protocol) throw new DomainError("方案不存在", "NOT_FOUND", 404);
    if (protocol.status !== "frozen") throw new ConflictError("方案尚未冻结，不能汇入");
    if (input.site_code !== context.site) {
      throw new ForbiddenError("站点只能提交本站数据");
    }
    if (!protocol.sites.includes(input.site_code)) {
      throw new ForbiddenError(`站点 ${input.site_code} 不在该方案内`);
    }

    // 整包幂等：同一 bundle 重传，原样返回首次接收摘要。
    const bundleKey = `bundle:${input.protocol_id}:${input.bundle_id}`;
    if (state.idempotency.has(bundleKey)) {
      const first = state.bundles.get(input.bundle_id);
      return {
        status: "duplicate",
        bundle_id: input.bundle_id,
        event_seq: first.accepted_event_seq,
        accepted: first.accepted.length,
      };
    }

    if (!Array.isArray(input.records) || input.records.length === 0) {
      throw new DomainError("records 不能为空（离线批次至少一条记录）");
    }

    const plotByCode = new Map(
      protocol.layout
        .filter((plot) => plot.site_code === input.site_code)
        .map((plot) => [plot.blind_code, plot]),
    );
    const metricByCode = new Map(protocol.metrics.map((m) => [m.code, m]));
    const phaseByCode = new Map(protocol.calendar.map((p) => [p.code, p]));

    const errors = [];
    const seenInBundle = new Set();
    const duplicates = [];
    const accepted = [];

    input.records.forEach((raw, index) => {
      const where = `records[${index}]`;
      try {
        if (!raw?.record_id) throw new DomainError("缺少 record_id");
        if (seenInBundle.has(raw.record_id)) {
          throw new DomainError(`record_id ${raw.record_id} 在同一 bundle 内重复`);
        }
        seenInBundle.add(raw.record_id);
        assertNonEmptyString(raw.observer ?? "", `${where}.observer`);

        const recordKey = `record:${input.protocol_id}:${raw.record_id}`;
        if (state.idempotency.has(recordKey)) {
          // 跨 bundle 撞号：提交体指纹一致即幂等跳过，不一致是真冲突。
          const same = findAcceptedRecord(state, input.protocol_id, raw.record_id);
          if (same && same.submit_fingerprint === submissionFingerprint(raw)) {
            duplicates.push(raw.record_id);
            return;
          }
          throw new ConflictError(`record_id ${raw.record_id} 已用于不同内容`);
        }

        let record;
        if (raw.kind === "observation") {
          record = this.buildObservation(raw, { plotByCode, metricByCode });
        } else if (raw.kind === "environment") {
          record = this.buildEnvironment(raw, { phaseByCode });
        } else if (raw.kind === "deviation") {
          record = this.buildDeviation(raw, { plotByCode, metricByCode, phaseByCode });
        } else {
          throw new DomainError(`kind 必须是 observation / environment / deviation`);
        }

        accepted.push({
          ...record,
          protocol_id: input.protocol_id,
          site_code: input.site_code,
          client_ts: raw.client_ts ?? null,
          submit_fingerprint: submissionFingerprint(raw),
        });
      } catch (error) {
        errors.push(`${where}: ${error.message}`);
      }
    });

    if (errors.length > 0) {
      throw new DomainError(`bundle 校验失败，整包未接收：\n- ${errors.join("\n- ")}`, "BUNDLE_REJECTED");
    }

    const event = this.store.append(
      "ingest_bundle_accepted",
      {
        protocol_id: input.protocol_id,
        bundle_id: input.bundle_id,
        site_code: input.site_code,
        submitted_at: input.submitted_at ?? this.store.clock(),
        record_count: accepted.length,
        duplicate_count: duplicates.length,
        accepted,
      },
      context,
    );

    return {
      status: "accepted",
      bundle_id: input.bundle_id,
      event_seq: event.seq,
      accepted: accepted.length,
      duplicates: duplicates.length,
    };
  }

  buildObservation(raw, { plotByCode, metricByCode }) {
    const plot = plotByCode.get(raw.blind_code);
    if (!plot) throw new DomainError(`盲码 ${raw.blind_code} 不属于本站地块`);
    const metric = metricByCode.get(raw.metric_code);
    if (!metric) throw new DomainError(`指标 ${raw.metric_code} 不在冻结方案中`);
    if (!Number.isFinite(Date.parse(raw.observed_at ?? ""))) {
      throw new DomainError("observed_at 时间非法");
    }
    const value = Number(raw.value);
    if (!Number.isFinite(value)) throw new DomainError("value 必须是数字");
    if (metric.type === "proportion" && (value < 0 || value > 1)) {
      throw new DomainError(`比例型指标 ${metric.code} 取值必须在 0~1`);
    }
    if (metric.type === "count" && (!Number.isInteger(value) || value < 0)) {
      throw new DomainError(`计数型指标 ${metric.code} 必须是非负整数`);
    }
    return {
      record_type: "observation",
      record_id: raw.record_id,
      blind_code: raw.blind_code,
      plot_id: plot.plot_id,
      metric_code: raw.metric_code,
      value,
      observed_at: raw.observed_at,
      observer: raw.observer,
      note: raw.note ?? null,
    };
  }

  buildEnvironment(raw, { phaseByCode }) {
    const phase = phaseByCode.get(raw.window_code);
    if (!phase) throw new DomainError(`环境记录窗口 ${raw.window_code} 不在观察日历中`);
    if (!phase.environmental) {
      throw new DomainError(`阶段 ${raw.window_code} 未标记为环境观察阶段`);
    }
    const readings = raw.readings;
    if (!readings || typeof readings !== "object" || Array.isArray(readings)) {
      throw new DomainError("readings 必须是 {传感器: 数值} 对象");
    }
    for (const [key, val] of Object.entries(readings)) {
      if (!Number.isFinite(Number(val))) {
        throw new DomainError(`环境读数 ${key} 不是数字`);
      }
    }
    const coverage = Number(raw.coverage);
    if (!(coverage >= 0 && coverage <= 1)) {
      throw new DomainError("coverage 必须在 0~1 之间（窗口内有效采集占比）");
    }
    return {
      record_type: "environment",
      record_id: raw.record_id,
      window_code: raw.window_code,
      readings,
      coverage,
      observed_at: raw.observed_at ?? null,
      observer: raw.observer,
    };
  }

  buildDeviation(raw, { plotByCode, metricByCode, phaseByCode }) {
    const plot = plotByCode.get(raw.blind_code);
    if (!plot) throw new DomainError(`盲码 ${raw.blind_code} 不属于本站地块`);
    if (!DEVIATION_TYPES.includes(raw.deviation_type)) {
      throw new DomainError(
        `deviation_type 必须是: ${DEVIATION_TYPES.join(" / ")}`,
      );
    }
    const detail = raw.detail ?? {};
    if (typeof detail !== "object" || Array.isArray(detail)) {
      throw new DomainError("detail 必须是对象");
    }

    if (raw.deviation_type === "missed_measurement") {
      if (detail.metric_code && !metricByCode.has(detail.metric_code)) {
        throw new DomainError(`漏测指标 ${detail.metric_code} 不在方案中`);
      }
      if (detail.phase_code && !phaseByCode.has(detail.phase_code)) {
        throw new DomainError(`漏测阶段 ${detail.phase_code} 不在日历中`);
      }
    }
    if (raw.deviation_type === "seedling_replacement") {
      const count = Number(detail.count);
      if (!Number.isInteger(count) || count <= 0) {
        throw new DomainError("换苗 detail.count 必须是正整数（株数）");
      }
    }
    if (raw.deviation_type === "early_elimination") {
      if (!Number.isFinite(Date.parse(detail.eliminated_at ?? ""))) {
        throw new DomainError("提前淘汰需要 detail.eliminated_at 时间");
      }
    }
    if (!raw.occurred_at || !Number.isFinite(Date.parse(raw.occurred_at))) {
      throw new DomainError("偏离记录需要 occurred_at 发生时间");
    }
    if (!raw.reason || String(raw.reason).trim() === "") {
      throw new DomainError("偏离记录必须填写原因");
    }

    return {
      record_type: "deviation",
      record_id: raw.record_id,
      blind_code: raw.blind_code,
      plot_id: plot.plot_id,
      deviation_type: raw.deviation_type,
      occurred_at: raw.occurred_at,
      reason: String(raw.reason).trim(),
      detail,
      observer: raw.observer,
    };
  }

  /**
   * 研究负责人更正录入错误：原值不删除，更正轨迹挂在记录上。
   * 揭盲后，主要指标（primary）锁定，任何人不得改动。
   */
  correctObservation(context, input) {
    requireRole(context, "lead");
    assertNonEmptyString(input.record_id, "record_id");
    if (!input.reason || String(input.reason).trim() === "") {
      throw new DomainError("更正必须填写原因");
    }
    const newValue = Number(input.new_value);
    if (!Number.isFinite(newValue)) throw new DomainError("new_value 必须是数字");

    const state = this.state();
    const record = state.records.get(input.record_id);
    if (!record) throw new DomainError(`观察记录 ${input.record_id} 不存在`, "NOT_FOUND", 404);
    if (record.current_value === newValue) {
      throw new ConflictError("新值与现值相同，无需更正");
    }
    const protocol = state.protocols.get(record.protocol_id);
    const metric = protocol.metrics.find((m) => m.code === record.metric_code);
    if (metric.type === "proportion" && (newValue < 0 || newValue > 1)) {
      throw new DomainError("比例型指标更正值必须在 0~1");
    }
    const unblindedAt = state.unblinded.get(record.protocol_id);
    if (unblindedAt && metric.primary) {
      throw new ForbiddenError(
        "方案已揭盲，主要指标锁定，不得更正（可发起复核或新一轮试验）",
        "PRIMARY_LOCKED",
      );
    }

    return this.store.append(
      "observation_corrected",
      {
        record_id: input.record_id,
        protocol_id: record.protocol_id,
        metric_code: record.metric_code,
        new_value: newValue,
        reason: String(input.reason).trim(),
      },
      context,
    );
  }

  /** 检疫状态变化只登记事实；对既有结论的影响由 impact 标记另行标出。 */
  changeQuarantineStatus(context, input) {
    requireRole(context, "lead");
    assertNonEmptyString(input.batch_id, "batch_id");
    const state = this.state();
    const batch = state.batches.get(input.batch_id);
    if (!batch) throw new DomainError(`苗批 ${input.batch_id} 不存在`, "NOT_FOUND", 404);
    const allowed = ["quarantine_pending", "quarantine_passed", "quarantine_rejected", "quarantine_revoked"];
    if (!allowed.includes(input.to)) throw new DomainError(`目标检疫状态非法: ${input.to}`);
    if (input.to === batch.quarantine_status) {
      throw new ConflictError("苗批已处于该状态");
    }
    if (!input.reason || String(input.reason).trim() === "") {
      throw new DomainError("检疫状态变化必须填写依据/原因");
    }
    return this.store.append(
      "quarantine_status_changed",
      {
        batch_id: input.batch_id,
        from: batch.quarantine_status,
        to: input.to,
        reason: String(input.reason).trim(),
      },
      context,
    );
  }
}

function findAcceptedRecord(state, protocolId, recordId) {
  const obs = state.records.get(recordId);
  if (obs && obs.protocol_id === protocolId) return obs;
  const env = state.environments.get(recordId);
  if (env && env.protocol_id === protocolId) return env;
  const dev = state.deviations.get(recordId);
  if (dev && dev.protocol_id === protocolId) return dev;
  return null;
}

/**
 * 站点提交体指纹：仅覆盖站点实际填写的字段（canonical 会忽略键顺序，
 * 但不忽略缺省键，因此先归一化缺省字段），用于离线重发去重。
 */
function submissionFingerprint(raw) {
  const normalized = {
    kind: raw.kind,
    record_id: raw.record_id,
    observer: raw.observer,
    client_ts: raw.client_ts ?? null,
  };
  if (raw.kind === "observation") {
    Object.assign(normalized, {
      blind_code: raw.blind_code,
      metric_code: raw.metric_code,
      value: Number(raw.value),
      observed_at: raw.observed_at,
      note: raw.note ?? null,
    });
  } else if (raw.kind === "environment") {
    Object.assign(normalized, {
      window_code: raw.window_code,
      readings: raw.readings,
      coverage: Number(raw.coverage),
      observed_at: raw.observed_at ?? null,
    });
  } else {
    Object.assign(normalized, {
      blind_code: raw.blind_code,
      deviation_type: raw.deviation_type,
      occurred_at: raw.occurred_at,
      reason: String(raw.reason).trim(),
      detail: raw.detail ?? {},
    });
  }
  return fingerprint(canonical(normalized));
}
