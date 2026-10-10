import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { handleIpcCommand, addSseClient, removeSseClient } from "./server/web-ipc-bridge";
import { createOAuthAccess } from "./server/bridge/oauth-access";
import { oauthManager } from "./server/bridge/oauth";
import { createWebAuth, resolveWebAuthConfig, type WebAuthConfig } from "./server/bridge/web-auth";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

function piWebIpcPlugin(authConfig: WebAuthConfig): Plugin {
  return {
    name: "pi-web-ipc-bridge",
    configureServer(server) {
      const webAuth = createWebAuth(authConfig);
      const oauthAccess = createOAuthAccess();

      server.httpServer?.once("close", () => {
        webAuth.dispose();
        void oauthManager.dispose();
      });

      // Web authentication middleware must be wired BEFORE all API routes
      server.middlewares.use(webAuth.middleware);

      server.middlewares.use("/api/oauth/authorize", (req, res) => {
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
      server.middlewares.use("/api/events", (req, res) => {
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

      server.middlewares.use("/api/engram-daemon", async (req, res) => {
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

      server.middlewares.use("/api/ipc", async (req, res) => {
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
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode = "development" }) => {
  // Load non-VITE variables server-only in defineConfig callback
  const env = loadEnv(mode, process.cwd(), "");
  const mergedEnv = { ...env, ...process.env };
  const authConfig = resolveWebAuthConfig(mergedEnv);

  return {
    plugins: [react(), piWebIpcPlugin(authConfig)],
    clearScreen: false,
    resolve: {
      alias: {
        "@core": path.join(srcDir, "core"),
        "@shared": path.join(srcDir, "shared"),
        "@infra": path.join(srcDir, "infra"),
        "@features": path.join(srcDir, "features"),
        "@app": path.join(srcDir, "app"),
      },
    },
    build: {
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
              return "vendor-react";
            }
            if (/[\\/]node_modules[\\/](highlight\.js|lowlight)[\\/]/.test(id)) {
              return "vendor-highlight";
            }
          },
        },
      },
    },
    server: {
      host: "0.0.0.0",
      port: Number(mergedEnv.PORT || process.env.PORT) || 5173,
      strictPort: true,
    },
  };
});
