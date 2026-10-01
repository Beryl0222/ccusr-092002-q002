/**
 * 投影：从事件流重放出当前状态。纯函数，不做任何写操作。
 * 复核时对事件流切片重放，即可还原任意历史时刻的状态。
 */

export function project(events) {
  const state = {
    varieties: new Map(),
    batches: new Map(),
    sites: new Map(),
    protocols: new Map(),
    unblinded: new Map(),
    records: new Map(), // record_id -> 观察记录（含更正轨迹）
    environments: new Map(), // record_id -> 环境记录
    deviations: new Map(),
    bundles: new Map(), // bundle_id -> 接收结果
    idempotency: new Set(),
    analyses: new Map(),
    recommendations: new Map(),
    reviews: [],
    impactFlags: [],
  };

  for (const event of events) {
    apply(state, event);
  }
  return state;
}

function apply(state, event) {
  switch (event.type) {
    case "variety_registered": {
      state.varieties.set(event.data.variety_code, { ...event.data });
      break;
    }
    case "batch_registered": {
      state.batches.set(event.data.batch_id, {
        ...event.data,
        quarantine_history: [
          { status: event.data.quarantine_status, at: event.ts, seq: event.seq },
        ],
      });
      break;
    }
    case "site_registered": {
      state.sites.set(event.data.site_code, { ...event.data });
      break;
    }
    case "protocol_drafted": {
      const prev = state.protocols.get(event.data.protocol_id);
      state.protocols.set(event.data.protocol_id, {
        protocol_id: event.data.protocol_id,
        status: "draft",
        draft_revision: (prev?.draft_revision ?? 0) + 1,
        ...event.data,
        drafted_by: event.actor,
        drafted_at: event.ts,
      });
      break;
    }
    case "protocol_frozen": {
      const draft = state.protocols.get(event.data.protocol_id);
      state.protocols.set(event.data.protocol_id, {
        ...draft,
        ...event.data,
        status: "frozen",
        frozen_event_seq: event.seq,
        frozen_by: event.actor,
      });
      break;
    }
    case "trial_unblinded": {
      state.unblinded.set(event.data.protocol_id, {
        at: event.ts,
        by: event.actor,
        event_seq: event.seq,
      });
      break;
    }
    case "ingest_bundle_accepted": {
      state.idempotency.add(
        `bundle:${event.data.protocol_id}:${event.data.bundle_id}`,
      );
      state.bundles.set(event.data.bundle_id, {
        ...event.data,
        accepted_event_seq: event.seq,
      });
      for (const rec of event.data.accepted ?? []) {
        state.idempotency.add(`record:${rec.protocol_id}:${rec.record_id}`);
        if (rec.record_type === "observation") {
          state.records.set(rec.record_id, {
            ...rec,
            ingest_event_seq: event.seq,
            ingested_at: event.ts,
            original_value: rec.value,
            current_value: rec.value,
            corrections: [],
          });
        } else if (rec.record_type === "environment") {
          state.environments.set(rec.record_id, {
            ...rec,
            ingest_event_seq: event.seq,
            ingested_at: event.ts,
          });
        } else {
          state.deviations.set(rec.record_id, {
            ...rec,
            ingest_event_seq: event.seq,
            ingested_at: event.ts,
          });
        }
      }
      break;
    }
    case "observation_corrected": {
      const rec = state.records.get(event.data.record_id);
      if (rec) {
        rec.corrections.push({
          from: rec.current_value,
          to: event.data.new_value,
          reason: event.data.reason,
          by: event.actor,
          at: event.ts,
          seq: event.seq,
        });
        rec.current_value = event.data.new_value;
      }
      break;
    }
    case "quarantine_status_changed": {
      const batch = state.batches.get(event.data.batch_id);
      if (batch) {
        batch.quarantine_status = event.data.to;
        batch.quarantine_history.push({
          status: event.data.to,
          at: event.ts,
          seq: event.seq,
          reason: event.data.reason,
        });
      }
      break;
    }
    case "analysis_generated": {
      state.analyses.set(event.data.analysis_id, {
        ...event.data,
        event_seq: event.seq,
      });
      break;
    }
    case "recommendation_issued": {
      state.recommendations.set(event.data.recommendation_id, {
        ...event.data,
        event_seq: event.seq,
      });
      break;
    }
    case "analysis_reviewed": {
      state.reviews.push({ ...event.data, at: event.ts, event_seq: event.seq });
      break;
    }
    case "quarantine_impact_flagged": {
      state.impactFlags.push({ ...event.data, at: event.ts, event_seq: event.seq });
      break;
    }
    default:
      break;
  }
}

/** 某品种已登记苗批（投影辅助）。 */
export function batchesOfVariety(state, varietyCode) {
  return [...state.batches.values()].filter((b) => b.variety_code === varietyCode);
}

/** 试验的盲码 -> 地块 解析表；揭盲前仅内部使用，不对站点返回。 */
export function blindIndex(protocol) {
  const index = new Map();
  for (const plot of protocol?.layout ?? []) {
    index.set(plot.blind_code, plot);
  }
  return index;
}
