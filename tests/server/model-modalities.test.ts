import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSupportedAttachmentCategories } from '@core/prompt-controls-utils';

test('web model catalog preserves declared modalities and legacy input capabilities', () => {
  const home = fs.mkdtempSync(path.join(process.cwd(), '.model-modalities-test-'));
  try {
    const agentDir = path.join(home, '.pi', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const modalities = ['text', 'image', 'audio', 'video', 'file'];
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        fixture: {
          models: [
            { id: 'modalities-only', input_modalities: modalities },
            { id: 'both-fields', input: ['text'], input_modalities: modalities },
            { id: 'legacy-input', input: ['text', 'image'] },
            { id: 'text-only', input: ['text'] },
            { id: 'unspecified' },
          ],
        },
      },
    }));
    // Exercise the catalog in an isolated home without touching real Pi configuration.
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      "import { handleGetAvailableModels } from './server/bridge/models.ts'; console.log(JSON.stringify(handleGetAvailableModels()));",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const models = JSON.parse(result.stdout);
    const byId = (id: string) => models.find((model: { id: string }) => model.id === id);

    for (const id of ['modalities-only', 'both-fields']) {
      assert.deepEqual(byId(id).input_modalities, modalities);
      assert.deepEqual(getSupportedAttachmentCategories(byId(id)), ['image', 'video', 'audio', 'code', 'all']);
    }
    assert.deepEqual(byId('both-fields').input, ['text']);
    assert.deepEqual(byId('modalities-only').input, modalities);
    assert.deepEqual(byId('legacy-input').input_modalities, ['text', 'image']);
    assert.deepEqual(getSupportedAttachmentCategories(byId('legacy-input')), ['image', 'code']);
    assert.deepEqual(byId('text-only').input_modalities, ['text']);
    assert.deepEqual(getSupportedAttachmentCategories(byId('text-only')), ['code']);
    assert.deepEqual(byId('unspecified').input_modalities, ['text', 'image']);
    for (const id of ['gpt-5', 'gpt-5.5']) {
      assert.deepEqual(byId(id).input_modalities, ['text', 'image']);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
