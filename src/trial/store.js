import * as domain from "./domain.js";
import { DomainError } from "./domain.js";

export function createTrialStore() {
  const trials = new Map();
  const batchEvents = [];
  let trialCounter = 0;

  function getTrial(trialId) {
    const trial = trials.get(trialId);
    if (!trial) throw new DomainError("unknown_trial", `未找到试验 ${trialId}`);
    return trial;
  }

  return {
    createTrial(input) {
      trialCounter += 1;
      const trial = domain.createTrial({
        ...input,
        trial_id: `TR-${String(trialCounter).padStart(4, "0")}`,
      });
      trials.set(trial.trial_id, trial);
      return trial;
    },
    getTrial,
    listTrials: () => [...trials.values()],
    freezeProtocol: (trialId, draft, options) => domain.freezeProtocol(getTrial(trialId), draft, options),
    recordSowing: (trialId, options) => domain.recordSowing(getTrial(trialId), options),
    unblind: (trialId, options) => domain.unblind(getTrial(trialId), options),
    ingestObservation: (trialId, record, options) => domain.ingestObservation(getTrial(trialId), record, options),
    correctObservation: (trialId, recordId, input) => domain.correctObservation(getTrial(trialId), recordId, input),
    reportDeviation: (trialId, input) => domain.reportDeviation(getTrial(trialId), input),
    detectMissedObservations: (trialId, asOf) => domain.detectMissedObservations(getTrial(trialId), asOf),
    runAnalysis: (trialId, input) => domain.runAnalysis(getTrial(trialId), input),
    getAnalysis(trialId, analysisId) {
      const analysis = getTrial(trialId).analyses.find((a) => a.analysis_id === analysisId);
      if (!analysis) throw new DomainError("unknown_analysis", `未找到分析结果 ${analysisId}`);
      return analysis;
    },
    verifyAnalysis: (trialId, analysisId) => domain.verifyAnalysis(getTrial(trialId), analysisId),
    createRecommendation: (trialId, input) => domain.createRecommendation(getTrial(trialId), input),
    traceRecommendation: (trialId, recommendationId) => domain.traceRecommendation(getTrial(trialId), recommendationId),
    applyQuarantineStatus(batchId, input) {
      const event = {
        batch_id: batchId,
        status: input.status,
        by: input.by ?? null,
        at: input.at ?? new Date().toISOString(),
      };
      batchEvents.push(event);
      const affected = domain.applyQuarantineStatus([...trials.values()], batchId, input);
      return { event, affected };
    },
    batchEvents: (batchId) => batchEvents.filter((e) => e.batch_id === batchId),
  };
}
