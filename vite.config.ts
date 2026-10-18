import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { installWebApi } from "./server/web-api";
import { resolveWebAuthConfig, type WebAuthConfig } from "./server/bridge/web-auth";
import { resolveWebPushConfig, type WebPushConfig } from "./server/bridge/web-push";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

function piWebIpcPlugin(authConfig: WebAuthConfig, pushConfig: WebPushConfig): Plugin {
  return {
    name: "pi-web-ipc-bridge",
    configureServer(server) {
      installWebApi(server.middlewares, server.httpServer, authConfig, pushConfig);
    },
  };
}
// https://vite.dev/config/
export default defineConfig(({ mode = "development" }) => {
  // Load non-VITE variables server-only in defineConfig callback
  const env = loadEnv(mode, process.cwd(), "");
  const mergedEnv = { ...env, ...process.env };
  const authConfig = resolveWebAuthConfig(mergedEnv);
  const pushConfig = resolveWebPushConfig(mergedEnv);

  return {
    plugins: [react(), piWebIpcPlugin(authConfig, pushConfig)],
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
        onwarn(warning, warn) {
          // Suppress xterm ESM interop warnings caused by CJS/ESM dual exports
          if (
            (warning.code === 'MISSING_EXPORT' || warning.code === 'NON_EXISTENT_EXPORT') &&
            /@xterm[\\/](xterm|addon-fit)/.test(warning.message || warning.loc?.file || '')
          ) {
            return;
          }
          warn(warning);
        },
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
    optimizeDeps: {
      exclude: ['node-pty'],
    },
    ssr: {
      external: ['node-pty'],
    },
    server: {
      host: "0.0.0.0",
      port: Number(mergedEnv.PORT || process.env.PORT) || 5173,
      strictPort: true,
    },
  };
});
