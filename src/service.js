import http from "node:http";
import { pathToFileURL } from "node:url";

import { DomainError } from "./trial/domain.js";
import { createTrialStore } from "./trial/store.js";

export const serviceId = "seedling-rights";
export const serviceName = "花卉种苗权属防疫链";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

const ERROR_STATUS = {
  forbidden: 403,
  idempotency_conflict: 409,
};

function statusFor(error) {
  if (error.code?.startsWith("unknown_")) return 404;
  return ERROR_STATUS[error.code] ?? 400;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createServer(store = createTrialStore()) {
  return http.createServer(async (request, response) => {
    try {
      await handleRequest(store, request, response);
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, statusFor(error), { error: error.message, code: error.code });
      } else if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: "请求体不是合法 JSON" });
      } else {
        sendJson(response, 500, { error: "服务内部错误" });
      }
    }
  });
}

async function handleRequest(store, request, response) {
  const url = new URL(request.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method;
  const body = method === "POST" ? await readJson(request) : {};

  if (method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, healthPayload());
  }

  if (parts[0] === "trials") {
    if (parts.length === 1) {
      if (method === "POST") return sendJson(response, 201, store.createTrial(body));
      if (method === "GET") return sendJson(response, 200, store.listTrials());
    }
    const trialId = parts[1];
    if (parts.length === 2 && method === "GET") {
      return sendJson(response, 200, store.getTrial(trialId));
    }
    if (parts[2] === "protocol" && parts[3] === "freeze" && method === "POST") {
      const { by, at, amendment_reason, ...draft } = body;
      return sendJson(response, 200, store.freezeProtocol(trialId, draft, { by, at, amendment_reason }));
    }
    if (parts[2] === "sowing" && method === "POST" && parts.length === 3) {
      return sendJson(response, 200, store.recordSowing(trialId, body));
    }
    if (parts[2] === "unblind" && method === "POST" && parts.length === 3) {
      return sendJson(response, 200, store.unblind(trialId, body));
    }
    if (parts[2] === "observations") {
      if (parts.length === 3 && method === "POST") {
        const { at, ...record } = body;
        const result = store.ingestObservation(trialId, record, { at });
        return sendJson(response, result.deduplicated ? 200 : 201, result);
      }
      if (parts.length === 3 && method === "GET") {
        return sendJson(response, 200, Object.values(store.getTrial(trialId).observations));
      }
      if (parts.length === 5 && parts[4] === "corrections" && method === "POST") {
        return sendJson(response, 200, store.correctObservation(trialId, parts[3], body));
      }
    }
    if (parts[2] === "deviations") {
      if (parts.length === 3 && method === "POST") {
        return sendJson(response, 201, store.reportDeviation(trialId, body));
      }
      if (parts.length === 3 && method === "GET") {
        return sendJson(response, 200, store.getTrial(trialId).deviations);
      }
      if (parts[3] === "detect" && method === "POST") {
        return sendJson(response, 200, store.detectMissedObservations(trialId, body.as_of ?? new Date().toISOString()));
      }
    }
    if (parts[2] === "analyses") {
      if (parts.length === 3 && method === "POST") {
        const result = store.runAnalysis(trialId, body);
        return sendJson(response, result.reused ? 200 : 201, result);
      }
      if (parts.length === 4 && method === "GET") {
        return sendJson(response, 200, store.getAnalysis(trialId, parts[3]));
      }
      if (parts.length === 5 && parts[4] === "verify" && method === "POST") {
        return sendJson(response, 200, store.verifyAnalysis(trialId, parts[3]));
      }
    }
    if (parts[2] === "recommendations") {
      if (parts.length === 3 && method === "POST") {
        return sendJson(response, 201, store.createRecommendation(trialId, body));
      }
      if (parts.length === 5 && parts[4] === "trace" && method === "GET") {
        return sendJson(response, 200, store.traceRecommendation(trialId, parts[3]));
      }
    }
  }

  if (parts[0] === "batches" && parts.length === 3 && parts[2] === "quarantine" && method === "POST") {
    return sendJson(response, 200, store.applyQuarantineStatus(parts[1], body));
  }
  if (parts[0] === "batches" && parts.length === 3 && parts[2] === "events" && method === "GET") {
    return sendJson(response, 200, store.batchEvents(parts[1]));
  }

  sendJson(response, 404, { error: "未找到资源" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    createServer().listen(port, "0.0.0.0");
  }
}
