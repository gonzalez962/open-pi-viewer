import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  handleIpcCommand,
  setPiAgentDirForTest,
} from '@server/web-ipc-bridge';
import { prepareProviderPayload } from '@features/providers/hooks/useProvidersData';
import type { ProviderFormData } from '@features/providers/types';

function loadSaveProviderCallback() {
  const filePath = path.resolve('src/features/providers/hooks/useProvidersData.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  const file = ts.createSourceFile('useProvidersData.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callbackNode: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'saveProvider') {
      if (node.initializer && ts.isCallExpression(node.initializer)) {
        callbackNode = node.initializer.arguments[0];
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(callbackNode, 'saveProvider callback must be defined in useProvidersData.ts');

  const compiled = ts.transpileModule(`const callback = ${callbackNode.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;

  let capturedPayload: any = null;
  let capturedCwd: any = null;

  const scope = {
    prepareProviderPayload,
    validateProviderConfig: () => ({ valid: true }),
    setIsSaving: () => {},
    providers: [],
    t: (k: string) => k,
    resolveActiveCwd: () => '/isolated/project',
    upsertCustomProviderPi: async (p: any, cwd: any) => {
      capturedPayload = p;
      capturedCwd = cwd;
      return { providers: { [p.id]: p } };
    },
    setFullConfig: () => {},
    setProviders: () => {},
    mapProvidersToArray: () => [],
    saveModelThinkingLevelsPi: async () => ({}),
    setModelThinkingLevels: () => {},
    setSuccessNotice: () => {},
    onRefreshModels: async () => {},
  };

  const run = new Function(...Object.keys(scope), `${compiled}\nreturn callback;`)(...Object.values(scope)) as (
    formData: ProviderFormData,
    isEditing: boolean
  ) => Promise<boolean>;

  return {
    run,
    getCapturedPayload: () => capturedPayload,
    getCapturedCwd: () => capturedCwd,
  };
}

test('Defect 1 — actual saveProvider callback sends explicit [] for empty pattern arrays across JSON IPC', async () => {
  const harness = loadSaveProviderCallback();
  const formData: ProviderFormData = {
    id: 'cpam',
    name: 'CPAM Provider',
    baseUrl: 'https://cpam.example.com/v1',
    api: 'openai',
    apiKey: '',
    models: [{ id: 'm1' }],
    includedModels: [],
    excludedModels: [],
  };

  await harness.run(formData, true);

  const captured = harness.getCapturedPayload();
  assert.ok(captured, 'upsertCustomProviderPi must have been called');

  // Verify across JSON IPC serialization
  const serialized = JSON.parse(JSON.stringify(captured));
  assert.deepEqual(serialized.includedModels, [], 'Empty includedModels must serialize as [] over JSON IPC');
  assert.deepEqual(serialized.excludedModels, [], 'Empty excludedModels must serialize as [] over JSON IPC');
});

test('Defect 1 — additive backend clears patterns when explicit [] is received, preserving omitted fields', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.workspace-pattern-test-'));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  setPiAgentDirForTest(agentDir);

  try {
    const modelsPath = path.join(agentDir, 'models.json');
    const initialConfig = {
      providers: {
        cpam: {
          baseUrl: 'https://cpam.example.com/v1',
          api: 'openai',
          includedModels: ['codex/gpt-6.1-*'],
          excludedModels: ['codex/old-*'],
          models: [{ id: 'm1' }],
        },
      },
    };
    fs.writeFileSync(modelsPath, JSON.stringify(initialConfig, null, 2), 'utf8');

    // 1. Updating with omitted pattern fields preserves existing patterns (additive semantics)
    const omittedPayload = {
      provider: {
        id: 'cpam',
        baseUrl: 'https://cpam.example.com/v1',
        api: 'openai',
      },
    };
    const res1: any = await handleIpcCommand('upsert_custom_provider', omittedPayload);
    assert.deepEqual(res1.providers.cpam.includedModels, ['codex/gpt-6.1-*'], 'Omitted includedModels must be preserved');
    assert.deepEqual(res1.providers.cpam.excludedModels, ['codex/old-*'], 'Omitted excludedModels must be preserved');

    // 2. Updating with explicit [] clears patterns without requiring null
    const clearPayload = {
      provider: {
        id: 'cpam',
        baseUrl: 'https://cpam.example.com/v1',
        api: 'openai',
        includedModels: [],
        excludedModels: [],
      },
    };
    const res2: any = await handleIpcCommand('upsert_custom_provider', clearPayload);
    assert.deepEqual(res2.providers.cpam.includedModels, [], 'Explicit [] must clear includedModels');
    assert.deepEqual(res2.providers.cpam.excludedModels, [], 'Explicit [] must clear excludedModels');
  } finally {
    setPiAgentDirForTest(null);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
