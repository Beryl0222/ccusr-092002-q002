import http from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { DomainError } from "./util.js";

export const serviceId = "seedling-rights";
export const serviceName = "花卉种苗多点品种试验服务";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) {
        reject(new DomainError("请求体过大", "PAYLOAD_TOO_LARGE", 413));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new DomainError("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/**
 * 路由表。角色通过请求头传递：
 *   X-Role: lead | site | statistician | reviewer
 *   X-Actor: 操作者标识    X-Site: 站点编码（site 角色必填）
 */
export function createServer(app) {
  if (!app) throw new Error("createServer 需要 createApp() 返回的应用实例");
  const { trial, ingest, analysis, contextFrom, changeQuarantine, store } = app;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;
      const ctx = contextFrom(request.headers);
      const body = request.method === "POST" ? await readBody(request) : {};

      // 基础
      if (request.method === "GET" && path === "/health") {
        return send(response, 200, healthPayload());
      }
      if (request.method === "GET" && path === "/audit/chain") {
        return send(response, 200, {
          service: serviceId,
          ...store.verifyChain(),
          head: store.headHash(),
          events: store.events.length,
        });
      }
      if (request.method === "GET" && path === "/events") {
        // 事件流含盲码对应关系，仅负责人/评审可读审计。
        if (!["lead", "reviewer"].includes(ctx.role)) {
          throw new DomainError("仅负责人/评审可读取事件流", "FORBIDDEN", 403);
        }
        const head = url.searchParams.get("head");
        return send(response, 200, { events: store.replay(head || undefined) });
      }

      // 登记与方案
      if (request.method === "POST" && path === "/admin/varieties") {
        return send(response, 201, eventView(trial.registerVariety(ctx, body)));
      }
      if (request.method === "POST" && path === "/admin/batches") {
        return send(response, 201, eventView(trial.registerBatch(ctx, body)));
      }
      if (request.method === "POST" && path === "/admin/sites") {
        return send(response, 201, eventView(trial.registerSite(ctx, body)));
      }
      if (request.method === "POST" && path === "/protocols") {
        return send(response, 201, eventView(trial.draftProtocol(ctx, body)));
      }

      let match;
      match = path.match(/^\/protocols\/([^/]+)\/freeze$/);
      if (request.method === "POST" && match) {
        return send(response, 201, eventView(trial.freezeProtocol(ctx, match[1])));
      }
      match = path.match(/^\/protocols\/([^/]+)\/unblind$/);
      if (request.method === "POST" && match) {
        return send(response, 201, eventView(trial.unblind(ctx, match[1])));
      }
      match = path.match(/^\/protocols\/([^/]+)\/sites\/([^/]+)$/);
      if (request.method === "GET" && match) {
        return send(response, 200, trial.siteView(match[1], match[2]));
      }
      match = path.match(/^\/protocols\/([^/]+)\/results$/);
      if (request.method === "GET" && match) {
        if (!["statistician", "reviewer", "lead"].includes(ctx.role)) {
          throw new DomainError("仅统计/评审/负责人可查看比较结果", "FORBIDDEN", 403);
        }
        const head = url.searchParams.get("head") || undefined;
        const stateAtHead = analysis.state(head);
        const protocol = stateAtHead.protocols.get(match[1]);
        if (protocol && !stateAtHead.unblinded.has(match[1])) {
          throw new DomainError("该快照处于盲态，比较结果不可读", "BLINDED", 403);
        }
        return send(response, 200, analysis.compute(match[1], head));
      }
      match = path.match(/^\/protocols\/([^/]+)\/analyses$/);
      if (request.method === "POST" && match) {
        return send(response, 201, analysis.generateAnalysis(ctx, match[1]));
      }

      // 汇入与更正
      if (request.method === "POST" && path === "/ingest/bundles") {
        return send(response, 202, ingest.ingestBundle(ctx, body));
      }
      if (request.method === "POST" && path === "/records/correct") {
        return send(response, 201, eventView(ingest.correctObservation(ctx, body)));
      }
      if (request.method === "POST" && path === "/quarantine/changes") {
        return send(response, 201, changeQuarantine(ctx, body));
      }

      // 分析、复核、推荐
      match = path.match(/^\/analyses\/([^/]+)\/review$/);
      if (request.method === "POST" && match) {
        return send(response, 201, analysis.reviewAnalysis(ctx, match[1]));
      }
      if (request.method === "POST" && path === "/recommendations") {
        return send(response, 201, analysis.issueRecommendation(ctx, body));
      }
      match = path.match(/^\/recommendations\/([^/]+)\/trace$/);
      if (request.method === "GET" && match) {
        return send(response, 200, analysis.traceRecommendation(ctx, match[1]));
      }

      send(response, 404, { error: "未找到资源" });
    } catch (error) {
      if (error instanceof DomainError) {
        return send(response, error.status, { error: error.message, code: error.code });
      }
      send(response, 500, { error: "服务内部错误", detail: String(error?.message ?? error) });
    }
  });

  return server;
}

function eventView(event) {
  return { event_seq: event.seq, type: event.type, hash: event.hash, data: event.data };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    const file = process.env.EVENT_LOG || null;
    const app = await createApp(file ? { file } : {});
    const server = createServer(app);
    server.listen(port, "0.0.0.0", () => {
      console.log(`${serviceName} 监听 ${port}`);
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, async () => {
        await app.drain();
        server.close(() => process.exit(0));
      });
    }
  }
}
