#!/usr/bin/env node

/**
 * Pi OAuth Helper Subprocess.
 * Bounded Node.js helper for built-in Pi OAuth discovery, login, and logout.
 *
 * Invariants:
 * - Credentials and tokens are persisted only in auth.json by Pi SDK.
 * - Raw secrets, tokens, and credentials are NEVER output or leaked.
 * - Imports SDK strictly from resolved Pi entrypoint package (no ambient fallback).
 * - Projects allowlisted event and prompt fields; never forwards raw provider objects.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

function writeJson(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function sanitizeText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/(?:bearer\s+|token[=:]\s*|secret[=:]\s*|access_token[=:]\s*|refresh_token[=:]\s*|api_key[=:]\s*)[\w\-._~+/]+=*/gi, (match) => {
      const prefix = match.split(/[:=\s]+/)[0];
      return match.includes('=') ? `${prefix}=[REDACTED]` : (match.includes(':') ? `${prefix}: [REDACTED]` : `${prefix} [REDACTED]`);
    })
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\b(?:ghp|gho|github_pat|sk|xox[baprs])_[A-Za-z0-9_]{16,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]')
    .slice(0, 500);
}

function sanitizeError(err) {
  if (!err) return 'Authentication operation failed';
  const raw = typeof err === 'string' ? err : err.message || String(err);
  return sanitizeText(raw);
}

function isSafeUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function sanitizeUrl(raw) {
  if (!isSafeUrl(raw)) return null;
  try {
    const parsed = new URL(raw.trim());
    const sensitiveKeys = new Set([
      'access_token',
      'refresh_token',
      'id_token',
      'client_secret',
      'secret',
      'token',
      'code_verifier',
      'api_key',
      'apikey',
      'auth_token',
      'user_token',
      'session_token',
      'password',
    ]);
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.has(lower)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    if (parsed.hash) {
      const hashContent = parsed.hash.replace(/^#/, '');
      const hasSensitiveFrag = hashContent.split('&').some((pair) => {
        const key = pair.split('=')[0].trim().toLowerCase();
        return sensitiveKeys.has(key);
      });
      if (hasSensitiveFrag) {
        parsed.hash = '';
      }
    }
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function projectSafeAuthEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || '');
  if (type === 'auth_url') {
    const safeUrl = sanitizeUrl(event.url);
    if (!safeUrl) return null;
    return {
      type: 'auth_url',
      url: safeUrl,
      instructions: typeof event.instructions === 'string' ? sanitizeText(event.instructions) : null,
    };
  }
  if (type === 'device_code') {
    const safeUri = sanitizeUrl(event.verificationUri);
    if (!safeUri) return null;
    return {
      type: 'device_code',
      userCode: typeof event.userCode === 'string' ? sanitizeText(event.userCode) : '',
      verificationUri: safeUri,
      intervalSeconds: typeof event.intervalSeconds === 'number' ? event.intervalSeconds : null,
      expiresInSeconds: typeof event.expiresInSeconds === 'number' ? event.expiresInSeconds : null,
    };
  }
  if (type === 'progress') {
    return {
      type: 'progress',
      message: typeof event.message === 'string' ? sanitizeText(event.message) : '',
    };
  }
  if (type === 'info') {
    const links = Array.isArray(event.links)
      ? event.links
          .filter((l) => l && typeof l === 'object' && isSafeUrl(l.url))
          .map((l) => ({
            url: sanitizeUrl(l.url),
            label: typeof l.label === 'string' ? sanitizeText(l.label) : null,
          }))
          .filter((l) => Boolean(l.url))
      : null;
    return {
      type: 'info',
      message: typeof event.message === 'string' ? sanitizeText(event.message) : '',
      links,
    };
  }
  return null;
}

function projectSafePrompt(prompt, promptId) {
  const allowedTypes = ['select', 'text', 'secret', 'manual_code'];
  const promptType = allowedTypes.includes(prompt.type) ? prompt.type : 'text';
  const options = Array.isArray(prompt.options)
    ? prompt.options
        .filter((o) => o && typeof o === 'object' && typeof o.id === 'string' && typeof o.label === 'string')
        .map((o) => ({
          id: String(o.id).slice(0, 64),
          label: sanitizeText(String(o.label)),
          description: typeof o.description === 'string' ? sanitizeText(o.description) : null,
        }))
    : null;

  return {
    promptId,
    promptType,
    message: typeof prompt.message === 'string' ? sanitizeText(prompt.message) : '',
    placeholder: typeof prompt.placeholder === 'string' ? sanitizeText(prompt.placeholder) : null,
    options,
  };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let action = null;
  let entrypoint = null;
  let home = null;
  let provider = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--action' && i + 1 < args.length) action = args[++i];
    else if (a === '--entrypoint' && i + 1 < args.length) entrypoint = args[++i];
    else if (a === '--home' && i + 1 < args.length) home = args[++i];
    else if (a === '--provider' && i + 1 < args.length) provider = args[++i];
    else if (!action && !a.startsWith('--')) action = a;
  }
  return { action, entrypoint, home, provider };
}

const PI_SDK_PACKAGE_NAMES = ['@earendil-works/pi-coding-agent', 'pi-coding-agent'];

async function loadPiSdkFromPackageDir(packageDir) {
  const pkgPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!PI_SDK_PACKAGE_NAMES.includes(pkg.name)) return null;
    const mainFile = pkg.main || 'dist/index.js';
    const candidate = path.resolve(packageDir, mainFile);
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.ModelRuntime) return mod;
    }
    const modDir = await import(pathToFileURL(packageDir).href);
    if (modDir.ModelRuntime) return modDir;
  } catch (_) {}
  return null;
}

/**
 * Resolves the SDK anchored at the entrypoint: either the entrypoint lives inside the
 * SDK package (direct Pi CLI), or the SDK is a dependency of the entrypoint's package
 * (Gentle Shell). Mirrors Node's node_modules lookup without relying on the SDK's
 * `exports` map, which does not expose `./package.json`.
 */
async function resolvePiSdk(entrypointPath) {
  if (!entrypointPath) {
    throw new Error('Pi entrypoint path is required');
  }
  let currentDir = path.dirname(path.resolve(entrypointPath));
  for (let i = 0; i < 6; i++) {
    const packageDirs = [
      currentDir,
      ...PI_SDK_PACKAGE_NAMES.map((name) => path.join(currentDir, 'node_modules', ...name.split('/'))),
    ];
    for (const packageDir of packageDirs) {
      const mod = await loadPiSdkFromPackageDir(packageDir);
      if (mod) return mod;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  throw new Error(`Unable to resolve Pi SDK from entrypoint: ${entrypointPath}`);
}

async function main() {
  const { action, entrypoint, home, provider } = parseCliArgs();
  if (!action) {
    writeJson({ status: 'error', error: 'Missing required action' });
    process.exit(1);
  }

  const effectiveHome = home
    ? path.resolve(home)
    : path.join(process.env.USERPROFILE || process.env.HOME || '.', '.pi', 'agent');

  try {
    if (!fs.existsSync(effectiveHome)) {
      fs.mkdirSync(effectiveHome, { recursive: true });
    }
  } catch (_) {}

  process.env.PI_CODING_AGENT_DIR = effectiveHome;
  const authPath = path.join(effectiveHome, 'auth.json');

  let ModelRuntime;
  try {
    const sdk = await resolvePiSdk(entrypoint);
    ModelRuntime = sdk.ModelRuntime;
  } catch (err) {
    writeJson({ status: 'error', error: sanitizeError(err) });
    process.exit(1);
  }

  if (action === 'list') {
    try {
      const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
      const providers = runtime.getProviders();
      const credentials = await runtime.listCredentials().catch(() => []);
      const credMap = new Map(credentials.map((c) => [c.providerId, c.type]));

      const results = [];
      for (const p of providers) {
        if (!p.auth?.oauth) continue;

        const hasStoredOAuth = credMap.get(p.id) === 'oauth';
        const check = await runtime.checkAuth(p.id).catch(() => undefined);
        const oauthReady = hasStoredOAuth && check?.type === 'oauth';
        const ambientApiKey = !hasStoredOAuth && check?.type === 'api_key';

        let status = 'unconfigured';
        let source = null;

        if (oauthReady) {
          status = 'authenticated';
          source = 'OAuth';
        } else if (hasStoredOAuth) {
          status = 'stored_unverified';
          source = 'OAuth';
        } else if (ambientApiKey) {
          status = 'ambient_api_key';
          source = check?.source || null;
        }

        results.push({
          id: p.id,
          name: p.name,
          oauthName: p.auth.oauth.name || p.name,
          loginLabel: p.auth.oauth.loginLabel || null,
          isSubscription: Boolean(p.auth.oauth.isSubscription),
          configured: hasStoredOAuth,
          hasStoredOAuth,
          oauthReady,
          ambientApiKey,
          source,
          status,
        });
      }

      writeJson({ status: 'ok', providers: results });
      process.exit(0);
    } catch (err) {
      writeJson({ status: 'error', error: sanitizeError(err) });
      process.exit(1);
    }
  }

  if (action === 'logout') {
    if (!provider) {
      writeJson({ status: 'error', error: 'Missing provider for logout' });
      process.exit(1);
    }
    try {
      const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
      await runtime.logout(provider);
      writeJson({ status: 'ok', providerId: provider });
      process.exit(0);
    } catch (err) {
      writeJson({ status: 'error', error: sanitizeError(err) });
      process.exit(1);
    }
  }

  if (action === 'login') {
    if (!provider) {
      writeJson({ type: 'error', error: 'Missing provider for login' });
      process.exit(1);
    }

    let runtime;
    try {
      runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    } catch (err) {
      writeJson({ type: 'error', error: sanitizeError(err) });
      process.exit(1);
    }

    const providerObj = runtime.getProvider(provider);
    if (!providerObj?.auth?.oauth) {
      writeJson({ type: 'error', error: `Provider '${provider}' does not support built-in OAuth` });
      process.exit(1);
    }

    const abortController = new AbortController();
    let promptCounter = 0;
    const pendingPrompts = new Map();

    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'cancel') {
          abortController.abort();
        } else if (msg.type === 'prompt_response' && msg.promptId) {
          const pending = pendingPrompts.get(msg.promptId);
          if (pending) pending.resolve(String(msg.value ?? ''));
        }
      } catch (_) {}
    });

    const interaction = {
      signal: abortController.signal,
      notify(event) {
        const safe = projectSafeAuthEvent(event);
        if (safe) {
          writeJson({ type: 'event', event: safe });
        }
      },
      prompt(prompt) {
        return new Promise((resolve, reject) => {
          if (abortController.signal.aborted) return reject(new Error('Login cancelled'));
          if (prompt.signal?.aborted) return reject(new Error('Prompt aborted'));

          promptCounter += 1;
          const promptId = `prompt-${promptCounter}`;

          const cleanUp = () => {
            pendingPrompts.delete(promptId);
            if (prompt.signal) prompt.signal.removeEventListener('abort', onPromptAbort);
            abortController.signal.removeEventListener('abort', onMainAbort);
          };

          const onPromptAbort = () => {
            cleanUp();
            writeJson({ type: 'prompt_cancelled', promptId });
            reject(new Error('Prompt aborted by provider'));
          };

          const onMainAbort = () => {
            cleanUp();
            reject(new Error('Login cancelled'));
          };

          if (prompt.signal) {
            prompt.signal.addEventListener('abort', onPromptAbort, { once: true });
          }
          abortController.signal.addEventListener('abort', onMainAbort, { once: true });

          pendingPrompts.set(promptId, {
            resolve: (val) => {
              cleanUp();
              resolve(val);
            },
            reject: (err) => {
              cleanUp();
              reject(err);
            },
          });

          writeJson({
            type: 'prompt',
            prompt: projectSafePrompt(prompt, promptId),
          });
        });
      },
    };

    try {
      await runtime.login(provider, 'oauth', interaction);
      rl.close();
      writeJson({ type: 'success', providerId: provider });
      process.exit(0);
    } catch (err) {
      rl.close();
      const isAborted =
        abortController.signal.aborted ||
        (err &&
          (err.name === 'AbortError' ||
            err.message?.includes('aborted') ||
            err.message?.includes('cancelled')));

      if (isAborted) {
        writeJson({ type: 'cancelled', providerId: provider });
        process.exit(0);
      } else {
        writeJson({ type: 'error', error: sanitizeError(err), providerId: provider });
        process.exit(1);
      }
    }
  }

  writeJson({ status: 'error', error: `Unknown action '${action}'` });
  process.exit(1);
}

main().catch((err) => {
  writeJson({ status: 'error', error: sanitizeError(err) });
  process.exit(1);
});
