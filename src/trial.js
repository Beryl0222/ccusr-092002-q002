import {
  ConflictError,
  DomainError,
  ForbiddenError,
  assertNonEmptyString,
  canonical,
  fingerprint,
  seededRng,
  shuffle,
} from "./util.js";
import { project } from "./model.js";

/**
 * 试验设计域：品种/苗批/站点登记、方案起草与播种前冻结、
 * 随机完全区组（RCBD）布局、盲码封存、揭盲。
 *
 * 角色：
 *  lead        研究负责人：建方案、揭盲、更正录入
 *  site        站点（观察者）：只能看到本站盲码地块，离线采集
 *  statistician 统计人员：只用过门槛数据出比较结果
 *  reviewer    评审者：沿推荐意见追溯、在同一快照上复核
 */

export const ROLES = ["lead", "site", "statistician", "reviewer"];

const QUARANTINE_STATUSES = [
  "quarantine_pending",
  "quarantine_passed",
  "quarantine_rejected",
  "quarantine_revoked",
];

const FACILITIES = ["露天", "钢架大棚", "连栋温室", "智能温室"];

function requireRole(context, ...allowed) {
  if (!allowed.includes(context.role)) {
    throw new ForbiddenError(`角色 ${context.role} 无权执行该操作`);
  }
}

export class TrialService {
  constructor(store) {
    this.store = store;
  }

  state(untilHash) {
    return project(this.store.replay(untilHash));
  }

  // ---------- 基础登记：以 propagation_batch.json 的品种/代次/苗批为起点 ----------

  registerVariety(context, input) {
    requireRole(context, "lead");
    assertNonEmptyString(input.variety_code, "variety_code");
    assertNonEmptyString(input.name, "品种名称");
    const maxGeneration = Number(input.license?.max_generation);
    if (!Number.isInteger(maxGeneration) || maxGeneration < 0) {
      throw new DomainError("license.max_generation 必须是非负整数");
    }
    const state = this.state();
    if (state.varieties.has(input.variety_code)) {
      throw new ConflictError(`品种 ${input.variety_code} 已登记`);
    }
    const data = {
      variety_code: input.variety_code,
      name: input.name,
      species: input.species ?? "鲜切花",
      license: {
        region: input.license.region ?? null,
        max_generation: maxGeneration,
      },
    };
    return this.store.append("variety_registered", data, context);
  }

  registerBatch(context, input) {
    requireRole(context, "lead");
    assertNonEmptyString(input.batch_id, "batch_id");
    const state = this.state();
    const variety = state.varieties.get(input.variety_code);
    if (!variety) throw new DomainError(`品种 ${input.variety_code} 尚未登记`);
    if (state.batches.has(input.batch_id)) {
      throw new ConflictError(`苗批 ${input.batch_id} 已登记`);
    }
    const generation = Number(input.generation);
    if (!Number.isInteger(generation) || generation < 0) {
      throw new DomainError("generation 必须是非负整数");
    }
    if (generation > variety.license.max_generation) {
      throw new DomainError(
        `苗批代次 ${generation} 超过品种授权最大代次 ${variety.license.max_generation}`,
      );
    }
    const quarantineStatus = input.quarantine_status ?? "quarantine_pending";
    if (!QUARANTINE_STATUSES.includes(quarantineStatus)) {
      throw new DomainError(`未知检疫状态: ${quarantineStatus}`);
    }
    const data = {
      batch_id: input.batch_id,
      variety_code: input.variety_code,
      generation,
      quarantine_status: quarantineStatus,
      origin_site: input.origin_site ?? null,
    };
    return this.store.append("batch_registered", data, context);
  }

  registerSite(context, input) {
    requireRole(context, "lead");
    assertNonEmptyString(input.site_code, "site_code");
    const altitude = Number(input.altitude_m);
    if (!Number.isFinite(altitude) || altitude < 0) {
      throw new DomainError("altitude_m 必须是非负数字（海拔米）");
    }
    if (!FACILITIES.includes(input.facility)) {
      throw new DomainError(`facility 必须是: ${FACILITIES.join(" / ")}`);
    }
    const state = this.state();
    if (state.sites.has(input.site_code)) {
      throw new ConflictError(`站点 ${input.site_code} 已登记`);
    }
    const data = {
      site_code: input.site_code,
      name: input.name ?? input.site_code,
      altitude_m: altitude,
      facility: input.facility,
      region: input.region ?? null,
    };
    return this.store.append("site_registered", data, context);
  }

  // ---------- 方案起草：冻结前可反复修订 ----------

  draftProtocol(context, input) {
    requireRole(context, "lead");
    assertNonEmptyString(input.protocol_id, "protocol_id");
    const state = this.state();
    const existing = state.protocols.get(input.protocol_id);
    if (existing && existing.status !== "draft") {
      throw new ConflictError("方案已冻结，不能再修改");
    }

    const sites = (input.sites ?? []).map((code) => {
      if (!state.sites.has(code)) throw new DomainError(`站点 ${code} 尚未登记`);
      return code;
    });
    if (new Set(sites).size !== sites.length || sites.length < 2) {
      throw new DomainError("多点试验至少包含两个不同的登记站点");
    }

    const blocksPerSite = Number(input.blocks_per_site);
    if (!Number.isInteger(blocksPerSite) || blocksPerSite < 1) {
      throw new DomainError("blocks_per_site 必须是正整数");
    }

    const candidates = (input.candidates ?? []).map((c) =>
      this.checkEntry(state, c, "参试苗批"),
    );
    if (candidates.length < 1) {
      throw new DomainError("至少需要一个参试新品种苗批");
    }
    const control = this.checkEntry(state, input.control, "对照");
    if (candidates.some((c) => c.batch_id === control.batch_id)) {
      throw new DomainError("对照苗批不得与参试苗批相同");
    }

    const metrics = this.checkMetrics(input.metrics);
    const calendar = this.checkCalendar(input.calendar, metrics);
    const gate = this.checkGate(input.quality_gate);

    if (!Number.isFinite(Date.parse(input.sowing_at ?? ""))) {
      throw new DomainError("sowing_at 必须是合法时间（播种时刻）");
    }
    const plotSize = Number(input.plot_size);
    if (!Number.isInteger(plotSize) || plotSize <= 0) {
      throw new DomainError("plot_size 必须是正整数（每小区株数）");
    }

    const data = {
      protocol_id: input.protocol_id,
      sowing_at: input.sowing_at,
      sites,
      blocks_per_site: blocksPerSite,
      plot_size: plotSize,
      candidates,
      control,
      metrics,
      calendar,
      quality_gate: gate,
    };
    return this.store.append("protocol_drafted", data, context);
  }

  checkEntry(state, entry, label) {
    if (!entry?.variety_code || !entry?.batch_id) {
      throw new DomainError(`${label}需要 variety_code 与 batch_id`);
    }
    const variety = state.varieties.get(entry.variety_code);
    const batch = state.batches.get(entry.batch_id);
    if (!variety) throw new DomainError(`${label}品种 ${entry.variety_code} 未登记`);
    if (!batch) throw new DomainError(`${label}苗批 ${entry.batch_id} 未登记`);
    if (batch.variety_code !== entry.variety_code) {
      throw new DomainError(`${label}苗批 ${entry.batch_id} 不属于品种 ${entry.variety_code}`);
    }
    return { variety_code: entry.variety_code, batch_id: entry.batch_id };
  }

  checkMetrics(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new DomainError("metrics 至少定义一个观察指标");
    }
    const seen = new Set();
    return raw.map((m) => {
      if (!m?.code || seen.has(m.code)) throw new DomainError("指标 code 缺失或重复");
      seen.add(m.code);
      if (!["proportion", "days", "count", "score"].includes(m.type)) {
        throw new DomainError(`指标 ${m.code} 类型非法`);
      }
      return {
        code: m.code,
        name: m.name ?? m.code,
        type: m.type,
        primary: Boolean(m.primary),
        higher_is_better: Boolean(m.higher_is_better),
      };
    });
  }

  checkCalendar(raw, metrics) {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new DomainError("观察日历至少包含一个阶段");
    }
    const metricCodes = new Set(metrics.map((m) => m.code));
    return raw.map((phase) => {
      if (!phase?.code || !phase.window?.from || !phase.window?.to) {
        throw new DomainError("日历阶段需要 code 与 window.from/to");
      }
      if (Date.parse(phase.window.from) >= Date.parse(phase.window.to)) {
        throw new DomainError(`阶段 ${phase.code} 的窗口起点必须早于终点`);
      }
      const linked = phase.metrics ?? [];
      for (const code of linked) {
        if (!metricCodes.has(code)) throw new DomainError(`日历引用了未定义指标 ${code}`);
      }
      return {
        code: phase.code,
        window: { from: phase.window.from, to: phase.window.to },
        metrics: linked,
        environmental: phase.environmental ?? false,
      };
    });
  }

  checkGate(raw = {}) {
    const gate = {
      max_replacement_ratio: raw.max_replacement_ratio ?? 0.1,
      min_env_coverage: raw.min_env_coverage ?? 0.8,
    };
    if (!(gate.max_replacement_ratio >= 0 && gate.max_replacement_ratio <= 1)) {
      throw new DomainError("quality_gate.max_replacement_ratio 必须在 0~1 之间");
    }
    if (!(gate.min_env_coverage >= 0 && gate.min_env_coverage <= 1)) {
      throw new DomainError("quality_gate.min_env_coverage 必须在 0~1 之间");
    }
    return gate;
  }

  // ---------- 播种前冻结：方案、区组、盲码一次性定型 ----------

  freezeProtocol(context, protocolId) {
    requireRole(context, "lead");
    const state = this.state();
    const protocol = state.protocols.get(protocolId);
    if (!protocol) throw new DomainError("方案不存在", "NOT_FOUND", 404);
    if (protocol.status === "frozen") throw new ConflictError("方案已冻结");
    if (Date.parse(this.store.clock()) >= Date.parse(protocol.sowing_at)) {
      throw new ConflictError("超过播种时刻，方案必须在播种前冻结");
    }

    const entries = [
      ...protocol.candidates.map((e) => ({ ...e, role: "test" })),
      { ...protocol.control, role: "control" },
    ];

    // 随机种子只依赖方案内容与草稿版本，区组布局因此可被独立复算审计。
    const seed = fingerprint(
      canonical({
        protocol_id: protocol.protocol_id,
        draft_revision: protocol.draft_revision,
        sowing_at: protocol.sowing_at,
        sites: protocol.sites,
        blocks_per_site: protocol.blocks_per_site,
        entries,
      }),
    );
    const rng = seededRng(seed);

    const layout = [];
    const usedCodes = new Set();
    for (const siteCode of protocol.sites) {
      for (let block = 1; block <= protocol.blocks_per_site; block += 1) {
        const ordered = shuffle(entries, rng);
        ordered.forEach((entry, index) => {
          let blindCode;
          let salt = 0;
          do {
            blindCode =
              "M" +
              fingerprint(`${seed}|${siteCode}|${block}|${index}|${salt}`)
                .slice(0, 8)
                .toUpperCase();
            salt += 1;
          } while (usedCodes.has(blindCode));
          usedCodes.add(blindCode);
          layout.push({
            plot_id: `${siteCode}-B${block}-P${index + 1}`,
            site_code: siteCode,
            block_no: block,
            position: index + 1,
            blind_code: blindCode,
            variety_code: entry.variety_code,
            batch_id: entry.batch_id,
            entry_role: entry.role,
          });
        });
      }
    }

    const sealedManifestHash = fingerprint({
      protocol_id: protocolId,
      seed,
      layout,
      plot_size: protocol.plot_size,
      metrics: protocol.metrics,
      calendar: protocol.calendar,
      quality_gate: protocol.quality_gate,
    });

    const data = {
      protocol_id: protocolId,
      frozen_at: this.store.clock(),
      seed,
      layout,
      sealed_manifest_hash: protocol.sealed_manifest_hash ?? sealedManifestHash,
    };
    return this.store.append("protocol_frozen", data, context);
  }

  unblind(context, protocolId) {
    requireRole(context, "lead");
    const state = this.state();
    const protocol = state.protocols.get(protocolId);
    if (!protocol) throw new DomainError("方案不存在", "NOT_FOUND", 404);
    if (protocol.status !== "frozen") throw new ConflictError("方案尚未冻结");
    if (state.unblinded.has(protocolId)) {
      throw new ConflictError("方案已揭盲");
    }
    return this.store.append("trial_unblinded", { protocol_id: protocolId }, context);
  }

  /**
   * 站点视图：任何时候都只返回本站地块的盲码，
   * 揭盲前不暴露品种/苗批对应关系，避免"挑好苗上报"。
   */
  siteView(protocolId, siteCode) {
    const state = this.state();
    const protocol = state.protocols.get(protocolId);
    if (!protocol) throw new DomainError("方案不存在", "NOT_FOUND", 404);
    if (protocol.status !== "frozen") throw new ConflictError("方案尚未冻结");
    if (!protocol.sites.includes(siteCode)) {
      throw new ForbiddenError(`站点 ${siteCode} 不在该方案内`);
    }
    const isUnblinded = state.unblinded.has(protocolId);
    const plots = protocol.layout
      .filter((plot) => plot.site_code === siteCode)
      .map((plot) => {
        const base = {
          plot_id: plot.plot_id,
          block_no: plot.block_no,
          position: plot.position,
          blind_code: plot.blind_code,
        };
        return isUnblinded
          ? { ...base, variety_code: plot.variety_code, batch_id: plot.batch_id }
          : base;
      });
    return {
      protocol_id: protocolId,
      site_code: siteCode,
      status: isUnblinded ? "unblinded" : "blinded",
      sealed_manifest_hash: protocol.sealed_manifest_hash,
      calendar: protocol.calendar,
      plots,
    };
  }
}
