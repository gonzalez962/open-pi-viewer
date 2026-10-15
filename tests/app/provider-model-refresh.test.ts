import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Execute the actual App callback without mounting unrelated application services.
function loadProviderRefresh(overrides: Record<string, unknown> = {}) {
  const source = fs.readFileSync(new URL('../../src/app/App.tsx', import.meta.url), 'utf8');
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  let modelBindings: ts.BindingName | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      if (ts.isIdentifier(node.name) && node.name.text === 'handleProviderModelsChanged') {
        callback = node.initializer.arguments[0];
      }
      if (node.initializer.expression.getText(file) === 'useModels') modelBindings = node.name;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(callback, 'App must define its provider refresh callback');
  const calls: string[] = [];
  const inFlight = { current: false };
  const pending = { current: false };
  const scope = {
    state: { connectionStatus: 'connected' },
    isBusy: false,
    providerRefreshInFlight: inFlight,
    providerRefreshPending: pending,
    config: { workingDirectory: '/project' },
    disconnectPi: async () => { calls.push('disconnect'); },
    startConnection: async () => { calls.push('reconnect'); },
    handleRefreshModels: async () => { calls.push('refresh'); },
    ...overrides,
  };
  const compiled = ts.transpileModule(`const callback = ${callback.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const run = new Function(...Object.keys(scope), `${compiled}\nreturn callback;`)(...Object.values(scope)) as () => Promise<void>;
  return { run, calls, inFlight, pending, modelBindings: modelBindings?.getText(file) || '' };
}

test('provider changes explicitly refresh models after reconnecting an unchanged session', async () => {
  const app = loadProviderRefresh();
  await app.run();
  assert.deepEqual(app.calls, ['disconnect', 'reconnect', 'refresh']);
  assert.match(app.modelBindings, /\bhandleRefreshModels\b/, 'refresh callback must come from useModels');
  assert.equal(app.inFlight.current, false);
  assert.equal(app.pending.current, false);
});

test('provider refresh still defers while busy and skips disconnected sessions', async () => {
  const busy = loadProviderRefresh({ isBusy: true });
  await busy.run();
  assert.deepEqual(busy.calls, []);
  assert.equal(busy.pending.current, true);
  const disconnected = loadProviderRefresh({ state: { connectionStatus: 'disconnected' } });
  await disconnected.run();
  assert.deepEqual(disconnected.calls, []);
  assert.equal(disconnected.pending.current, false);
});
