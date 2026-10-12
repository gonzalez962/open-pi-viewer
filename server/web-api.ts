import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEmitter } from 'node:events';
import { handleIpcCommand, addSseClient, removeSseClient } from './web-ipc-bridge';
import { createOAuthAccess } from './bridge/oauth-access';
import { oauthManager } from './bridge/oauth';
import { createWebAuth, type WebAuthConfig } from './bridge/web-auth';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void | Promise<void>;
export interface MiddlewareApp {
  use(handler: Middleware): void;
  use(route: string, handler: Middleware): void;
}

export function installWebApi(app: MiddlewareApp, server: EventEmitter | null, authConfig: WebAuthConfig) {
  const webAuth = createWebAuth(authConfig);
  const oauthAccess = createOAuthAccess();

  server?.once("close", () => {
    webAuth.dispose();
    void oauthManager.dispose();
  });

  // Web authentication middleware must be wired BEFORE all API routes
  app.use(webAuth.middleware);

  app.use("/api/oauth/authorize", (req, res) => {
    if (req.method !== "POST" || !req.headers["content-type"]?.startsWith("application/json")) {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "JSON POST required" }));
      return;
    }
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > 8192) {
        tooLarge = true;
        res.statusCode = 413;
        res.end(JSON.stringify({ error: "Authorization request too large" }));
      }
    });
    req.on("end", async () => {
      if (tooLarge) return;
      const result = await oauthAccess.authorize(req, res, body);
      res.statusCode = result.status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(result.ok ? { ok: true, expiresAt: result.expiresAt } : { error: result.error }));
    });
  });
  app.use("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("data: {}\n\n");
    const owner = oauthAccess.authenticate(req) ?? undefined;
    addSseClient(res, owner, () => Boolean(owner && oauthAccess.validateOwnerLease(owner)));
    req.on("close", () => {
      removeSseClient(res);
    });
  });

  app.use("/api/engram-daemon", async (req, res) => {
    try {
      const queryOrPath = req.url || "";
      const daemonUrl = `http://127.0.0.1:7437${queryOrPath}`;
      const proxyRes = await fetch(daemonUrl, {
        method: req.method || "GET",
      });
      res.writeHead(proxyRes.status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      const text = await proxyRes.text();
      res.end(text);
    } catch (err: any) {
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ error: "Engram daemon unreachable", details: String(err) }));
    }
  });

  app.use("/api/ipc", async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const { cmd, args } = JSON.parse(body || "{}");
        const access = oauthAccess.requireOAuthOwner(cmd, req);
        if (!access.ok) {
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify({ error: access.error }));
          return;
        }
        const result = await handleIpcCommand(cmd, args, { oauthOwner: access.owner });
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ result }));
      } catch (err: any) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ error: err?.message || String(err) }));
      }
    });
  });
}
