import { createHash } from "node:crypto";

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export const OBSERVATION_KINDS = ["survival", "flowering", "disease", "yield", "environment", "vase_life"];

export const DEVIATION_TYPES = ["missed_observation", "seedling_replacement", "cross_zone_planting", "early_removal"];

export const DEVIATION_LABELS = {
  missed_observation: "漏测",
  seedling_replacement: "换苗",
  cross_zone_planting: "越区栽种",
  early_removal: "提前淘汰",
};

export const ROLE_RESEARCH_LEAD = "research_lead";
export const ROLE_STATISTICIAN = "statistician";

// 换苗、越区栽种、提前淘汰直接破坏小区与处理的一致性，质量门槛一律排除
const HARD_DEVIATIONS = ["cross_zone_planting", "seedling_replacement", "early_removal"];

const now = () => new Date().toISOString();

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashSnapshot(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rng) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function nextId(trial, prefix) {
  trial.counters = trial.counters ?? {};
  trial.counters[prefix] = (trial.counters[prefix] ?? 0) + 1;
  return `${prefix}-${String(trial.counters[prefix]).padStart(4, "0")}`;
}

function latestProtocol(trial) {
  return trial.protocol_versions.at(-1) ?? null;
}

function requireBy(options) {
  if (!options?.by) throw new DomainError("actor_required", "操作必须记录责任人 by");
}

function codeByTreatment(trial, treatmentId) {
  const entry = Object.entries(trial.blind_map).find(([, tid]) => tid === treatmentId);
  return entry ? entry[0] : null;
}

// 以 propagation_batch.json 的品种、代次和苗批为起点生成建试验的输入
export function trialInputFromBatch(batchSample, overrides = {}) {
  return {
    variety_code: batchSample.variety_code,
    generation: batchSample.batch?.generation ?? null,
    batch_id: batchSample.batch?.id,
    title: `${batchSample.variety_code} 多点品种试验`,
    ...overrides,
  };
}

export function createTrial(input) {
  for (const field of ["trial_id", "variety_code", "batch_id", "title", "planned_sowing_date", "created_by"]) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      throw new DomainError("invalid_trial", `建立试验缺少字段 ${field}`);
    }
  }
  return {
    trial_id: input.trial_id,
    variety_code: input.variety_code,
    generation: input.generation ?? null,
    batch_id: input.batch_id,
    title: input.title,
    planned_sowing_date: input.planned_sowing_date,
    status: "design",
    sown_at: null,
    sown_by: null,
    unblinded_at: null,
    unblinded_by: null,
    protocol_versions: [],
    blind_map: {},
    plots: [],
    observations: {},
    deviations: [],
    analyses: [],
    recommendations: [],
    quarantine_impacts: [],
    counters: {},
    created_at: input.at ?? now(),
    created_by: input.created_by,
  };
}

function validateDraft(draft, trial) {
  if (!draft || typeof draft !== "object") throw new DomainError("invalid_protocol", "试验方案不能为空");
  const sites = draft.sites;
  if (!Array.isArray(sites) || sites.length === 0) throw new DomainError("invalid_protocol", "试验方案至少需要一个站点");
  const siteIds = new Set();
  for (const site of sites) {
    if (!site.site_id) throw new DomainError("invalid_protocol", "站点缺少 site_id");
    if (siteIds.has(site.site_id)) throw new DomainError("invalid_protocol", `站点 ${site.site_id} 重复`);
    siteIds.add(site.site_id);
  }
  const treatments = draft.treatments;
  if (!Array.isArray(treatments) || treatments.length < 2) {
    throw new DomainError("invalid_protocol", "试验方案至少需要两个处理（候选与对照）");
  }
  const treatmentIds = new Set();
  let controls = 0;
  let candidates = 0;
  for (const t of treatments) {
    if (!t.treatment_id || !t.variety_code) throw new DomainError("invalid_protocol", "处理缺少 treatment_id 或 variety_code");
    if (treatmentIds.has(t.treatment_id)) throw new DomainError("invalid_protocol", `处理 ${t.treatment_id} 重复`);
    treatmentIds.add(t.treatment_id);
    if (t.kind === "control") {
      controls += 1;
    } else if (t.kind === "candidate") {
      candidates += 1;
      if (t.variety_code !== trial.variety_code) {
        throw new DomainError("invalid_protocol", `候选处理品种 ${t.variety_code} 与试验品种 ${trial.variety_code} 不一致`);
      }
    } else {
      throw new DomainError("invalid_protocol", `处理 ${t.treatment_id} 的 kind 必须是 candidate 或 control`);
    }
  }
  if (candidates === 0) throw new DomainError("invalid_protocol", "试验方案必须包含候选品种");
  if (controls === 0) throw new DomainError("invalid_protocol", "试验方案必须包含对照品种");
  const design = draft.design;
  if (!design || !Number.isInteger(design.blocks_per_site) || design.blocks_per_site < 1) {
    throw new DomainError("invalid_protocol", "随机区组设计需要 blocks_per_site >= 1 的整数");
  }
  if (!Number.isInteger(design.random_seed)) throw new DomainError("invalid_protocol", "随机区组设计需要整数 random_seed");
  const calendar = draft.calendar;
  if (!Array.isArray(calendar) || calendar.length === 0) throw new DomainError("invalid_protocol", "观察日历不能为空");
  const calendarIds = new Set();
  let primaryCount = 0;
  for (const entry of calendar) {
    if (!entry.calendar_id || !entry.metric || !entry.due_date) {
      throw new DomainError("invalid_protocol", "观察日历条目缺少 calendar_id、metric 或 due_date");
    }
    if (!OBSERVATION_KINDS.includes(entry.kind)) {
      throw new DomainError("invalid_protocol", `观察类型 ${entry.kind} 不在允许范围`);
    }
    if (calendarIds.has(entry.calendar_id)) throw new DomainError("invalid_protocol", `观察日历条目 ${entry.calendar_id} 重复`);
    calendarIds.add(entry.calendar_id);
    if (entry.primary) primaryCount += 1;
  }
  if (primaryCount === 0) throw new DomainError("invalid_protocol", "观察日历至少包含一项主要指标");
  const gate = draft.quality_gate;
  if (!gate || typeof gate.min_survival_rate !== "number" || gate.min_survival_rate < 0 || gate.min_survival_rate > 1) {
    throw new DomainError("invalid_protocol", "质量门槛需要 0..1 之间的 min_survival_rate");
  }
  if (!Number.isInteger(gate.max_missing_primary_per_plot) || gate.max_missing_primary_per_plot < 0) {
    throw new DomainError("invalid_protocol", "质量门槛需要 max_missing_primary_per_plot >= 0 的整数");
  }
  if (!Number.isInteger(gate.min_plots_per_treatment) || gate.min_plots_per_treatment < 1) {
    throw new DomainError("invalid_protocol", "质量门槛需要 min_plots_per_treatment >= 1 的整数");
  }
  if (design.blocks_per_site < gate.min_plots_per_treatment) {
    throw new DomainError("invalid_protocol", "每站区组数低于质量门槛要求的最少有效小区数");
  }
}

// 由随机种子确定性地生成盲码与区组内处理排列，同一方案重放结果一致
function buildDesign(protocol) {
  const rng = mulberry32(protocol.design.random_seed);
  const treatmentIds = protocol.treatments.map((t) => t.treatment_id);
  const blindOrder = shuffled(treatmentIds, rng);
  const blindMap = {};
  blindOrder.forEach((tid, index) => {
    blindMap[`BLIND-${index + 1}`] = tid;
  });
  const codeOf = Object.fromEntries(Object.entries(blindMap).map(([code, tid]) => [tid, code]));
  const plots = [];
  for (const site of protocol.sites) {
    for (let block = 1; block <= protocol.design.blocks_per_site; block += 1) {
      const order = shuffled(treatmentIds, rng);
      order.forEach((tid, index) => {
        plots.push({
          plot_id: `${site.site_id}-B${block}-P${index + 1}`,
          site_id: site.site_id,
          block,
          treatment_id: tid,
          blind_code: codeOf[tid],
        });
      });
    }
  }
  return { plots, blindMap };
}

// 播种前冻结试验方案；冻结后站点、处理与区组设计不可再变，只允许带理由修订日历与质量门槛
export function freezeProtocol(trial, draft, options = {}) {
  requireBy(options);
  const at = options.at ?? now();
  validateDraft(draft, trial);
  const previous = latestProtocol(trial);
  if (previous) {
    if (!options.amendment_reason) throw new DomainError("amendment_reason_required", "修订已冻结的方案必须说明修订理由");
    for (const key of ["sites", "treatments", "design"]) {
      if (canonical(previous[key]) !== canonical(draft[key])) {
        throw new DomainError("design_locked", "方案冻结后不得变更站点、处理或区组设计，只能修订观察日历与质量门槛");
      }
    }
  } else if (trial.sown_at) {
    throw new DomainError("freeze_before_sowing", "试验方案必须在播种前冻结");
  }
  const version = {
    version: trial.protocol_versions.length + 1,
    status: "frozen",
    frozen_at: at,
    frozen_by: options.by,
    amendment_reason: previous ? options.amendment_reason : null,
    post_sowing: Boolean(trial.sown_at),
    sites: draft.sites,
    treatments: draft.treatments,
    design: draft.design,
    calendar: draft.calendar,
    quality_gate: draft.quality_gate,
    metric_directions: draft.metric_directions ?? {},
    primary_metrics: [...new Set(draft.calendar.filter((e) => e.primary).map((e) => e.metric))],
  };
  if (!previous) {
    const { plots, blindMap } = buildDesign(version);
    trial.plots = plots;
    trial.blind_map = blindMap;
  }
  trial.protocol_versions.push(version);
  return version;
}

export function recordSowing(trial, options = {}) {
  requireBy(options);
  const at = options.at ?? now();
  const protocol = latestProtocol(trial);
  if (!protocol) throw new DomainError("freeze_before_sowing", "试验方案必须在播种前冻结");
  if (trial.sown_at) throw new DomainError("already_sown", "播种时间已记录，不得重复登记");
  if (at < protocol.frozen_at) throw new DomainError("freeze_before_sowing", "播种时间早于方案冻结时间，请核对时钟");
  trial.sown_at = at;
  trial.sown_by = options.by;
  trial.status = "sown";
  return trial;
}

export function unblind(trial, options = {}) {
  requireBy(options);
  if (!trial.sown_at) throw new DomainError("not_sown", "尚未播种，不能揭盲");
  if (trial.unblinded_at) throw new DomainError("already_unblinded", "试验已揭盲");
  trial.unblinded_at = options.at ?? now();
  trial.unblinded_by = options.by;
  trial.status = "unblinded";
  return trial;
}

function addDeviation(trial, input) {
  if (!DEVIATION_TYPES.includes(input.type)) {
    throw new DomainError("invalid_deviation", `偏离类型 ${input.type} 不在允许范围`);
  }
  if (input.dedupe_key && trial.deviations.some((d) => d.dedupe_key === input.dedupe_key)) {
    return null;
  }
  const deviation = {
    deviation_id: nextId(trial, "DEV"),
    type: input.type,
    plot_id: input.plot_id,
    site_id: input.site_id,
    details: input.details ?? "",
    reported_by: input.reported_by ?? "system",
    at: input.at ?? now(),
    dedupe_key: input.dedupe_key ?? null,
  };
  trial.deviations.push(deviation);
  return deviation;
}

export function reportDeviation(trial, input) {
  const plot = trial.plots.find((p) => p.plot_id === input.plot_id);
  if (!plot) throw new DomainError("unknown_plot", `未找到小区 ${input.plot_id}`);
  return addDeviation(trial, { ...input, site_id: input.site_id ?? plot.site_id });
}

function hasObservation(trial, plotId, calendarEntry) {
  return Object.values(trial.observations).some(
    (r) => r.plot_id === plotId && (r.calendar_id === calendarEntry.calendar_id || (!r.calendar_id && r.metric === calendarEntry.metric)),
  );
}

// 按观察日历检测漏测，结果作为方案偏离保留；同一小区同一计划项只记一次
export function detectMissedObservations(trial, asOf) {
  const protocol = latestProtocol(trial);
  if (!protocol) throw new DomainError("protocol_not_frozen", "试验方案尚未冻结");
  const created = [];
  for (const entry of protocol.calendar) {
    if (entry.due_date >= asOf) continue;
    for (const plot of trial.plots) {
      if (hasObservation(trial, plot.plot_id, entry)) continue;
      const deviation = addDeviation(trial, {
        type: "missed_observation",
        plot_id: plot.plot_id,
        site_id: plot.site_id,
        details: `漏测 ${entry.metric}（计划 ${entry.calendar_id}，截止 ${entry.due_date}）`,
        reported_by: "system",
        at: asOf,
        dedupe_key: `missed:${plot.plot_id}:${entry.calendar_id}`,
      });
      if (deviation) created.push(deviation);
    }
  }
  return created;
}

function sameRecord(existing, input) {
  return (
    existing.plot_id === input.plot_id &&
    existing.site_id === input.site_id &&
    existing.kind === input.kind &&
    existing.metric === input.metric &&
    existing.observer_id === input.observer_id &&
    existing.observed_at === input.observed_at &&
    canonical(existing.original_value) === canonical(input.value)
  );
}

// 站点离线记录幂等汇入：同一 record_id 重放返回原记录，内容冲突必须走纠错流程
export function ingestObservation(trial, input, options = {}) {
  if (!latestProtocol(trial)) throw new DomainError("protocol_not_frozen", "试验方案未冻结，不能汇入观察记录");
  for (const field of ["record_id", "site_id", "plot_id", "kind", "metric", "observer_id", "observed_at"]) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      throw new DomainError("invalid_record", `观察记录缺少字段 ${field}`);
    }
  }
  if (!OBSERVATION_KINDS.includes(input.kind)) throw new DomainError("invalid_record", `观察类型 ${input.kind} 不在允许范围`);
  if (input.value === undefined) throw new DomainError("invalid_record", "观察记录缺少字段 value");
  const plot = trial.plots.find((p) => p.plot_id === input.plot_id);
  if (!plot) throw new DomainError("unknown_plot", `未找到小区 ${input.plot_id}`);
  if (plot.site_id !== input.site_id) throw new DomainError("plot_site_mismatch", `小区 ${input.plot_id} 不属于站点 ${input.site_id}`);
  const existing = trial.observations[input.record_id];
  if (existing) {
    if (sameRecord(existing, input)) return { record: existing, deduplicated: true };
    throw new DomainError("idempotency_conflict", "同一记录编号提交了不同内容，请使用纠错流程");
  }
  const record = {
    record_id: input.record_id,
    trial_id: trial.trial_id,
    site_id: input.site_id,
    plot_id: input.plot_id,
    calendar_id: input.calendar_id ?? null,
    kind: input.kind,
    metric: input.metric,
    unit: input.unit ?? null,
    observer_id: input.observer_id,
    observed_at: input.observed_at,
    original_value: input.value,
    current_value: input.value,
    version: 1,
    corrections: [],
    suspect: false,
    ingested_at: options.at ?? now(),
  };
  trial.observations[record.record_id] = record;
  // 越区栽种检测：记录声明的盲码与地块分配不一致时自动记为方案偏离
  if (input.blind_code && input.blind_code !== plot.blind_code) {
    record.suspect = true;
    addDeviation(trial, {
      type: "cross_zone_planting",
      plot_id: plot.plot_id,
      site_id: plot.site_id,
      details: `记录 ${input.record_id} 声明盲码 ${input.blind_code}，地块分配为 ${plot.blind_code}`,
      reported_by: input.observer_id,
      at: options.at,
    });
  }
  return { record, deduplicated: false };
}

// 研究负责人可纠正录入错误：原值保留在 original_value 与 corrections 中，揭盲后主要指标锁定
export function correctObservation(trial, recordId, input = {}) {
  const record = trial.observations[recordId];
  if (!record) throw new DomainError("unknown_record", `未找到观察记录 ${recordId}`);
  if (input.role !== ROLE_RESEARCH_LEAD) throw new DomainError("forbidden", "只有研究负责人可以纠正录入错误");
  if (!input.reason) throw new DomainError("reason_required", "纠正必须说明理由");
  if (input.value === undefined) throw new DomainError("invalid_correction", "纠正缺少新值 value");
  const protocol = latestProtocol(trial);
  if (trial.unblinded_at && protocol.primary_metrics.includes(record.metric)) {
    throw new DomainError("primary_locked", "揭盲后不得改动主要指标");
  }
  if (canonical(input.value) === canonical(record.current_value)) {
    throw new DomainError("no_change", "纠正值与当前值相同");
  }
  record.corrections.push({
    from: record.current_value,
    to: input.value,
    reason: input.reason,
    by: input.by,
    at: input.at ?? now(),
  });
  record.current_value = input.value;
  record.version += 1;
  return record;
}

function plotMetricMean(trial, plotId, metric) {
  const values = Object.values(trial.observations)
    .filter((r) => r.plot_id === plotId && r.metric === metric && typeof r.current_value === "number")
    .map((r) => r.current_value);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function countMissingPrimary(trial, protocol, plotId, asOf) {
  let missing = 0;
  for (const entry of protocol.calendar) {
    if (!entry.primary || entry.due_date >= asOf) continue;
    if (!hasObservation(trial, plotId, entry)) missing += 1;
  }
  return missing;
}

function stats(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: round6(mean), sd: round6(sd), min: round6(Math.min(...values)), max: round6(Math.max(...values)) };
}

// 由输入快照重算比较结果；verify 与 runAnalysis 共用，保证相同快照得到一致结果
function computeResults(records, plots, treatmentsMeta, metrics, directions) {
  const treatmentByPlot = new Map(plots.map((p) => [p.plot_id, p.treatment_id]));
  const plotMetricValues = new Map();
  for (const r of records) {
    const key = `${r.plot_id}@${r.metric}`;
    if (!plotMetricValues.has(key)) plotMetricValues.set(key, []);
    plotMetricValues.get(key).push(r.value);
  }
  const plotMeans = new Map();
  for (const [key, values] of plotMetricValues) {
    plotMeans.set(key, values.reduce((a, b) => a + b, 0) / values.length);
  }
  const treatments = {};
  for (const [tid, meta] of Object.entries(treatmentsMeta)) {
    const metricStats = {};
    for (const metric of metrics) {
      const means = plots
        .filter((p) => treatmentByPlot.get(p.plot_id) === tid && plotMeans.has(`${p.plot_id}@${metric}`))
        .map((p) => plotMeans.get(`${p.plot_id}@${metric}`));
      if (means.length > 0) metricStats[metric] = stats(means);
    }
    treatments[tid] = { ...meta, metrics: metricStats };
  }
  const comparisons = [];
  const controls = Object.entries(treatmentsMeta)
    .filter(([, meta]) => meta.kind === "control")
    .map(([tid]) => tid);
  for (const metric of metrics) {
    for (const [tid, meta] of Object.entries(treatmentsMeta)) {
      if (meta.kind === "control") continue;
      for (const controlId of controls) {
        const t = treatments[tid].metrics[metric];
        const c = treatments[controlId]?.metrics[metric];
        if (t && c) comparisons.push({ metric, treatment_id: tid, control_id: controlId, diff: round6(t.mean - c.mean) });
      }
    }
  }
  const rankings = {};
  for (const metric of metrics) {
    const dir = directions?.[metric] === "low" ? 1 : -1;
    rankings[metric] = Object.entries(treatments)
      .filter(([, t]) => t.metrics[metric])
      .sort((a, b) => dir * (a[1].metrics[metric].mean - b[1].metrics[metric].mean))
      .map(([tid]) => tid);
  }
  return { metrics, treatments, comparisons, rankings };
}

// 统计人员生成带输入快照的比较结果：只纳入达到质量门槛的小区，排除项逐条给出依据
export function runAnalysis(trial, input = {}) {
  const at = input.at ?? now();
  if (input.role !== ROLE_STATISTICIAN) throw new DomainError("forbidden", "只有统计人员可以生成比较结果");
  if (!trial.unblinded_at) throw new DomainError("still_blinded", "揭盲后才能生成比较结果");
  const protocol = latestProtocol(trial);
  const metrics = input.metrics ?? protocol.primary_metrics;
  if (!Array.isArray(metrics) || metrics.length === 0) throw new DomainError("invalid_metrics", "必须指定至少一个统计指标");
  const knownMetrics = new Set(protocol.calendar.map((e) => e.metric));
  for (const metric of metrics) {
    if (!knownMetrics.has(metric)) throw new DomainError("invalid_metrics", `指标 ${metric} 不在观察日历中`);
  }
  detectMissedObservations(trial, at);
  const gate = protocol.quality_gate;
  const deviationsByPlot = new Map();
  for (const d of trial.deviations) {
    if (!deviationsByPlot.has(d.plot_id)) deviationsByPlot.set(d.plot_id, []);
    deviationsByPlot.get(d.plot_id).push(d);
  }
  const exclusions = [];
  const validPlots = [];
  for (const plot of trial.plots) {
    const hard = (deviationsByPlot.get(plot.plot_id) ?? []).find((d) => HARD_DEVIATIONS.includes(d.type));
    if (hard) {
      exclusions.push({ plot_id: plot.plot_id, reason: `方案偏离（${DEVIATION_LABELS[hard.type]}）：${hard.details}` });
      continue;
    }
    const missing = countMissingPrimary(trial, protocol, plot.plot_id, at);
    if (missing > gate.max_missing_primary_per_plot) {
      exclusions.push({ plot_id: plot.plot_id, reason: `主要指标漏测 ${missing} 次，超过门槛 ${gate.max_missing_primary_per_plot}` });
      continue;
    }
    const survival = plotMetricMean(trial, plot.plot_id, "survival");
    if (survival !== null && survival < gate.min_survival_rate) {
      exclusions.push({ plot_id: plot.plot_id, reason: `成活率 ${round6(survival)} 低于质量门槛 ${gate.min_survival_rate}` });
      continue;
    }
    validPlots.push(plot);
  }
  const validPlotIds = new Set(validPlots.map((p) => p.plot_id));
  const plotsByTreatment = new Map();
  for (const p of validPlots) {
    if (!plotsByTreatment.has(p.treatment_id)) plotsByTreatment.set(p.treatment_id, []);
    plotsByTreatment.get(p.treatment_id).push(p);
  }
  for (const t of protocol.treatments) {
    const plots = plotsByTreatment.get(t.treatment_id) ?? [];
    if (plots.length >= gate.min_plots_per_treatment) continue;
    for (const p of plots) {
      exclusions.push({ plot_id: p.plot_id, reason: `处理 ${t.treatment_id} 有效小区 ${plots.length} 个，低于门槛 ${gate.min_plots_per_treatment}` });
      validPlotIds.delete(p.plot_id);
    }
    if (plots.length === 0) {
      exclusions.push({ treatment_id: t.treatment_id, reason: `处理有效小区 0 个，低于门槛 ${gate.min_plots_per_treatment}` });
    }
  }
  const records = Object.values(trial.observations)
    .filter((r) => validPlotIds.has(r.plot_id) && metrics.includes(r.metric) && typeof r.current_value === "number")
    .map((r) => ({
      record_id: r.record_id,
      version: r.version,
      plot_id: r.plot_id,
      site_id: r.site_id,
      metric: r.metric,
      value: r.current_value,
    }))
    .sort((a, b) => (a.record_id < b.record_id ? -1 : 1));
  const sortedExclusions = exclusions.slice().sort((a, b) => canonical(a) < canonical(b) ? -1 : 1);
  const snapshot = {
    protocol_version: protocol.version,
    quality_gate: gate,
    metrics,
    records,
    exclusions: sortedExclusions,
  };
  const snapshotHash = hashSnapshot(snapshot);
  const existing = trial.analyses.find((a) => a.snapshot_hash === snapshotHash);
  if (existing) return { analysis: existing, reused: true };
  const treatmentsMeta = Object.fromEntries(
    protocol.treatments.map((t) => [
      t.treatment_id,
      { blind_code: codeByTreatment(trial, t.treatment_id), variety_code: t.variety_code, kind: t.kind },
    ]),
  );
  const analysis = {
    analysis_id: nextId(trial, "AN"),
    trial_id: trial.trial_id,
    protocol_version: protocol.version,
    snapshot,
    snapshot_hash: snapshotHash,
    treatments: treatmentsMeta,
    metric_directions: protocol.metric_directions,
    results: computeResults(records, trial.plots, treatmentsMeta, metrics, protocol.metric_directions),
    created_by: input.by,
    created_at: at,
    quarantine_impacts: [],
  };
  trial.analyses.push(analysis);
  return { analysis, reused: false };
}

// 评审复核：在相同快照上重算，结果必须与存档一致
export function verifyAnalysis(trial, analysisId) {
  const analysis = trial.analyses.find((a) => a.analysis_id === analysisId);
  if (!analysis) throw new DomainError("unknown_analysis", `未找到分析结果 ${analysisId}`);
  const hashOk = hashSnapshot(analysis.snapshot) === analysis.snapshot_hash;
  const results = computeResults(analysis.snapshot.records, trial.plots, analysis.treatments, analysis.snapshot.metrics, analysis.metric_directions);
  const resultsOk = canonical(results) === canonical(analysis.results);
  return { analysis_id: analysisId, consistent: hashOk && resultsOk, snapshot_hash_ok: hashOk, results_ok: resultsOk };
}

export function createRecommendation(trial, input = {}) {
  if (input.role !== ROLE_RESEARCH_LEAD) throw new DomainError("forbidden", "只有研究负责人可以形成推荐意见");
  if (!input.conclusion) throw new DomainError("invalid_recommendation", "推荐意见缺少结论 conclusion");
  const analysis = trial.analyses.find((a) => a.analysis_id === input.analysis_id);
  if (!analysis) throw new DomainError("unknown_analysis", `未找到分析结果 ${input.analysis_id}`);
  const recommendation = {
    recommendation_id: nextId(trial, "REC"),
    trial_id: trial.trial_id,
    analysis_id: analysis.analysis_id,
    snapshot_hash: analysis.snapshot_hash,
    recommended_variety_code: input.recommended_variety_code ?? trial.variety_code,
    conclusion: input.conclusion,
    created_by: input.by,
    created_at: input.at ?? now(),
    quarantine_impacts: [],
  };
  trial.recommendations.push(recommendation);
  return recommendation;
}

function treatmentBatch(treatment, trial) {
  return treatment.batch_id ?? (treatment.kind === "candidate" ? trial.batch_id : null);
}

// 苗批检疫状态变化：标出受影响的分析与推荐，历史结果保持原样
export function applyQuarantineStatus(trials, batchId, input = {}) {
  const at = input.at ?? now();
  const affected = [];
  for (const trial of trials) {
    const protocol = latestProtocol(trial);
    if (!protocol) continue;
    const involves =
      trial.batch_id === batchId || protocol.treatments.some((t) => treatmentBatch(t, trial) === batchId);
    if (!involves) continue;
    const affectedTreatments = new Set(
      protocol.treatments.filter((t) => treatmentBatch(t, trial) === batchId).map((t) => t.treatment_id),
    );
    const affectedPlots = new Set(trial.plots.filter((p) => affectedTreatments.has(p.treatment_id)).map((p) => p.plot_id));
    const impact = { batch_id: batchId, status: input.status, by: input.by ?? null, at };
    trial.quarantine_impacts.push(impact);
    const entry = { trial_id: trial.trial_id, analyses: [], recommendations: [] };
    for (const analysis of trial.analyses) {
      if (!analysis.snapshot.records.some((r) => affectedPlots.has(r.plot_id))) continue;
      analysis.quarantine_impacts.push(impact);
      entry.analyses.push(analysis.analysis_id);
      for (const rec of trial.recommendations.filter((r) => r.analysis_id === analysis.analysis_id)) {
        rec.quarantine_impacts.push(impact);
        entry.recommendations.push(rec.recommendation_id);
      }
    }
    affected.push(entry);
  }
  return affected;
}

// 从推荐意见追到具体地块、观察者、协议版本与排除依据
export function traceRecommendation(trial, recommendationId) {
  const recommendation = trial.recommendations.find((r) => r.recommendation_id === recommendationId);
  if (!recommendation) throw new DomainError("unknown_recommendation", `未找到推荐意见 ${recommendationId}`);
  const analysis = trial.analyses.find((a) => a.analysis_id === recommendation.analysis_id);
  const protocol = trial.protocol_versions.find((v) => v.version === analysis.protocol_version);
  const inputs = analysis.snapshot.records.map((s) => {
    const live = trial.observations[s.record_id];
    const plot = trial.plots.find((p) => p.plot_id === s.plot_id);
    return {
      record_id: s.record_id,
      plot_id: s.plot_id,
      site_id: s.site_id,
      block: plot?.block ?? null,
      metric: s.metric,
      value: s.value,
      version: s.version,
      observer_id: live?.observer_id ?? null,
      observed_at: live?.observed_at ?? null,
      corrections: live ? live.corrections.length : null,
    };
  });
  return {
    recommendation,
    analysis: {
      analysis_id: analysis.analysis_id,
      snapshot_hash: analysis.snapshot_hash,
      protocol_version: analysis.protocol_version,
      created_by: analysis.created_by,
      created_at: analysis.created_at,
      results: analysis.results,
    },
    protocol: {
      version: protocol.version,
      frozen_at: protocol.frozen_at,
      frozen_by: protocol.frozen_by,
      amendment_reason: protocol.amendment_reason,
    },
    treatments: protocol.treatments.map((t) => ({
      ...t,
      blind_code: codeByTreatment(trial, t.treatment_id),
    })),
    inputs,
    exclusions: analysis.snapshot.exclusions,
    quarantine_impacts: analysis.quarantine_impacts,
  };
}
