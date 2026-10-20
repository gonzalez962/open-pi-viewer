import fs from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { installWebApi, type Middleware, type MiddlewareApp } from './web-api';
import type { WebAuthConfig } from './bridge/web-auth';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webm': 'video/webm',
};

function createMiddlewareApp() {
  const handlers: Array<{ route: string; handler: Middleware }> = [];
  const app: MiddlewareApp = {
    use(routeOrHandler: string | Middleware, handler?: Middleware) {
      handlers.push(typeof routeOrHandler === 'string'
        ? { route: routeOrHandler, handler: handler! }
        : { route: '', handler: routeOrHandler });
    },
  };
  const dispatch = (req: IncomingMessage, res: ServerResponse, fallback: () => void) => {
    (req as IncomingMessage & { originalUrl?: string }).originalUrl ||= req.url || '/';
    let index = 0;
    const next = (error?: unknown) => {
      if (error) {
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal server error');
        return;
      }
      if (res.writableEnded) return;
      const item = handlers[index++];
      if (!item) { fallback(); return; }
      const url = req.url || '/';
      const pathname = url.split('?')[0];
      if (item.route && pathname !== item.route && !pathname.startsWith(`${item.route}/`)) {
        next(); return;
      }
      // Match Connect's mounted middleware URL semantics used by the dev bridge.
      if (item.route) req.url = url.slice(item.route.length) || '/';
      let continued = false;
      const advance = (err?: unknown) => {
        if (continued) return;
        continued = true;
        req.url = url;
        next(err);
      };
      try {
        const result = item.handler(req, res, advance);
        if (result) void result.catch(advance);
      } catch (err) { advance(err); }
    };
    next();
  };
  return { app, dispatch };
}

export function createProductionServer(options: { staticDir: string; authConfig: WebAuthConfig }) {
  const root = path.resolve(options.staticDir);
  const indexFile = path.join(root, 'index.html');
  if (!fs.existsSync(indexFile)) throw new Error('Build not found. Run npm run build before npm run start.');
  const { app, dispatch } = createMiddlewareApp();
  const server = createServer((req, res) => dispatch(req, res, () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    let pathname: string;
    try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { res.writeHead(400); res.end(); return; }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      res.writeHead(404); res.end(); return;
    }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
      res.writeHead(403); res.end(); return;
    }
    let file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403); res.end(); return;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (path.extname(pathname)) { res.writeHead(404); res.end(); return; }
      file = indexFile;
    }
    // Never serve a symlink pointing outside the public build directory.
    const real = fs.realpathSync(file);
    const realRoot = fs.realpathSync(root);
    if (!real.startsWith(realRoot + path.sep)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': contentTypes[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': file === indexFile || pathname === '/push-sw.js' || pathname === '/manifest.json' || pathname === '/manifest.webmanifest' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }));
  installWebApi(app, server, options.authConfig);
  return server;
}
