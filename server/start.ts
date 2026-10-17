import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductionServer } from './production-server';
import { resolveWebAuthConfig } from './bridge/web-auth';
import { sessionPool } from './bridge/rpc';
import { oauthManager } from './bridge/oauth';
import { getTerminalManager } from './terminal';

const staticDir = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const server = createProductionServer({ staticDir: path.resolve(staticDir), authConfig: resolveWebAuthConfig() });
server.on('error', error => {
  console.error(`Pi Viewer startup failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Pi Viewer listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    for (const session of sessionPool.values()) session.kill();
    void getTerminalManager().dispose().finally(() => {
      server.closeAllConnections();
      server.close(() => {
        void oauthManager.dispose().finally(() => process.exit(0));
      });
    });
  });
}
