import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEmitter } from 'node:events';
import { handleIpcCommand, addSseClient, removeSseClient } from './web-ipc-bridge';
import { createOAuthAccess } from './bridge/oauth-access';
import { oauthManager } from './bridge/oauth';
import { createWebAuth, type WebAuthConfig } from './bridge/web-auth';
import { createWebPush, resolveWebPushConfig, type WebPushConfig } from './bridge/web-push';
import { addPushNotificationHook } from './bridge/rpc';
import { isTerminalCommand, handleTerminalIpcCommand, validateTerminalAccess, getTerminalManager } from './terminal';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void | Promise<void>;
export interface MiddlewareApp {
  use(handler: Middleware): void;
  use(route: string, handler: Middleware): void;
}

export function installWebApi(app: MiddlewareApp, server: EventEmitter | null, authConfig: WebAuthConfig, pushConfig: WebPushConfig = resolveWebPushConfig()) {
  const webAuth = createWebAuth(authConfig);
  const oauthAccess = createOAuthAccess();
  const activeWebAuthSseClients = new Map<string, Set<ServerResponse>>();

  const isOwnerConnected = (owner: string): boolean => {
    if (!owner) return false;
    if (!webPush.isOwnerAuthorized(owner)) {
      activeWebAuthSseClients.delete(owner);
      return false;
    }
    const clients = activeWebAuthSseClients.get(owner);
    if (!clients || clients.size === 0) return false;
    for (const clientRes of [...clients]) {
      if (clientRes.writableEnded || clientRes.destroyed) {
        clients.delete(clientRes);
      }
    }
    if (clients.size === 0) {
      activeWebAuthSseClients.delete(owner);
      return false;
    }
    return true;
  };

  const webPush = createWebPush({
    webAuth,
    config: pushConfig,
    isOwnerConnected,
  });

  const unsubscribePush = addPushNotificationHook((event) => {
    void webPush.dispatchPushEvent(event);
  });

  server?.once("close", () => {
    unsubscribePush();
    activeWebAuthSseClients.clear();
    webPush.dispose();
    webAuth.dispose();
    void oauthManager.dispose();
    getTerminalManager().dispose();
  });

  // Web authentication middleware must be wired BEFORE all API routes
  app.use(webAuth.middleware);

  app.use("/api/push/config", (req, res) => {
    void webPush.handleConfig(req, res);
  });

  app.use("/api/push/subscriptions", (req, res) => {
    void webPush.handleSubscriptions(req, res);
  });

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

    const webAuthOwner = webPush.getRequestOwner(req);
    if (webAuthOwner) {
      let clients = activeWebAuthSseClients.get(webAuthOwner);
      if (!clients) {
        clients = new Set<ServerResponse>();
        activeWebAuthSseClients.set(webAuthOwner, clients);
      }
      clients.add(res);
    }

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      removeSseClient(res);
      if (webAuthOwner) {
        const clients = activeWebAuthSseClients.get(webAuthOwner);
        if (clients) {
          clients.delete(res);
          if (clients.size === 0) {
            activeWebAuthSseClients.delete(webAuthOwner);
          }
        }
      }
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  app.use("/api/engram-daemon", async (req, res) => {
    try {
      const queryOrPath = req.url || "";
      if (queryOrPath !== "" && !queryOrPath.startsWith("/") && !queryOrPath.startsWith("?")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request: invalid path" }));
        return;
      }

      let decoded = queryOrPath;
      try {
        decoded = decodeURIComponent(queryOrPath);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request: malformed URL encoding" }));
        return;
      }

      const FORBIDDEN_PATTERN = /[@\\]|\.\.|[\x00-\x1F\x7F]/;
      if (FORBIDDEN_PATTERN.test(queryOrPath) || FORBIDDEN_PATTERN.test(decoded)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request: forbidden characters in path" }));
        return;
      }

      const daemonUrl = `http://127.0.0.1:7437${queryOrPath}`;
      const parsedUrl = new URL(daemonUrl);
      if (parsedUrl.origin !== "http://127.0.0.1:7437") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request: invalid target" }));
        return;
      }

      const proxyRes = await fetch(daemonUrl, {
        method: req.method || "GET",
      });
      res.writeHead(proxyRes.status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      const text = await proxyRes.text();
      res.end(text);
    } catch (err: any) {
      res.writeHead(502, {
        "Content-Type": "application/json",
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
        if (isTerminalCommand(cmd)) {
          const terminalAccess = validateTerminalAccess(req, webAuth);
          if (!terminalAccess.ok) {
            res.statusCode = terminalAccess.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: terminalAccess.error }));
            return;
          }
          const abortController = new AbortController();
          const onResClose = () => {
            if (!res.writableEnded) {
              abortController.abort();
            }
          };
          res.once("close", onResClose);
          try {
            const result = await handleTerminalIpcCommand(cmd, args, {
              owner: terminalAccess.owner,
              signal: abortController.signal,
            });
            res.removeListener("close", onResClose);
            if (!res.writableEnded) {
              res.setHeader("Content-Type", "application/json");
              res.statusCode = 200;
              res.end(JSON.stringify({ result }));
            }
          } catch (err: any) {
            res.removeListener("close", onResClose);
            if (!res.writableEnded) {
              res.setHeader("Content-Type", "application/json");
              const msg = err?.message || 'Terminal command failed';
              const isNotFound = /not found/i.test(msg);
              const isDenied = /access denied/i.test(msg);
              res.statusCode = isNotFound ? 404 : (isDenied ? 403 : 400);
              res.end(JSON.stringify({ error: msg }));
            }
          }
          return;
        }

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
