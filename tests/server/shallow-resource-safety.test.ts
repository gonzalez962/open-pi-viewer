import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getPiResourcesImpl,
  handleTogglePiResource,
} from '@server/bridge/models';
import {
  setPiAgentDirForTest,
} from '@server/bridge/resource-activation';

function createRepoTempDir(prefix: string): string {
  const baseDir = path.join(process.cwd(), 'tests', 'fixtures');
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

test('Blocker 1: global folder enable removes only exact folder mask and preserves unrelated substring matches', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-b1-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const extDir = path.join(fakeAgentDir, 'extensions', 'suite');
  const extOtherDir = path.join(fakeAgentDir, 'extensions', 'suite-extra');
  fs.mkdirSync(extDir, { recursive: true });
  fs.mkdirSync(extOtherDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'index.ts'), '// suite');
  fs.writeFileSync(path.join(extOtherDir, 'index.ts'), '// suite extra');

  const posixDir = extDir.replace(/\\/g, '/');
  const folderMask = `!${posixDir}/**`;

  // Global settings has both folder mask and an unrelated extension sharing prefix "suite"
  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({
      extensions: [
        folderMask,
        'extensions/suite-extra',
      ],
    }, null, 2)
  );

  // Enable extensions/suite globally
  await handleTogglePiResource({
    kind: 'extension',
    source: 'extensions/suite',
    enabled: true,
    scope: 'global',
  });

  const settingsAfter = JSON.parse(
    fs.readFileSync(path.join(fakeAgentDir, 'settings.json'), 'utf8')
  );

  // Exact mask is removed
  assert.ok(
    !settingsAfter.extensions.includes(folderMask),
    'Exact folder mask must be removed upon re-enabling'
  );
  // Unrelated extension sharing prefix is PRESERVED!
  assert.ok(
    settingsAfter.extensions.includes('extensions/suite-extra'),
    'Unrelated extension matching substring prefix must NOT be deleted'
  );
});

test('Blocker 2: builtin project toggle writes literal +/- builtin rather than filesystem path', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-b2-');
  setPiAgentDirForTest(fakeAgentDir);
  const projectDir = createRepoTempDir('proj-b2-');
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Global settings lists builtin:mcp
  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['builtin:mcp'] }, null, 2)
  );

  // Disable builtin:mcp in project scope
  await handleTogglePiResource({
    kind: 'extension',
    source: 'builtin:mcp',
    enabled: false,
    cwd: projectDir,
  });

  const projSettings = JSON.parse(
    fs.readFileSync(path.join(projectDir, '.pi', 'settings.json'), 'utf8')
  );

  assert.ok(
    projSettings.extensions.includes('-builtin:mcp'),
    `Project settings must contain literal -builtin:mcp, got: ${JSON.stringify(projSettings.extensions)}`
  );
  assert.ok(
    !projSettings.extensions.some((e: string) => e.includes(':\\') || e.includes(':/')),
    'Must NOT resolve builtin:mcp to an absolute filesystem path'
  );

  // Re-enable builtin:mcp in project scope
  await handleTogglePiResource({
    kind: 'extension',
    source: 'builtin:mcp',
    enabled: true,
    cwd: projectDir,
  });

  const projSettingsAfter = JSON.parse(
    fs.readFileSync(path.join(projectDir, '.pi', 'settings.json'), 'utf8')
  );

  assert.ok(
    !projSettingsAfter.extensions.includes('-builtin:mcp'),
    '-builtin:mcp must be removed upon re-enabling'
  );
  assert.ok(
    projSettingsAfter.extensions.includes('+builtin:mcp'),
    '+builtin:mcp must be written to force-include in project'
  );
});

test('Blocker 4: non-autoload global file disable retains plain source alongside minus', async (t) => {
  const fakeAgentDir = createRepoTempDir('pi-agent-b4-');
  setPiAgentDirForTest(fakeAgentDir);
  t.after(() => {
    setPiAgentDirForTest(null);
    fs.rmSync(fakeAgentDir, { recursive: true, force: true });
  });

  const toolFile = path.join(fakeAgentDir, 'standalone-tool.ts');
  fs.writeFileSync(toolFile, '// tool');

  // Declared in global settings (not in autoload directory)
  fs.writeFileSync(
    path.join(fakeAgentDir, 'settings.json'),
    JSON.stringify({ extensions: ['./standalone-tool.ts'] }, null, 2)
  );

  // Disable globally
  await handleTogglePiResource({
    kind: 'extension',
    source: './standalone-tool.ts',
    enabled: false,
    scope: 'global',
  });

  const settingsAfter = JSON.parse(
    fs.readFileSync(path.join(fakeAgentDir, 'settings.json'), 'utf8')
  );

  assert.ok(
    settingsAfter.extensions.includes('./standalone-tool.ts'),
    'Plain declaration must be retained so resource remains known'
  );
  assert.ok(
    settingsAfter.extensions.includes('-./standalone-tool.ts'),
    'Minus entry must be present to mark it disabled'
  );

  // Inventory query still lists the disabled resource
  const res = getPiResourcesImpl();
  const card = res.resources.find((r) => r.source === './standalone-tool.ts');
  assert.ok(card, 'Disabled file must remain visible in inventory');
  assert.strictEqual(card.enabled, false, 'Card must report enabled: false');

  // Re-enable globally
  await handleTogglePiResource({
    kind: 'extension',
    source: './standalone-tool.ts',
    enabled: true,
    scope: 'global',
  });

  const settingsReenabled = JSON.parse(
    fs.readFileSync(path.join(fakeAgentDir, 'settings.json'), 'utf8')
  );

  assert.ok(
    !settingsReenabled.extensions.includes('-./standalone-tool.ts'),
    'Minus entry must be removed upon re-enabling'
  );
  assert.ok(
    settingsReenabled.extensions.includes('./standalone-tool.ts'),
    'Plain declaration remains'
  );

  const resAfter = getPiResourcesImpl();
  const cardAfter = resAfter.resources.find((r) => r.source === './standalone-tool.ts');
  assert.ok(cardAfter);
  assert.strictEqual(cardAfter.enabled, true, 'Card must report enabled: true');
});
