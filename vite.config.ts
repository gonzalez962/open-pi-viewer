import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { handleIpcCommand, addSseClient, removeSseClient } from "./server/web-ipc-bridge";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

function piWebIpcPlugin(): Plugin {
  return {
    name: "pi-web-ipc-bridge",
    configureServer(server) {
      server.middlewares.use("/api/events", (req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("data: {}\n\n");
        addSseClient(res);
        req.on("close", () => {
          removeSseClient(res);
        });
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
            const result = await handleIpcCommand(cmd, args);
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
export default defineConfig({
  plugins: [react(), piWebIpcPlugin()],
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
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom") || id.includes("node_modules/scheduler")) {
            return "vendor-react";
          }
          if (id.includes("node_modules/highlight.js") || id.includes("node_modules/lowlight")) {
            return "vendor-highlight";
          }
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
  },
});
