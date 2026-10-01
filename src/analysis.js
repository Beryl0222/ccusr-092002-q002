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
 * 质量门槛 + 确定性比较统计 + 输入快照 + 检疫影响标记 + 复核。
 *
 * 统计原则：
 *  - 只用达到质量门槛的数据；每个被排除的数据点都带明确依据。
 *  - 比较基于随机区组：同一区组内"参试苗批 − 对照"配对差值，
 *    区组（站点×区组号）吸收海拔/设施等环境差异，缺失小区天然成对剔除。
 *  - 全部计算为纯函数且确定性执行；同一条快照链头必然得到同一结果。
 */

function requireRole(context, ...allowed) {
  if (!allowed.includes(context.role)) {
    throw new ForbiddenError(`角色 ${context.role} 无权执行该操作`);
  }
}

export class AnalysisService {
  constructor(store) {
    this.store = store;
  }

  state(untilHash) {
    return project(this.store.replay(untilHash));
  }

  /** 纯计算：在给定事件切片上评估门槛并产出比较结果。 */
  compute(protocolId, untilHash) {
    const slice = this.store.replay(untilHash);
    const state = project(slice);
    const snapshotHead =
      slice.length === 0
        ? "0".repeat(64)
        : slice[slice.length - 1].hash;
    const protocol = state.protocols.get(protocolId);
    if (!protocol) throw new DomainError("方案不存在", "NOT_FOUND", 404);
    if (protocol.status !== "frozen") throw new DomainError("方案尚未冻结");

    // ---- 1. 小区级偏离归集 ----
    const plotReplacement = new Map(); // plot_id -> 换苗株数
    const plotFlags = new Map(); // plot_id -> Set(偏离类型)
    for (const dev of state.deviations.values()) {
      if (dev.protocol_id !== protocolId) continue;
      if (!plotFlags.has(dev.plot_id)) plotFlags.set(dev.plot_id, []);
      plotFlags.get(dev.plot_id).push({
        type: dev.deviation_type,
        record_id: dev.record_id,
        reason: dev.reason,
        occurred_at: dev.occurred_at,
        detail: dev.detail,
        observer: dev.observer,
      });
      if (dev.deviation_type === "seedling_replacement") {
        plotReplacement.set(
          dev.plot_id,
          (plotReplacement.get(dev.plot_id) ?? 0) + Number(dev.detail.count ?? 0),
        );
      }
    }

    // ---- 2. 站点环境覆盖率门槛（按环境观察阶段，缺测阶段按 0 计） ----
    const envPhases = protocol.calendar.filter((p) => p.environmental);
    const siteEnvCoverage = new Map();
    const siteEnvPass = new Map();
    for (const siteCode of protocol.sites) {
      const perPhase = envPhases.map((phase) => {
        let latest = null;
        for (const env of state.environments.values()) {
          if (
            env.protocol_id === protocolId &&
            env.site_code === siteCode &&
            env.window_code === phase.code &&
            (!latest || env.ingest_event_seq > latest.ingest_event_seq)
          ) {
            latest = env;
          }
        }
        return latest ? latest.coverage : 0;
      });
      const coverage =
        perPhase.length === 0
          ? 1
          : perPhase.reduce((a, b) => a + b, 0) / perPhase.length;
      siteEnvCoverage.set(siteCode, Number(coverage.toFixed(6)));
      siteEnvPass.set(siteCode, coverage >= protocol.quality_gate.min_env_coverage);
    }

    // ---- 3. 逐小区门槛判定（保留依据，不删除数据） ----
    const plots = protocol.layout.map((plot) => {
      const flags = plotFlags.get(plot.plot_id) ?? [];
      const reasons = [];
      const replaced = plotReplacement.get(plot.plot_id) ?? 0;
      const ratio = replaced / protocol.plot_size;
      if (flags.some((f) => f.type === "early_elimination")) {
        reasons.push({ code: "early_elimination", detail: "小区提前淘汰" });
      }
      if (flags.some((f) => f.type === "out_of_zone_planting")) {
        reasons.push({ code: "out_of_zone_planting", detail: "越区栽种，小区归属失真" });
      }
      if (ratio > protocol.quality_gate.max_replacement_ratio + 1e-12) {
        reasons.push({
          code: "excessive_replacement",
          detail: `换苗 ${replaced}/${protocol.plot_size}（比例 ${ratio.toFixed(3)} 超过门槛 ${protocol.quality_gate.max_replacement_ratio}）`,
          ratio: Number(ratio.toFixed(6)),
        });
      }
      if (!siteEnvPass.get(plot.site_code)) {
        reasons.push({
          code: "environmental_coverage_below_gate",
          detail: `站点环境覆盖率 ${siteEnvCoverage.get(plot.site_code)} 低于门槛 ${protocol.quality_gate.min_env_coverage}`,
        });
      }
      return {
        plot_id: plot.plot_id,
        site_code: plot.site_code,
        block_no: plot.block_no,
        blind_code: plot.blind_code,
        variety_code: plot.variety_code,
        batch_id: plot.batch_id,
        entry_role: plot.entry_role,
        generation: state.batches.get(plot.batch_id)?.generation ?? null,
        quarantine_status: state.batches.get(plot.batch_id)?.quarantine_status ?? null,
        replaced,
        replacement_ratio: Number(ratio.toFixed(6)),
        deviations: flags,
        excluded: reasons.length > 0,
        exclusion_reasons: reasons,
      };
    });

    // ---- 4. 观察值取数（更正后的现值；同小区同指标取时间最近一条） ----
    const latestObservation = new Map(); // plot_id|metric -> record
    for (const rec of state.records.values()) {
      if (rec.protocol_id !== protocolId) continue;
      const key = `${rec.plot_id}|${rec.metric_code}`;
      const prev = latestObservation.get(key);
      if (
        !prev ||
        rec.observed_at > prev.observed_at ||
        (rec.observed_at === prev.observed_at && rec.ingest_event_seq > prev.ingest_event_seq)
      ) {
        latestObservation.set(key, rec);
      }
    }

    // 漏测按指标/全指标归集
    const missedByPlot = new Map();
    for (const dev of state.deviations.values()) {
      if (dev.protocol_id !== protocolId || dev.deviation_type !== "missed_measurement") continue;
      const codes = dev.detail.metric_code ? [dev.detail.metric_code] : protocol.metrics.map((m) => m.code);
      if (!missedByPlot.has(dev.plot_id)) missedByPlot.set(dev.plot_id, []);
      missedByPlot.get(dev.plot_id).push({ codes, record_id: dev.record_id, reason: dev.reason });
    }

    // ---- 5. 逐指标比较（站点内 + 跨站点汇总） ----
    const metricResults = protocol.metrics.map((metric) => {
      const cellValue = (plot) => {
        const rec = latestObservation.get(`${plot.plot_id}|${metric.code}`);
        const missed = missedByPlot.get(plot.plot_id) ?? [];
        const miss = missed.find((m) => m.codes.includes(metric.code));
        if (miss) {
          return {
            hasValue: false,
            reason: {
              code: "missed_measurement",
              detail: `漏测 ${metric.code}：${miss.reason}`,
              record_id: miss.record_id,
            },
          };
        }
        if (!rec) {
          return {
            hasValue: false,
            reason: { code: "no_observation", detail: `无 ${metric.code} 观察记录` },
          };
        }
        return {
          hasValue: true,
          value: rec.current_value,
          record_id: rec.record_id,
          observer: rec.observer,
          observed_at: rec.observed_at,
          corrected: rec.corrections.length > 0,
          corrections: rec.corrections.length,
          original_value: rec.original_value,
        };
      };

      const usable = plots
        .filter((p) => !p.excluded)
        .map((p) => ({ plot: p, cell: cellValue(p) }));
      const excludedMetricPoints = plots.map((p) => {
        if (p.excluded) {
          return { plot_id: p.plot_id, metric_code: metric.code, reasons: p.exclusion_reasons };
        }
        const cell = cellValue(p);
        if (!cell.hasValue) {
          return { plot_id: p.plot_id, metric_code: metric.code, reasons: [cell.reason] };
        }
        return null;
      }).filter(Boolean);

      const compareSite = (siteCode) => {
        const rows = usable.filter((u) => !siteCode || u.plot.site_code === siteCode);
        return compareEntries(rows, metric, protocol);
      };

      return {
        metric_code: metric.code,
        metric_name: metric.name,
        type: metric.type,
        primary: metric.primary,
        higher_is_better: metric.higher_is_better,
        sites: protocol.sites.map((siteCode) => ({
          site_code: siteCode,
          altitude_m: state.sites.get(siteCode).altitude_m,
          facility: state.sites.get(siteCode).facility,
          env_coverage: siteEnvCoverage.get(siteCode),
          env_passed: siteEnvPass.get(siteCode),
          ...compareSite(siteCode),
        })),
        pooled: compareSite(null),
        excluded_points: excludedMetricPoints,
      };
    });

    const includedRecordIds = [...latestObservation.values()]
      .filter((r) => r.protocol_id === protocolId)
      .map((r) => r.record_id)
      .sort();
    const usedDeviationIds = [...state.deviations.values()]
      .filter((d) => d.protocol_id === protocolId)
      .map((d) => d.record_id)
      .sort();
    const usedEnvironmentIds = [...state.environments.values()]
      .filter((e) => e.protocol_id === protocolId)
      .map((e) => e.record_id)
      .sort();

    const inputSnapshot = {
      protocol_id: protocolId,
      frozen_event_seq: protocol.frozen_event_seq,
      sealed_manifest_hash: protocol.sealed_manifest_hash,
      seed: protocol.seed,
      plot_size: protocol.plot_size,
      quality_gate: protocol.quality_gate,
      layout: protocol.layout,
      calendar: protocol.calendar,
      metrics: protocol.metrics,
      observations: [...state.records.values()]
        .filter((r) => r.protocol_id === protocolId)
        .map((r) => ({
          record_id: r.record_id,
          plot_id: r.plot_id,
          metric_code: r.metric_code,
          current_value: r.current_value,
          original_value: r.original_value,
          observed_at: r.observed_at,
          observer: r.observer,
          ingest_event_seq: r.ingest_event_seq,
          correction_seqs: r.corrections.map((c) => c.seq),
        }))
        .sort((a, b) => a.record_id.localeCompare(b.record_id)),
      deviations: [...state.deviations.values()]
        .filter((d) => d.protocol_id === protocolId)
        .sort((a, b) => a.record_id.localeCompare(b.record_id)),
      environments: [...state.environments.values()]
        .filter((e) => e.protocol_id === protocolId)
        .sort((a, b) => a.record_id.localeCompare(b.record_id)),
    };
    const inputSnapshotHash = fingerprint(canonical(inputSnapshot));

    return {
      protocol_id: protocolId,
      generated_at: slice.length ? slice[slice.length - 1].ts : null,
      snapshot_head: snapshotHead,
      chain_length: slice.length,
      protocol_version: {
        frozen_event_seq: protocol.frozen_event_seq,
        draft_sealed_hash: protocol.sealed_manifest_hash,
        seed: protocol.seed,
      },
      input_snapshot_hash: inputSnapshotHash,
      input_snapshot: inputSnapshot,
      site_environment: Object.fromEntries(
        protocol.sites.map((s) => [
          s,
          { coverage: siteEnvCoverage.get(s), passed: siteEnvPass.get(s) },
        ]),
      ),
      plot_quality: plots.map(({ deviations, ...rest }) => ({
        ...rest,
        deviation_ids: deviations.map((d) => d.record_id),
      })),
      metrics: metricResults,
      included_record_ids: includedRecordIds,
      used_deviation_ids: usedDeviationIds,
      used_environment_ids: usedEnvironmentIds,
    };
  }

  generateAnalysis(context, protocolId) {
    requireRole(context, "statistician");
    const state = this.state();
    const protocol = state.protocols.get(protocolId);
    if (!protocol) throw new DomainError("方案不存在", "NOT_FOUND", 404);
    if (!state.unblinded.has(protocolId)) {
      throw new ForbiddenError("揭盲前不得生成品种间比较结果（盲态保护）");
    }
    const result = this.compute(protocolId);
    const analysisId = `AN-${result.snapshot_head.slice(0, 10)}-${protocolId}`;
    const event = this.store.append(
      "analysis_generated",
      {
        analysis_id: analysisId,
        protocol_id: protocolId,
        snapshot_head: result.snapshot_head,
        input_snapshot_hash: result.input_snapshot_hash,
        protocol_version: result.protocol_version,
        result: stripSnapshot(result),
      },
      context,
    );
    return {
      analysis_id: analysisId,
      event_seq: event.seq,
      snapshot_head: result.snapshot_head,
      input_snapshot_hash: result.input_snapshot_hash,
    };
  }

  /** 评审复核：在分析固定的链头快照上重算，比对结果与快照指纹。 */
  reviewAnalysis(context, analysisId) {
    requireRole(context, "reviewer", "statistician", "lead");
    const state = this.state();
    const stored = state.analyses.get(analysisId);
    if (!stored) throw new DomainError(`分析 ${analysisId} 不存在`, "NOT_FOUND", 404);
    const recomputed = this.compute(stored.protocol_id, stored.snapshot_head);
    const resultMatches =
      fingerprint(canonical(stripSnapshot(recomputed))) ===
      fingerprint(canonical(stored.result));
    const snapshotMatches = recomputed.input_snapshot_hash === stored.input_snapshot_hash;
    const review = {
      analysis_id: analysisId,
      reviewer: context.actor,
      snapshot_head: stored.snapshot_head,
      snapshot_matches: snapshotMatches,
      result_matches: resultMatches,
      reproducible: resultMatches && snapshotMatches,
    };
    const event = this.store.append("analysis_reviewed", review, context);
    return { ...review, event_seq: event.seq };
  }

  /** 检疫影响标记：状态变化后标出受影响的既有结论，历史结论原样保留。 */
  flagQuarantineImpact(batchId, changeEventSeq) {    const state = this.state();
    const plots = new Set();
    for (const protocol of state.protocols.values()) {
      for (const plot of protocol.layout ?? []) {
        if (plot.batch_id === batchId) plots.add(plot.plot_id);
      }
    }
    const affectedAnalyses = [];
    for (const analysis of state.analyses.values()) {
      if (analysis.snapshot_head && this.isBefore(analysis.snapshot_head, changeEventSeq)) {
        const touched = analysis.result.plot_quality.some(
          (p) => p.batch_id === batchId && !p.excluded,
        );
        if (touched) {
          affectedAnalyses.push({
            analysis_id: analysis.analysis_id,
            protocol_id: analysis.protocol_id,
            snapshot_head: analysis.snapshot_head,
          });
        }
      }
    }
    const analysisIds = new Set(affectedAnalyses.map((a) => a.analysis_id));
    const affectedRecommendations = [...state.recommendations.values()]
      .filter((r) => analysisIds.has(r.analysis_id))
      .map((r) => ({
        recommendation_id: r.recommendation_id,
        analysis_id: r.analysis_id,
        decision: r.decision,
      }));

    if (affectedAnalyses.length === 0 && plots.size === 0) return null;

    const event = this.store.append(
      "quarantine_impact_flagged",
      {
        batch_id: batchId,
        change_event_seq: changeEventSeq,
        plots: [...plots].sort(),
        affected_analyses: affectedAnalyses,
        affected_recommendations: affectedRecommendations,
        note: "仅标记影响范围；既有分析与推荐意见保持原样，不重写历史。",
      },
      { actor: "system", role: "system" },
    );
    return event;
  }

  isBefore(headHash, changeSeq) {
    const index = this.store.events.findIndex((e) => e.hash === headHash);
    return index >= 0 && index + 1 < changeSeq;
  }

  /**
   * 研究负责人基于一份分析签发推荐意见。意见只引用分析指纹，
   * 不复制数值——分析被检疫标记影响时，意见随之可被识别。
   */
  issueRecommendation(context, input) {
    requireRole(context, "lead");
    assertNonEmptyString(input.recommendation_id, "recommendation_id");
    assertNonEmptyString(input.analysis_id, "analysis_id");
    if (!["推荐推广", "有条件推广", "继续试验", "不推荐"].includes(input.decision)) {
      throw new DomainError("decision 取值非法");
    }
    const state = this.state();
    if (state.recommendations.has(input.recommendation_id)) {
      throw new ConflictError("推荐意见编号已存在");
    }
    const analysis = state.analyses.get(input.analysis_id);
    if (!analysis) throw new DomainError("分析不存在", "NOT_FOUND", 404);
    if (!input.rationale || String(input.rationale).trim() === "") {
      throw new DomainError("推荐意见必须给出依据");
    }
    const event = this.store.append(
      "recommendation_issued",
      {
        recommendation_id: input.recommendation_id,
        analysis_id: input.analysis_id,
        protocol_id: analysis.protocol_id,
        snapshot_head: analysis.snapshot_head,
        input_snapshot_hash: analysis.input_snapshot_hash,
        decision: input.decision,
        rationale: String(input.rationale).trim(),
        scope_sites: input.scope_sites ?? null,
      },
      context,
    );
    return { recommendation_id: input.recommendation_id, event_seq: event.seq };
  }

  /**
   * 评审追溯链：一项推荐意见 -> 分析 -> 输入快照 -> 具体地块、观察者、
   * 协议版本（冻结事件序号/封存哈希/随机种子）与每条排除依据。
   * 并在该分析固定的快照上现场重算，证明"相同快照得到一致结果"。
   */
  traceRecommendation(context, recommendationId) {
    requireRole(context, "reviewer", "statistician", "lead");
    const state = this.state();
    const rec = state.recommendations.get(recommendationId);
    if (!rec) throw new DomainError("推荐意见不存在", "NOT_FOUND", 404);
    const analysis = state.analyses.get(rec.analysis_id);

    const recomputed = this.compute(rec.protocol_id, rec.snapshot_head);
    const reproducible =
      fingerprint(canonical(stripSnapshot(recomputed))) ===
      fingerprint(canonical(analysis.result));

    // 该推荐依赖的每个数据点：地块、观察者、观察时间、是否更正。
    const tracePlots = recomputed.plot_quality.map((plot) => ({
      plot_id: plot.plot_id,
      site_code: plot.site_code,
      block_no: plot.block_no,
      blind_code: plot.blind_code,
      variety_code: plot.variety_code,
      batch_id: plot.batch_id,
      generation: plot.generation,
      excluded: plot.excluded,
      exclusion_reasons: plot.exclusion_reasons,
      deviation_ids: plot.deviation_ids,
    }));

    const observers = [...new Set(
      recomputed.input_snapshot.observations.map((o) => o.observer),
    )].sort();

    const impacts = state.impactFlags.filter(
      (flag) =>
        flag.affected_recommendations.some(
          (r) => r.recommendation_id === recommendationId,
        ) ||
        flag.affected_analyses.some((a) => a.analysis_id === rec.analysis_id),
    );

    return {
      recommendation: {
        recommendation_id: rec.recommendation_id,
        decision: rec.decision,
        rationale: rec.rationale,
        scope_sites: rec.scope_sites,
      },
      analysis: {
        analysis_id: analysis.analysis_id,
        snapshot_head: analysis.snapshot_head,
        input_snapshot_hash: analysis.input_snapshot_hash,
      },
      protocol_version: recomputed.protocol_version,
      sites: recomputed.site_environment,
      plots: tracePlots,
      observers,
      exclusion_index: buildExclusionIndex(recomputed),
      reproducible,
      quarantine_impacts: impacts.map((flag) => ({
        batch_id: flag.batch_id,
        change_event_seq: flag.change_event_seq,
        at: flag.at,
      })),
    };
  }
}

/** 排除依据汇总：每个被排除的小区/数据点 -> 原因与来源记录，供评审逐条核对。 */
function buildExclusionIndex(result) {
  const index = [];
  for (const plot of result.plot_quality) {
    if (plot.excluded) {
      index.push({
        scope: "plot",
        plot_id: plot.plot_id,
        reasons: plot.exclusion_reasons,
        source_records: plot.deviation_ids,
      });
    }
  }
  for (const metric of result.metrics) {
    for (const point of metric.excluded_points) {
      if (!result.plot_quality.find((p) => p.plot_id === point.plot_id)?.excluded) {
        index.push({
          scope: "metric_point",
          plot_id: point.plot_id,
          metric_code: point.metric_code,
          reasons: point.reasons,
        });
      }
    }
  }
  return index;
}

/** 同一区组内参试苗批对对照的配对差值比较。 */
function compareEntries(rows, metric, protocol) {
  const blocks = new Map(); // block key -> {control: row, tests: Map(batch -> row)}
  for (const { plot, cell } of rows) {
    if (!cell.hasValue) continue;
    const key = `${plot.site_code}|${plot.block_no}`;
    if (!blocks.has(key)) blocks.set(key, new Map());
    blocks.get(key).set(plot.batch_id, { plot, value: cell.value });
  }

  const testBatches = protocol.candidates.map((c) => c.batch_id);
  const controlBatch = protocol.control.batch_id;
  const entryInfo = new Map(rows.map(({ plot }) => [plot.batch_id, plot]));

  const entryAgg = (batchId) => {
    const values = [];
    for (const cell of blocks.values()) {
      if (cell.has(batchId)) values.push(cell.get(batchId).value);
    }
    return {
      batch_id: batchId,
      variety_code: entryInfo.get(batchId)?.variety_code ?? null,
      generation: entryInfo.get(batchId)?.generation ?? null,
      mean: values.length ? mean(values) : null,
      n_plots: values.length,
    };
  };

  const contrasts = testBatches.map((batchId) => {
    const diffs = [];
    for (const [blockKey, cell] of blocks) {
      if (cell.has(batchId) && cell.has(controlBatch)) {
        diffs.push({
          block: blockKey,
          delta: cell.get(batchId).value - cell.get(controlBatch).value,
        });
      }
    }
    const n = diffs.length;
    const delta = n ? mean(diffs.map((d) => d.delta)) : null;
    const sed = n > 1 ? sampleStd(diffs.map((d) => d.delta)) / Math.sqrt(n) : null;
    const t = sed ? delta / sed : null;
    return {
      batch_id: batchId,
      versus_control: controlBatch,
      paired_blocks: n,
      delta: round(delta),
      sed: round(sed),
      t: round(t),
      df: n - 1,
      favors_test:
        delta === null
          ? null
          : metric.higher_is_better
            ? delta > 0
            : delta < 0,
      paired_block_diffs: diffs.map((d) => ({ block: d.block, delta: round(d.delta) })),
    };
  });

  return {
    blocks_total: blocks.size,
    control: entryAgg(controlBatch),
    entries: testBatches.map(entryAgg),
    contrasts,
  };
}

function stripSnapshot(result) {
  const { input_snapshot, ...rest } = result;
  return rest;
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

function round(value) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(10));
}
