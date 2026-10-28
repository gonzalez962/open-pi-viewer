import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { handleIpcCommand } from '@server/web-ipc-bridge';

interface KanbanCard {
  id: string;
  title: string;
  description: string;
  columnId: 'pending' | 'in_progress' | 'done';
}

interface KanbanBoard {
  cards: KanbanCard[];
  columns?: Array<{ id: string; title: string }>;
}

/* ========================================================================= */
/* S1: Project-local board                                                   */
/* ========================================================================= */

test('server bridge S1.1: maintains separate boards per project and isolates cards across project switches', async () => {
  const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s1-1-a-'));
  const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s1-1-b-'));
  try {
    // 1. Initial read on projectA returns an empty board without creating disk files
    const initialA: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: projectA },
    });
    assert.ok(initialA, 'get_project_kanban must return a board object');
    assert.ok(Array.isArray(initialA.cards), 'board.cards must be an array');
    assert.strictEqual(initialA.cards.length, 0, 'New project board must start with 0 cards');
    assert.strictEqual(
      fs.existsSync(path.join(projectA, '.pi', 'kanban.json')),
      false,
      'Reading board must not initialize .pi/kanban.json on disk'
    );

    // 2. Save a card to projectA
    const cardA: KanbanCard = {
      id: 'card-a-1',
      title: 'Project A Card',
      description: 'First task for Project A',
      columnId: 'pending',
    };
    const saveResA: any = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: projectA,
        board: { cards: [cardA] },
      },
    });
    assert.ok(saveResA, 'save_project_kanban must return a result object');

    // 3. Switch to projectB: must see its own board, zero cards, no leak from projectA
    const initialB: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: projectB },
    });
    assert.ok(initialB, 'get_project_kanban must return a board object for project B');
    assert.ok(Array.isArray(initialB.cards), 'project B board.cards must be an array');
    assert.strictEqual(initialB.cards.length, 0, 'Project B must have 0 cards and not see Project A cards');
    assert.strictEqual(
      fs.existsSync(path.join(projectB, '.pi', 'kanban.json')),
      false,
      'Project B must not have created .pi/kanban.json'
    );

    // 4. Return to projectA: displays only projectA's saved cards
    const reloadA: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: projectA },
    });
    assert.ok(reloadA, 'get_project_kanban must return project A board');
    assert.strictEqual(reloadA.cards.length, 1, 'Project A must retain its 1 saved card');
    assert.strictEqual(reloadA.cards[0].id, 'card-a-1');
    assert.strictEqual(reloadA.cards[0].title, 'Project A Card');
    assert.strictEqual(reloadA.cards[0].columnId, 'pending');

    // 5. Save a distinct card in projectB
    const cardB: KanbanCard = {
      id: 'card-b-1',
      title: 'Project B Card',
      description: 'First task for Project B',
      columnId: 'in_progress',
    };
    await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: projectB,
        board: { cards: [cardB] },
      },
    });

    // 6. Verify full isolation: projectA has cardA, projectB has cardB
    const finalA: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: projectA },
    });
    const finalB: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: projectB },
    });

    assert.strictEqual(finalA.cards.length, 1);
    assert.strictEqual(finalA.cards[0].id, 'card-a-1');
    assert.strictEqual(finalB.cards.length, 1);
    assert.strictEqual(finalB.cards[0].id, 'card-b-1');
  } finally {
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  }
});

test('server bridge S1.2: saves board in .pi/kanban.json and updates .gitignore preserving existing ignore rules', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s1-2-'));
  try {
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

    // Seed existing .gitignore with pre-existing rules
    const existingGitignore = '# Existing project rules\nnode_modules/\n*.log\ndist/\n';
    fs.writeFileSync(path.join(repoDir, '.gitignore'), existingGitignore, 'utf8');
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'hello', 'utf8');
    execSync('git add .gitignore tracked.txt', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial commit"', { cwd: repoDir, stdio: 'ignore' });

    // Save the first board
    const card: KanbanCard = {
      id: 'card-git-1',
      title: 'Git ignore test',
      description: 'Ensure .pi/kanban.json is ignored',
      columnId: 'pending',
    };
    const saveRes: any = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: repoDir,
        board: { cards: [card] },
      },
    });
    assert.ok(saveRes, 'save_project_kanban must return a result object');

    // 1. Board file is saved to <project>/.pi/kanban.json
    const kanbanPath = path.join(repoDir, '.pi', 'kanban.json');
    assert.strictEqual(fs.existsSync(kanbanPath), true, '.pi/kanban.json must exist on disk');
    const onDisk = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    assert.ok(Array.isArray(onDisk.cards), 'Stored json must have cards array');
    assert.strictEqual(onDisk.cards[0].id, 'card-git-1');

    // 2. Existing ignore rules remain intact
    const updatedGitignore = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8');
    assert.ok(updatedGitignore.startsWith(existingGitignore), 'Must preserve existing ignore contents byte-for-byte');
    assert.ok(updatedGitignore.includes('node_modules/'), 'Must preserve existing node_modules/ rule');
    assert.ok(updatedGitignore.includes('*.log'), 'Must preserve existing *.log rule');
    assert.ok(updatedGitignore.includes('dist/'), 'Must preserve existing dist/ rule');

    // 3. Git status verifies .pi/kanban.json is ignored and untracked status does not show it
    const ignoredPath = execFileSync('git', ['check-ignore', '--', '.pi/kanban.json'], {
      cwd: repoDir, encoding: 'utf8',
    });
    assert.strictEqual(ignoredPath.trim(), '.pi/kanban.json');

    // 4. Saving again does not duplicate the ignore rule
    await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: repoDir,
        board: { cards: [card] },
      },
    });
    const secondGitignore = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8');
    const matches = secondGitignore.split(/\r?\n/).filter((line) => line === '/.pi/kanban.json');
    assert.strictEqual(matches.length, 1, 'Ignore entry must exist exactly once on repeated saves');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

/* ========================================================================= */
/* S2: Basic card operations                                                 */
/* ========================================================================= */

test('server bridge S2.1: creating a card with title and description places it in Pending and survives reload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s2-1-'));
  try {
    const card: KanbanCard = {
      id: 'card-2-1',
      title: 'Initialize Project',
      description: 'Setup build tools and linters',
      columnId: 'pending',
    };

    const saveRes: any = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [card] },
      },
    });
    assert.ok(saveRes, 'save_project_kanban must return result');

    // Reload from IPC dispatcher
    const reloaded: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: tempDir },
    });
    assert.ok(reloaded, 'get_project_kanban must return board');
    assert.strictEqual(reloaded.cards.length, 1);
    assert.strictEqual(reloaded.cards[0].id, 'card-2-1');
    assert.strictEqual(reloaded.cards[0].title, 'Initialize Project');
    assert.strictEqual(reloaded.cards[0].description, 'Setup build tools and linters');
    assert.strictEqual(reloaded.cards[0].columnId, 'pending');

    // Verify on disk persistence
    const fileContent = JSON.parse(fs.readFileSync(path.join(tempDir, '.pi', 'kanban.json'), 'utf8'));
    assert.strictEqual(fileContent.cards[0].title, 'Initialize Project');
    assert.strictEqual(fileContent.cards[0].columnId, 'pending');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge S2.2: editing card title and description updates values and survives reload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s2-2-'));
  try {
    // 1. Initial card
    const card: KanbanCard = {
      id: 'card-2-2',
      title: 'Original Title',
      description: 'Original Description',
      columnId: 'pending',
    };
    await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [card] },
      },
    });

    // 2. Edit title and description
    const updatedCard: KanbanCard = {
      id: 'card-2-2',
      title: 'Refined Title',
      description: 'Updated with detailed acceptance criteria',
      columnId: 'pending',
    };
    const updateRes: any = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [updatedCard] },
      },
    });
    assert.ok(updateRes, 'save_project_kanban must succeed on update');

    // 3. Reload and assert updated values
    const reloaded: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: tempDir },
    });
    assert.strictEqual(reloaded.cards.length, 1);
    assert.strictEqual(reloaded.cards[0].id, 'card-2-2');
    assert.strictEqual(reloaded.cards[0].title, 'Refined Title');
    assert.strictEqual(reloaded.cards[0].description, 'Updated with detailed acceptance criteria');
    assert.strictEqual(reloaded.cards[0].columnId, 'pending');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge S2.3: moving card through in_progress and done updates column and survives reload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s2-3-'));
  try {
    const card: KanbanCard = {
      id: 'card-2-3',
      title: 'Tracked Work',
      description: 'Moving between columns',
      columnId: 'pending',
    };
    const saveRes1 = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [card] },
      },
    });
    assert.ok(saveRes1, 'save_project_kanban must return result');

    // 1. Move to in_progress
    const inProgressCard: KanbanCard = { ...card, columnId: 'in_progress' };
    const saveRes2 = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [inProgressCard] },
      },
    });
    assert.ok(saveRes2, 'save_project_kanban must return result');

    const reloadProgress: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: tempDir },
    });
    assert.ok(reloadProgress, 'get_project_kanban must return board');
    assert.strictEqual(reloadProgress.cards[0].columnId, 'in_progress', 'Card must be in in_progress');

    // 2. Move to done
    const doneCard: KanbanCard = { ...card, columnId: 'done' };
    const saveRes3 = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [doneCard] },
      },
    });
    assert.ok(saveRes3, 'save_project_kanban must return result');

    const reloadDone: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: tempDir },
    });
    assert.ok(reloadDone, 'get_project_kanban must return board');
    assert.strictEqual(reloadDone.cards[0].columnId, 'done', 'Card must be in done');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge S2.4: deleting a card removes it and remains absent after reload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s2-4-'));
  try {
    const card1: KanbanCard = {
      id: 'card-keep',
      title: 'Keep me',
      description: 'Should remain',
      columnId: 'pending',
    };
    const card2: KanbanCard = {
      id: 'card-delete',
      title: 'Delete me',
      description: 'To be deleted',
      columnId: 'in_progress',
    };

    const saveRes1 = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [card1, card2] },
      },
    });
    assert.ok(saveRes1, 'save_project_kanban must return result');

    const initialLoad: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: tempDir },
    });
    assert.ok(initialLoad, 'get_project_kanban must return board');
    assert.strictEqual(initialLoad.cards.length, 2);

    // Delete card2 by saving board without it
    const saveRes2 = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [card1] },
      },
    });
    assert.ok(saveRes2, 'save_project_kanban must return result');

    const afterDelete: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: tempDir },
    });
    assert.ok(afterDelete, 'get_project_kanban must return board');
    assert.strictEqual(afterDelete.cards.length, 1);
    assert.strictEqual(afterDelete.cards[0].id, 'card-keep');
    assert.strictEqual(afterDelete.cards.some((c: KanbanCard) => c.id === 'card-delete'), false);

    // Delete remaining card
    const saveRes3 = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [] },
      },
    });
    assert.ok(saveRes3, 'save_project_kanban must return result');

    const afterAllDeleted: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: tempDir },
    });
    assert.ok(afterAllDeleted, 'get_project_kanban must return board');
    assert.strictEqual(afterAllDeleted.cards.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/* ========================================================================= */
/* S3: Functional verification and security boundary                         */
/* ========================================================================= */

test('server bridge S3.1: rejects invalid board input without mutating existing board data', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s3-1-invalid-'));
  try {
    // 1. Establish valid board state
    const validCard: KanbanCard = {
      id: 'valid-1',
      title: 'Valid Task',
      description: 'Must remain intact',
      columnId: 'pending',
    };
    const initialSave = await handleIpcCommand('save_project_kanban', {
      payload: {
        workingDirectory: tempDir,
        board: { cards: [validCard] },
      },
    });
    assert.ok(initialSave, 'save_project_kanban must save initial valid board');

    const savedContent = fs.readFileSync(path.join(tempDir, '.pi', 'kanban.json'), 'utf8');

    // 2. Reject null / non-object board
    await assert.rejects(
      async () => {
        await handleIpcCommand('save_project_kanban', {
          payload: { workingDirectory: tempDir, board: null },
        });
      },
      /invalid|board|required|schema/i,
      'Must reject null board'
    );
    assert.strictEqual(fs.readFileSync(path.join(tempDir, '.pi', 'kanban.json'), 'utf8'), savedContent);

    // 3. Reject non-array cards
    await assert.rejects(
      async () => {
        await handleIpcCommand('save_project_kanban', {
          payload: { workingDirectory: tempDir, board: { cards: 'not-an-array' } },
        });
      },
      /invalid|cards|array|schema/i,
      'Must reject non-array cards'
    );
    assert.strictEqual(fs.readFileSync(path.join(tempDir, '.pi', 'kanban.json'), 'utf8'), savedContent);

    // 4. Reject card missing title
    await assert.rejects(
      async () => {
        await handleIpcCommand('save_project_kanban', {
          payload: {
            workingDirectory: tempDir,
            board: { cards: [{ id: 'bad-card', description: 'missing title', columnId: 'pending' }] },
          },
        });
      },
      /invalid|title|required|schema/i,
      'Must reject card missing title'
    );
    assert.strictEqual(fs.readFileSync(path.join(tempDir, '.pi', 'kanban.json'), 'utf8'), savedContent);

    // 5. Reject card with invalid columnId
    await assert.rejects(
      async () => {
        await handleIpcCommand('save_project_kanban', {
          payload: {
            workingDirectory: tempDir,
            board: {
              cards: [{ id: 'bad-col', title: 'Bad Col', description: 'desc', columnId: 'invalid_column' }],
            },
          },
        });
      },
      /invalid|column|columnId/i,
      'Must reject card with unknown column'
    );
    assert.strictEqual(fs.readFileSync(path.join(tempDir, '.pi', 'kanban.json'), 'utf8'), savedContent);

    // 6. Existing board data on disk must remain strictly unchanged!
    const currentContent = fs.readFileSync(path.join(tempDir, '.pi', 'kanban.json'), 'utf8');
    assert.strictEqual(
      currentContent,
      savedContent,
      'Existing board data on disk must not be modified or corrupted by rejected saves'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server bridge S3.1: rejects missing, whitespace, or traversal workingDirectory', async () => {
  const dummyBoard: KanbanBoard = { cards: [] };

  // 1. Missing workingDirectory
  await assert.rejects(
    async () => {
      await handleIpcCommand('save_project_kanban', {
        payload: { board: dummyBoard },
      });
    },
    /workingDirectory|required|invalid/i,
    'Must reject missing workingDirectory'
  );

  // 2. Whitespace workingDirectory
  await assert.rejects(
    async () => {
      await handleIpcCommand('save_project_kanban', {
        payload: { workingDirectory: '   ', board: dummyBoard },
      });
    },
    /workingDirectory|required|invalid/i,
    'Must reject whitespace workingDirectory'
  );

  // 3. Traversal workingDirectory
  await assert.rejects(
    async () => {
      await handleIpcCommand('save_project_kanban', {
        payload: { workingDirectory: '../escaped-project', board: dummyBoard },
      });
    },
    /traversal|outside|denied|invalid/i,
    'Must reject directory traversal in workingDirectory'
  );
});

test('server bridge S3.1: rejects project-local symlinks escaping project and preserves external files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s3-1-symlink-'));
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s3-1-ext-'));
  try {
    const canaryFile = path.join(externalDir, 'canary.txt');
    fs.writeFileSync(canaryFile, 'precious external data', 'utf8');

    // Create a symlink/junction in tempDir/.pi that points to externalDir
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(externalDir, path.join(tempDir, '.pi'), symlinkType);

    {
      const card: KanbanCard = {
        id: 'c-symlink',
        title: 'Escaping Card',
        description: 'Should be rejected',
        columnId: 'pending',
      };

      await assert.rejects(
        async () => {
          await handleIpcCommand('save_project_kanban', {
            payload: {
              workingDirectory: tempDir,
              board: { cards: [card] },
            },
          });
        },
        /symlink|junction|outside|containment|escape/i,
        'Must reject saving when .pi is an escaping symlink'
      );

      // Verify external target file was not touched or overwritten
      assert.strictEqual(
        fs.readFileSync(canaryFile, 'utf8'),
        'precious external data',
        'External target file must not be modified'
      );
      assert.strictEqual(
        fs.existsSync(path.join(externalDir, 'kanban.json')),
        false,
        'kanban.json must not be created inside external symlink target'
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test('server bridge S3.1: reads do not initialize .pi directory or kanban.json on disk', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-s3-1-reads-'));
  try {
    const board: any = await handleIpcCommand('get_project_kanban', {
      payload: { workingDirectory: tempDir },
    });
    assert.ok(board, 'get_project_kanban must return a board');
    assert.strictEqual(board.cards.length, 0);

    // Invariant: reads MUST NOT initialize files on disk
    assert.strictEqual(
      fs.existsSync(path.join(tempDir, '.pi')),
      false,
      '.pi folder must not be created by read operations'
    );
    assert.strictEqual(
      fs.existsSync(path.join(tempDir, '.pi', 'kanban.json')),
      false,
      '.pi/kanban.json must not be created by read operations'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

 test('server bridge S3.1: malformed stored data is reported and never overwritten', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-corrupt-'));
  try {
    fs.mkdirSync(path.join(project, '.pi'));
    const file = path.join(project, '.pi', 'kanban.json');
    const corrupt = '{not valid JSON';
    fs.writeFileSync(file, corrupt);
    await assert.rejects(handleIpcCommand('get_project_kanban', { payload: { workingDirectory: project } }), /invalid|JSON|corrupt/i);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), corrupt);
    await assert.rejects(handleIpcCommand('save_project_kanban', { payload: { workingDirectory: project, board: { cards: [] } } }), /invalid|JSON|corrupt/i);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), corrupt);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('server bridge S1.2: repeated saves preserve a non-Git project ignore file byte-for-byte', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kanban-ignore-'));
  try {
    const ignore = path.join(project, '.gitignore');
    const eol = String.fromCharCode(13, 10);
    const original = '# Keep existing rules' + eol + 'node_modules/';
    fs.writeFileSync(ignore, original);
    const payload = { workingDirectory: project, board: { cards: [] } };
    await handleIpcCommand('save_project_kanban', { payload });
    const first = fs.readFileSync(ignore, 'utf8');
    assert.ok(first.startsWith(original + eol));
    assert.equal(first.split(eol).filter((line) => line === '/.pi/kanban.json').length, 1);
    await handleIpcCommand('save_project_kanban', { payload });
    assert.equal(fs.readFileSync(ignore, 'utf8'), first);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
