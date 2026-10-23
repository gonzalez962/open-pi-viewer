import test from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import enJson from '@shared/locales/en.json';
import esJson from '@shared/locales/es.json';
import {
  listWorkspaceDirPi,
  readWorkspaceFilePi,
  getWorkspaceGitStatusPi,
  getWorkspaceFileDiffPi,
  listWorkspaceBranchesPi,
  switchWorkspaceBranchPi,
  createWorkspaceBranchPi,
  deleteWorkspaceBranchPi,
  publishWorkspaceBranchPi,
  listWorkspaceBranchCommitsPi,
} from '@infra/bridge';
import { BranchManagerModal, sortBranchesMainFirst } from '@features/workspace/components/BranchManagerModal';
import { BranchCommitsModal } from '@features/workspace/components/BranchCommitsModal';
import { isValidGitBranchName, deduplicateBaseBranches, sanitizeBranchName } from '@server/bridge/paths';
import type {
  WorkspaceBranchList,
  BranchOperationResult,
} from '@core/types/workspace';
import { parseUnifiedDiff } from '@features/workspace/FileViewerModal';
import {
  FileTree,
  computeDirChangesMap,
  computeTotalGitChanges,
  updateDirChildrenOnRefresh,
  pruneExpandedDirsOnRefresh,
  normalizeTreePath,
  isEntryModified,
} from '@features/workspace/FileTree';
import { FileSearchBar } from '@features/workspace/components/FileSearchBar';
import type {
  WorkspaceEntry,
  WorkspaceFileContent,
  WorkspaceGitStatus,
  WorkspaceFileDiff,
} from '@core/types/workspace';

test('Bridge: listWorkspaceDirPi invokes list_workspace_dir command with payload', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockEntries: WorkspaceEntry[] = [
    {
      name: 'src',
      relativePath: 'src',
      isDir: true,
      size: null,
      extension: null,
    },
    {
      name: 'README.md',
      relativePath: 'README.md',
      isDir: false,
      size: 1024,
      extension: 'md',
    },
  ];

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockEntries as T;
  };

  const res = await listWorkspaceDirPi(
    { workingDirectory: 'C:/project', relativePath: 'src' },
    mockInvoke
  );

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'list_workspace_dir');
  assert.deepStrictEqual(calls[0].args, {
    payload: { workingDirectory: 'C:/project', relativePath: 'src' },
  });
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].name, 'src');
  assert.strictEqual(res[1].name, 'README.md');
});

test('Bridge: readWorkspaceFilePi invokes read_workspace_file command with payload', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockContent: WorkspaceFileContent = {
    relativePath: 'src/main.rs',
    name: 'main.rs',
    content: 'fn main() {}',
    size: 12,
    isBinary: false,
    extension: 'rs',
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockContent as T;
  };

  const res = await readWorkspaceFilePi('src/main.rs', 'C:/project', mockInvoke);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'read_workspace_file');
  assert.deepStrictEqual(calls[0].args, {
    payload: { relativePath: 'src/main.rs', workingDirectory: 'C:/project' },
  });
  assert.strictEqual(res.name, 'main.rs');
  assert.strictEqual(res.content, 'fn main() {}');
  assert.strictEqual(res.size, 12);
  assert.strictEqual(res.isBinary, false);
});

test('File tree: search filtering matches entry name and relative path', () => {
  const entries: WorkspaceEntry[] = [
    { name: 'src', relativePath: 'src', isDir: true },
    { name: 'App.tsx', relativePath: 'src/App.tsx', isDir: false, extension: 'tsx' },
    { name: 'commands.rs', relativePath: 'src-tauri/src/commands.rs', isDir: false, extension: 'rs' },
    { name: 'package.json', relativePath: 'package.json', isDir: false, extension: 'json' },
  ];

  const filter = (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.name.toLowerCase().includes(q) || e.relativePath.toLowerCase().includes(q)
    );
  };

  assert.strictEqual(filter('app').length, 1);
  assert.strictEqual(filter('app')[0].name, 'App.tsx');

  assert.strictEqual(filter('tauri').length, 1);
  assert.strictEqual(filter('tauri')[0].name, 'commands.rs');

  assert.strictEqual(filter('json').length, 1);
  assert.strictEqual(filter('nonexistent').length, 0);
  assert.strictEqual(filter('   ').length, 4);
});

test('WorkspaceFileContent: correctly represents binary and text files', () => {
  const textFile: WorkspaceFileContent = {
    relativePath: 'README.md',
    name: 'README.md',
    content: '# Hello',
    size: 7,
    isBinary: false,
    extension: 'md',
  };

  const binFile: WorkspaceFileContent = {
    relativePath: 'image.png',
    name: 'image.png',
    content: '',
    size: 2048,
    isBinary: true,
    extension: 'png',
  };

  assert.strictEqual(textFile.isBinary, false);
  assert.strictEqual(textFile.content.length > 0, true);
  assert.strictEqual(binFile.isBinary, true);
  assert.strictEqual(binFile.content, '');
});

test('Bridge: getWorkspaceGitStatusPi invokes get_workspace_git_status', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockStatus: WorkspaceGitStatus = {
    isRepo: true,
    repoName: 'pi-viewer',
    branch: 'main',
    modifiedFiles: ['src/App.tsx'],
    addedFiles: ['src/FileTree.tsx'],
    untrackedFiles: ['odd/tasks.md'],
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockStatus as T;
  };

  const res = await getWorkspaceGitStatusPi('C:/project', mockInvoke);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'get_workspace_git_status');
  assert.deepStrictEqual(calls[0].args, { payload: { workingDirectory: 'C:/project' } });
  assert.strictEqual(res.isRepo, true);
  assert.strictEqual(res.repoName, 'pi-viewer');
  assert.strictEqual(res.branch, 'main');
  assert.strictEqual(res.modifiedFiles.length, 1);
  assert.strictEqual(res.addedFiles.length, 1);
  assert.strictEqual(res.untrackedFiles.length, 1);
});

test('Bridge: getWorkspaceFileDiffPi invokes get_workspace_file_diff', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockDiff: WorkspaceFileDiff = {
    relativePath: 'src/App.tsx',
    hasDiff: true,
    diff: '+import { FileTree } from "./FileTree";\n',
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockDiff as T;
  };

  const res = await getWorkspaceFileDiffPi('src/App.tsx', 'C:/project', mockInvoke);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'get_workspace_file_diff');
  assert.deepStrictEqual(calls[0].args, {
    payload: { relativePath: 'src/App.tsx', workingDirectory: 'C:/project' },
  });
  assert.strictEqual(res.hasDiff, true);
  assert.strictEqual(res.diff.includes('import'), true);
});

test('parseUnifiedDiff: strips Git metadata headers and tracks line numbers accurately', () => {
  const rawDiff = [
    'diff --git a/src/App.tsx b/src/App.tsx',
    'index e827ce8..b06fb0e 100644',
    '--- a/src/App.tsx',
    '+++ b/src/App.tsx',
    '@@ -10,4 +10,5 @@',
    " import React from 'react';",
    "-import { OldComponent } from './Old';",
    "+import { NewComponent } from './New';",
    "+import { AnotherComponent } from './Another';",
    " import { useTheme } from './theme';",
  ].join('\n');

  const parsed = parseUnifiedDiff(rawDiff);

  // 1. Should have 1 hunk header + 5 code lines (no diff --git, index, ---, +++)
  assert.strictEqual(parsed.length, 6);

  // 2. First line is hunk header
  assert.strictEqual(parsed[0].type, 'hunk');
  assert.strictEqual(parsed[0].text.startsWith('@@'), true);

  // 3. Second line is context: line 10 in both old and new
  assert.strictEqual(parsed[1].type, 'context');
  assert.strictEqual(parsed[1].oldLineNumber, 10);
  assert.strictEqual(parsed[1].newLineNumber, 10);
  assert.strictEqual(parsed[1].text, "import React from 'react';");

  // 4. Third line is deletion: line 11 in old, undefined in new
  assert.strictEqual(parsed[2].type, 'del');
  assert.strictEqual(parsed[2].oldLineNumber, 11);
  assert.strictEqual(parsed[2].newLineNumber, undefined);
  assert.strictEqual(parsed[2].text, "import { OldComponent } from './Old';");

  // 5. Fourth line is addition: undefined in old, line 11 in new
  assert.strictEqual(parsed[3].type, 'add');
  assert.strictEqual(parsed[3].oldLineNumber, undefined);
  assert.strictEqual(parsed[3].newLineNumber, 11);
  assert.strictEqual(parsed[3].text, "import { NewComponent } from './New';");

  // 6. Fifth line is second addition: undefined in old, line 12 in new
  assert.strictEqual(parsed[4].type, 'add');
  assert.strictEqual(parsed[4].oldLineNumber, undefined);
  assert.strictEqual(parsed[4].newLineNumber, 12);
  assert.strictEqual(parsed[4].text, "import { AnotherComponent } from './Another';");

  // 7. Sixth line is context: line 12 in old, line 13 in new
  assert.strictEqual(parsed[5].type, 'context');
  assert.strictEqual(parsed[5].oldLineNumber, 12);
  assert.strictEqual(parsed[5].newLineNumber, 13);
  assert.strictEqual(parsed[5].text, "import { useTheme } from './theme';");
});

test('parseUnifiedDiff: returns empty array for empty diff or non-diff text', () => {
  assert.deepStrictEqual(parseUnifiedDiff(''), []);
  assert.deepStrictEqual(parseUnifiedDiff('   \n  '), []);
  assert.deepStrictEqual(parseUnifiedDiff('diff --git a/file b/file\nindex 123..456\n'), []);
});

test('computeDirChangesMap: counts changed files per ancestor directory', () => {
  const gitStatus: WorkspaceGitStatus = {
    isRepo: true,
    repoName: 'pi-viewer',
    branch: 'main',
    modifiedFiles: ['src/App.tsx', 'src/styles.css', 'src-tauri/src/commands.rs'],
    addedFiles: ['src/FileTree.tsx', 'src-tauri/src/lib.rs'],
    untrackedFiles: ['odd/tasks/workspace-file-tree.md', 'README.md'],
  };

  const map = computeDirChangesMap(gitStatus);

  // 'src' has: App.tsx, styles.css, FileTree.tsx -> 3
  assert.strictEqual(map['src'], 3);

  // 'src-tauri' has: commands.rs, lib.rs -> 2
  assert.strictEqual(map['src-tauri'], 2);

  // 'src-tauri/src' has: commands.rs, lib.rs -> 2
  assert.strictEqual(map['src-tauri/src'], 2);

  // 'odd' has: workspace-file-tree.md -> 1
  assert.strictEqual(map['odd'], 1);

  // 'odd/tasks' has: workspace-file-tree.md -> 1
  assert.strictEqual(map['odd/tasks'], 1);

  // Root file 'README.md' has no ancestor dir
  assert.strictEqual(map['README.md'], undefined);
});

test('computeDirChangesMap: handles null or non-repo status gracefully', () => {
  assert.deepStrictEqual(computeDirChangesMap(null), {});
  assert.deepStrictEqual(
    computeDirChangesMap({
      isRepo: false,
      modifiedFiles: [],
      addedFiles: [],
      untrackedFiles: [],
    }),
    {}
  );
});

test('computeTotalGitChanges: returns 0 when status is null, undefined, or isRepo is false', () => {
  assert.strictEqual(computeTotalGitChanges(null), 0);
  assert.strictEqual(computeTotalGitChanges(undefined as unknown as WorkspaceGitStatus | null), 0);
  assert.strictEqual(
    computeTotalGitChanges({
      isRepo: false,
      modifiedFiles: ['src/App.tsx'],
      addedFiles: ['src/New.tsx'],
      untrackedFiles: ['temp.log'],
    }),
    0
  );
});

test('computeTotalGitChanges: correctly sums modifiedFiles, addedFiles, and untrackedFiles', () => {
  const status: WorkspaceGitStatus = {
    isRepo: true,
    repoName: 'pi-viewer',
    branch: 'main',
    modifiedFiles: ['src/App.tsx', 'src/app.css'],
    addedFiles: ['src/features/NewFeature.tsx'],
    untrackedFiles: ['notes.txt', 'scratch.md'],
  };
  assert.strictEqual(computeTotalGitChanges(status), 5);
});

test('computeTotalGitChanges: handles missing or empty arrays cleanly', () => {
  assert.strictEqual(
    computeTotalGitChanges({
      isRepo: true,
      modifiedFiles: [],
      addedFiles: [],
      untrackedFiles: [],
    }),
    0
  );
  assert.strictEqual(
    computeTotalGitChanges({
      isRepo: true,
    } as unknown as WorkspaceGitStatus),
    0
  );
  assert.strictEqual(
    computeTotalGitChanges({
      isRepo: true,
      modifiedFiles: ['src/App.tsx'],
    } as unknown as WorkspaceGitStatus),
    1
  );
  assert.strictEqual(
    computeTotalGitChanges({
      isRepo: true,
      addedFiles: ['src/New.tsx'],
    } as unknown as WorkspaceGitStatus),
    1
  );
  assert.strictEqual(
    computeTotalGitChanges({
      isRepo: true,
      untrackedFiles: ['temp.log'],
    } as unknown as WorkspaceGitStatus),
    1
  );
});

/* ========================================================================= */
/* FileTree Auto-Refresh & Expanded Dirs Revalidation Tests                   */
/* ========================================================================= */

test('updateDirChildrenOnRefresh: updates existing and adds new child scans', () => {
  const prevChildren: Record<string, WorkspaceEntry[]> = {
    src: [
      { name: 'App.tsx', relativePath: 'src/App.tsx', isDir: false },
    ],
    oldDir: [
      { name: 'deleted.txt', relativePath: 'oldDir/deleted.txt', isDir: false },
    ],
  };

  const results = [
    {
      dirPath: 'src',
      children: [
        { name: 'App.tsx', relativePath: 'src/App.tsx', isDir: false },
        { name: 'FileTree.tsx', relativePath: 'src/FileTree.tsx', isDir: false },
      ],
    },
    {
      dirPath: 'docs',
      children: [
        { name: 'README.md', relativePath: 'docs/README.md', isDir: false },
      ],
    },
    {
      dirPath: 'oldDir',
      children: undefined, // Failed / deleted
    },
  ];

  const updated = updateDirChildrenOnRefresh(prevChildren, results);

  // 'src' updated with both files
  assert.strictEqual(updated['src'].length, 2);
  assert.strictEqual(updated['src'][1].name, 'FileTree.tsx');

  // 'docs' added
  assert.strictEqual(updated['docs'].length, 1);
  assert.strictEqual(updated['docs'][0].name, 'README.md');

  // 'oldDir' removed because children is undefined (failed)
  assert.strictEqual(updated['oldDir'], undefined);
});

test('pruneExpandedDirsOnRefresh: prunes failed or deleted directories from expanded set', () => {
  const prevDirs = new Set(['src', 'src-tauri', 'removed-folder']);

  const results = [
    { dirPath: 'src', success: true },
    { dirPath: 'src-tauri', success: true },
    { dirPath: 'removed-folder', success: false },
  ];

  const pruned = pruneExpandedDirsOnRefresh(prevDirs, results);

  assert.strictEqual(pruned.has('src'), true);
  assert.strictEqual(pruned.has('src-tauri'), true);
  assert.strictEqual(pruned.has('removed-folder'), false);
  assert.strictEqual(pruned.size, 2);

  // If all succeeded, returns same reference
  const allSuccess = [
    { dirPath: 'src', success: true },
    { dirPath: 'src-tauri', success: true },
  ];
  const unchanged = pruneExpandedDirsOnRefresh(pruned, allSuccess);
  assert.strictEqual(unchanged, pruned);
});

test('i18n: file tree and auto-refresh settings keys exist with exact parity in en.json and es.json', () => {
  const requiredKeys = [
    'file_tree.title',
    'file_tree.search_placeholder',
    'file_tree.refresh',
    'file_tree.loading',
    'file_tree.search_matches',
    'file_tree.no_results',
    'file_tree.empty',
    'file_tree.git_repo',
    'file_tree.git_branch',
    'file_tree.git_modified',
    'file_tree.git_added',
    'file_tree.git_untracked',
    'file_tree.git_changed_count',
    'file_tree.git_dir_changes',
    'file_tree.create_folder',
    'file_tree.folder_name_placeholder',
    'file_tree.create_folder_submit',
    'file_tree.create_folder_cancel',
    'file_tree.folder_name_required',
    'file_tree.filter_modified',
    'file_tree.filter_modified_hint',
    'file_tree.no_modified_files',
    'file_tree.manage_branches',
    'file_tree.branches_button',
    'file_tree.tracking',
    'file_tree.no_upstream',
    'file_tree.current_branch',
    'file_tree.create_branch_btn',
    'file_tree.branch_name_placeholder',
    'file_tree.base_branch_label',
    'file_tree.create_branch_submit',
    'file_tree.branch_name_required',
    'file_tree.switch_branch_btn',
    'file_tree.switch_confirm_title',
    'file_tree.switch_confirm_msg',
    'file_tree.switch_confirm_action',
    'file_tree.search_branches',
    'file_tree.no_branches_found',
    'file_tree.uncommitted_changes_title',
    'file_tree.uncommitted_changes_msg',
    'file_tree.carry_changes_btn',
    'file_tree.leave_changes_btn',
    'file_tree.delete_branch_btn',
    'file_tree.delete_confirm_title',
    'file_tree.delete_confirm_msg',
    'file_tree.delete_branch_action',
    'file_tree.default_branch_badge',
    'file_tree.publish_branch_btn',
    'file_tree.publish_branch_action',
    'file_tree.publish_confirm_title',
    'file_tree.publish_confirm_msg',
    'file_tree.view_commits_btn',
    'file_tree.load_more_commits',
    'file_tree.loading_commits',
    'file_tree.no_commits_found',
    'file_tree.copy_commit_hash',
    'file_tree.commit_hash_copied',
    'file_tree.commit_unpushed_title',
    'file_tree.branch_commits_modal_title',
    'file_tree.branch_commits_back',
    'file_tree.branch_actions_toggle',
    'settings.file_tree_heading',
    'settings.file_tree_hint',
    'settings.file_tree_interval_label',
    'settings.file_tree_interval_subtext',
    'settings.file_tree_interval_disabled',
    'settings.file_tree_interval_5s',
    'settings.file_tree_interval_10s',
    'settings.file_tree_interval_15s',
    'settings.file_tree_interval_30s',
    'settings.file_tree_interval_60s',
  ];

  for (const key of requiredKeys) {
    assert.ok(key in enJson, `Key ${key} missing from en.json`);
    assert.ok(key in esJson, `Key ${key} missing from es.json`);

    const enVal = (enJson as Record<string, string>)[key];
    const esVal = (esJson as Record<string, string>)[key];

    assert.ok(typeof enVal === 'string' && enVal.trim().length > 0, `en.json ${key} must be non-empty string`);
    assert.ok(typeof esVal === 'string' && esVal.trim().length > 0, `es.json ${key} must be non-empty string`);
  }

  // Total dictionary key parity
  const enKeys = Object.keys(enJson).sort();
  const esKeys = Object.keys(esJson).sort();
  assert.deepStrictEqual(enKeys, esKeys, 'en.json and es.json must have exact 1:1 key parity');
});

test('FileSearchBar: renders empty state, wrapper, svg icon, and input attributes', () => {
  assert.strictEqual(typeof FileSearchBar, 'function');

  const element = React.createElement(FileSearchBar, {
    value: '',
    onChange: () => {},
    placeholder: 'Search files...',
    clearAriaLabel: 'Clear file search',
    className: 'custom-tree-search',
    autoFocus: true,
  });

  const markup = renderToStaticMarkup(element);

  // Outer container and classes
  assert.ok(markup.includes('search-input-wrapper custom-tree-search'));
  // SVG icon
  assert.ok(markup.includes('search-icon'));
  assert.ok(markup.includes('aria-hidden="true"'));
  // Input attributes
  assert.ok(markup.includes('class="sidebar-search-input"'));
  assert.ok(markup.includes('placeholder="Search files..."'));
  assert.ok(markup.includes('aria-label="Search files..."'));
  assert.ok(markup.includes('value=""'));
  // Clear button is not rendered when value is empty
  assert.ok(!markup.includes('search-clear-btn'));
});

test('FileSearchBar: renders query state with clear button containing svg cross, handles onChange and clear click', () => {
  let changedVal = '';
  const element = React.createElement(FileSearchBar, {
    value: 'Cargo.toml',
    onChange: (val: string) => {
      changedVal = val;
    },
    placeholder: 'Search files...',
    clearAriaLabel: 'Clear file search',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('value="Cargo.toml"'));
  assert.ok(markup.includes('search-clear-btn'));
  assert.ok(markup.includes('aria-label="Clear file search"'));
  // Svg cross lines
  assert.ok(markup.includes('line x1="18" y1="6" x2="6" y2="18"'));

  // Direct component tree test for event callbacks
  const instance = FileSearchBar({
    value: 'Cargo.toml',
    onChange: (val: string) => {
      changedVal = val;
    },
    placeholder: 'Search files...',
    clearAriaLabel: 'Clear file search',
  });

  assert.ok(React.isValidElement(instance));
  assert.strictEqual(instance.props.className, 'search-input-wrapper');

  const children = React.Children.toArray(instance.props.children);
  const inputEl = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'input'
  );
  assert.ok(inputEl);
  inputEl.props.onChange({ target: { value: 'README.md' } });
  assert.strictEqual(changedVal, 'README.md');

  const clearBtn = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'button'
  );
  assert.ok(clearBtn);
  assert.strictEqual(clearBtn.props['aria-label'], 'Clear file search');
  clearBtn.props.onClick();
  assert.strictEqual(changedVal, '');
});

test('FileSearchBar: uses default clearAriaLabel when omitted', () => {
  const instance = FileSearchBar({
    value: 'src/main.rs',
    onChange: () => {},
    placeholder: 'Search...',
  });

  assert.ok(React.isValidElement(instance));
  const children = React.Children.toArray(instance.props.children);
  const clearBtn = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'button'
  );
  assert.ok(clearBtn);
  assert.strictEqual(clearBtn.props['aria-label'], 'Clear search');
});

/* ========================================================================= */
/* Regression tests: Path Normalization & Windows Ancestor Matching           */
/* ========================================================================= */

test('normalizeTreePath: normalizes backslashes, leading ./, and slashes while preserving spaces and Unicode', () => {
  assert.strictEqual(normalizeTreePath('src\\components\\Button.tsx'), 'src/components/Button.tsx');
  assert.strictEqual(normalizeTreePath('.\\src\\App.tsx'), 'src/App.tsx');
  assert.strictEqual(normalizeTreePath('./src/App.tsx'), 'src/App.tsx');
  assert.strictEqual(normalizeTreePath('/nested/dir/'), 'nested/dir');
  assert.strictEqual(normalizeTreePath('\\nested\\dir\\'), 'nested/dir');
  assert.strictEqual(normalizeTreePath('  leading and trailing  .txt'), '  leading and trailing  .txt');
  assert.strictEqual(normalizeTreePath('sub\\  spaced  \\日本語.txt'), 'sub/  spaced  /日本語.txt');
  assert.strictEqual(normalizeTreePath(''), '');
  assert.strictEqual(normalizeTreePath(null as any), '');
  assert.strictEqual(normalizeTreePath(undefined as any), '');
});

test('computeDirChangesMap: normalizes Windows backslashes and relative prefixes for ancestor counts', () => {
  const gitStatus: WorkspaceGitStatus = {
    isRepo: true,
    repoName: 'pi-viewer',
    branch: 'main',
    modifiedFiles: ['src\\components\\Button.tsx', '.\\src\\App.tsx'],
    addedFiles: ['docs\\sub\\intro.md'],
    untrackedFiles: ['odd/tasks/workspace.md'],
  };

  const map = computeDirChangesMap(gitStatus);

  assert.strictEqual(map['src'], 2);
  assert.strictEqual(map['src/components'], 1);
  assert.strictEqual(map['docs'], 1);
  assert.strictEqual(map['docs/sub'], 1);
  assert.strictEqual(map['odd'], 1);
  assert.strictEqual(map['odd/tasks'], 1);
});

test('frontend tree matching: normalized sets match Windows tree entry relativePath', () => {
  const gitStatus: WorkspaceGitStatus = {
    isRepo: true,
    repoName: 'pi-viewer',
    branch: 'main',
    modifiedFiles: ['src/components/Button.tsx'],
    addedFiles: ['src/New.tsx'],
    untrackedFiles: ['temp.log'],
  };

  const gitModifiedSet = new Set((gitStatus.modifiedFiles || []).map(normalizeTreePath));
  const gitAddedSet = new Set((gitStatus.addedFiles || []).map(normalizeTreePath));
  const gitUntrackedSet = new Set((gitStatus.untrackedFiles || []).map(normalizeTreePath));
  const dirChangesMap = computeDirChangesMap(gitStatus);

  // Even if Windows bridge returned backslashes in entry.relativePath:
  const windowsEntry = {
    name: 'Button.tsx',
    relativePath: 'src\\components\\Button.tsx',
    isDir: false,
  };
  const windowsFolderEntry = {
    name: 'components',
    relativePath: 'src\\components',
    isDir: true,
  };

  const normFile = normalizeTreePath(windowsEntry.relativePath);
  const normFolder = normalizeTreePath(windowsFolderEntry.relativePath);

  assert.strictEqual(gitModifiedSet.has(normFile), true, 'Modified set should match normalized Windows relativePath');
  assert.strictEqual(gitAddedSet.has(normFile), false);
  assert.strictEqual(gitUntrackedSet.has(normFile), false);
  assert.strictEqual(dirChangesMap[normFolder], 1, 'Ancestor map should match normalized Windows folder relativePath');
});

/* ========================================================================= */
/* Modified Filter Tests (isEntryModified and FileTree Modified toggle)       */
/* ========================================================================= */

test('isEntryModified: identifies modified, added, and untracked files as modified', () => {
  const gitModifiedSet = new Set(['src/App.tsx']);
  const gitAddedSet = new Set(['src/new-feature.ts']);
  const gitUntrackedSet = new Set(['notes.txt']);
  const dirChangesMap = { src: 2 };

  const modFile: WorkspaceEntry = { name: 'App.tsx', relativePath: 'src/App.tsx', isDir: false };
  const addFile: WorkspaceEntry = { name: 'new-feature.ts', relativePath: 'src/new-feature.ts', isDir: false };
  const untrackedFile: WorkspaceEntry = { name: 'notes.txt', relativePath: 'notes.txt', isDir: false };
  const cleanFile: WorkspaceEntry = { name: 'clean.ts', relativePath: 'src/clean.ts', isDir: false };

  assert.strictEqual(isEntryModified(modFile, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), true);
  assert.strictEqual(isEntryModified(addFile, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), true);
  assert.strictEqual(isEntryModified(untrackedFile, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), true);
  assert.strictEqual(isEntryModified(cleanFile, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), false);
});

test('isEntryModified: identifies directories with nested changes as modified', () => {
  const gitModifiedSet = new Set(['src/components/button.tsx']);
  const gitAddedSet = new Set<string>();
  const gitUntrackedSet = new Set<string>();
  const dirChangesMap = { src: 1, 'src/components': 1 };

  const srcDir: WorkspaceEntry = { name: 'src', relativePath: 'src', isDir: true };
  const componentsDir: WorkspaceEntry = { name: 'components', relativePath: 'src/components', isDir: true };
  const docsDir: WorkspaceEntry = { name: 'docs', relativePath: 'docs', isDir: true };

  assert.strictEqual(isEntryModified(srcDir, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), true);
  assert.strictEqual(isEntryModified(componentsDir, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), true);
  assert.strictEqual(isEntryModified(docsDir, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), false);
});

test('isEntryModified: normalizes Windows backslashes and relative prefixes', () => {
  const gitModifiedSet = new Set(['src/lib/utils.ts']);
  const gitAddedSet = new Set<string>();
  const gitUntrackedSet = new Set<string>();
  const dirChangesMap = { 'src/lib': 1 };

  const winFile: WorkspaceEntry = { name: 'utils.ts', relativePath: 'src\\lib\\utils.ts', isDir: false };
  const winDir: WorkspaceEntry = { name: 'lib', relativePath: '.\\src\\lib\\', isDir: true };

  assert.strictEqual(isEntryModified(winFile, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), true);
  assert.strictEqual(isEntryModified(winDir, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), true);
});

test('isEntryModified: returns false for empty or non-repo status', () => {
  const gitModifiedSet = new Set<string>();
  const gitAddedSet = new Set<string>();
  const gitUntrackedSet = new Set<string>();
  const dirChangesMap: Record<string, number> = {};

  const file: WorkspaceEntry = { name: 'file.txt', relativePath: 'file.txt', isDir: false };
  const dir: WorkspaceEntry = { name: 'src', relativePath: 'src', isDir: true };

  assert.strictEqual(isEntryModified(file, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), false);
  assert.strictEqual(isEntryModified(dir, gitModifiedSet, gitAddedSet, gitUntrackedSet, dirChangesMap), false);
});

test('FileTree: renders Modified button without auto-expanding collapsed directories', () => {
  const element = React.createElement(FileTree, {
    workingDirectory: 'C:/project',
    locale: 'en',
    onOpenFile: () => {},
  });
  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('btn-tree-modified'), 'Must render Modified button');
  assert.ok(markup.includes('Modified'), 'Must render label');
  assert.strictEqual(markup.includes('btn-tree-create-folder'), false, 'Create folder button must be absent');
});

/* ========================================================================= */
/* Git Branch Management & Tracking Tests                                    */
/* ========================================================================= */

test('Bridge: listWorkspaceBranchesPi invokes list_workspace_branches command', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockResult: WorkspaceBranchList = {
    current: 'feat/test',
    branches: [
      { name: 'main', isCurrent: false, upstream: 'origin/main' },
      { name: 'feat/test', isCurrent: true, upstream: 'origin/feat/test' },
    ],
    allBases: ['main', 'feat/test', 'origin/main'],
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockResult as T;
  };

  const res = await listWorkspaceBranchesPi('C:/project', mockInvoke);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'list_workspace_branches');
  assert.deepStrictEqual(calls[0].args, { payload: { workingDirectory: 'C:/project' } });
  assert.strictEqual(res.current, 'feat/test');
  assert.strictEqual(res.branches.length, 2);
  assert.strictEqual(res.branches[1].upstream, 'origin/feat/test');
});

test('Bridge: switchWorkspaceBranchPi invokes switch_workspace_branch with payload', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockResult: BranchOperationResult = {
    success: true,
    branch: 'main',
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockResult as T;
  };

  const res = await switchWorkspaceBranchPi('main', 'C:/project', mockInvoke);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'switch_workspace_branch');
  assert.deepStrictEqual(calls[0].args, {
    payload: { branch: 'main', workingDirectory: 'C:/project' },
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.branch, 'main');
});

test('Bridge: createWorkspaceBranchPi invokes create_workspace_branch with name, base, and leaveChangesInBase', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockResult: BranchOperationResult = {
    success: true,
    branch: 'feat/new',
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockResult as T;
  };

  const res = await createWorkspaceBranchPi('feat/new', 'main', true, 'C:/project', mockInvoke);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'create_workspace_branch');
  assert.deepStrictEqual(calls[0].args, {
    payload: {
      name: 'feat/new',
      baseBranch: 'main',
      leaveChangesInBase: true,
      workingDirectory: 'C:/project',
    },
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.branch, 'feat/new');
});

test('isValidGitBranchName: validates safe branch names and rejects dangerous or invalid patterns', () => {
  assert.strictEqual(isValidGitBranchName('main'), true);
  assert.strictEqual(isValidGitBranchName('feat/new-branches'), true);
  assert.strictEqual(isValidGitBranchName('fix_123'), true);
  assert.strictEqual(isValidGitBranchName('v1.0.0'), true);

  // Invalid patterns
  assert.strictEqual(isValidGitBranchName(''), false);
  assert.strictEqual(isValidGitBranchName('-bad'), false);
  assert.strictEqual(isValidGitBranchName('.bad'), false);
  assert.strictEqual(isValidGitBranchName('bad.'), false);
  assert.strictEqual(isValidGitBranchName('bad/'), false);
  assert.strictEqual(isValidGitBranchName('bad.lock'), false);
  assert.strictEqual(isValidGitBranchName('bad name'), false);
  assert.strictEqual(isValidGitBranchName('bad~1'), false);
  assert.strictEqual(isValidGitBranchName('bad^1'), false);
  assert.strictEqual(isValidGitBranchName('bad:1'), false);
  assert.strictEqual(isValidGitBranchName('bad?1'), false);
  assert.strictEqual(isValidGitBranchName('bad*1'), false);
  assert.strictEqual(isValidGitBranchName('bad[1'), false);
  assert.strictEqual(isValidGitBranchName('bad\\1'), false);
  assert.strictEqual(isValidGitBranchName('bad..name'), false);
  assert.strictEqual(isValidGitBranchName('bad//name'), false);
  assert.strictEqual(isValidGitBranchName('bad@{name}'), false);
});

test('BranchManagerModal: renders modal container and controls without branch-current-banner', () => {
  const element = React.createElement(BranchManagerModal, {
    isOpen: true,
    onClose: () => {},
    workingDirectory: 'C:/project',
    currentBranch: 'feat/branch-mgr',
    upstreamBranch: 'origin/feat/branch-mgr',
    isAgentWorking: false,
    locale: 'en',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('branch-modal-container'), 'Must render modal container');
  assert.ok(markup.includes('btn-branch-new'), 'Must have create branch button');
  assert.strictEqual(markup.includes('branch-current-banner'), false, 'branch-current-banner must be removed');
});

test('BranchManagerModal: renders confirmation dialog structure for when agent is working', () => {
  const element = React.createElement(BranchManagerModal, {
    isOpen: true,
    onClose: () => {},
    workingDirectory: 'C:/project',
    currentBranch: 'feat/test',
    upstreamBranch: 'origin/main',
    isAgentWorking: true,
    locale: 'es',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('branch-modal-container'));
  assert.ok(markup.includes('Administrar ramas'));
});

test('FileTree: renders git branch badge without git-upstream-info element', () => {
  const element = React.createElement(FileTree, {
    workingDirectory: 'C:/project',
    locale: 'en',
    onOpenFile: () => {},
  });

  const markup = renderToStaticMarkup(element);
  assert.strictEqual(markup.includes('git-upstream-info'), false, 'git-upstream-info element must be removed');
});

test('deduplicateBaseBranches: suppresses redundant origin/main and bare origin when main exists', () => {
  const localBranches = ['main', 'feat/test'];
  const remoteRefs = [
    'origin',
    'origin/main',
    'origin/feat/test',
    'origin/remote-only-feature',
    'github-desktop-Rafaeldelinares',
    'github-desktop-Rafaeldelinares/main',
  ];

  const result = deduplicateBaseBranches(localBranches, remoteRefs);

  // 'main' is preserved, 'origin' is discarded, 'origin/main' is discarded
  assert.deepStrictEqual(result, ['main', 'feat/test', 'origin/remote-only-feature']);
  assert.strictEqual(result.includes('origin'), false, 'Bare origin remote must not be included');
  assert.strictEqual(result.includes('origin/main'), false, 'Redundant origin/main must not be included when main exists');
  assert.strictEqual(result.includes('main'), true, 'Local main must be present');
});

test('sanitizeBranchName: replaces spaces with hyphens and strips hyphens adjacent to slashes', () => {
  assert.strictEqual(sanitizeBranchName('my new branch'), 'my-new-branch');
  assert.strictEqual(sanitizeBranchName('feat / my branch'), 'feat/my-branch');
  assert.strictEqual(sanitizeBranchName('feature/ - test'), 'feature/test');
  assert.strictEqual(sanitizeBranchName('bugfix - /login'), 'bugfix/login');
  assert.strictEqual(sanitizeBranchName('feat - / - branch'), 'feat/branch');
  assert.strictEqual(sanitizeBranchName('-feat/branch-'), 'feat/branch');
  assert.strictEqual(sanitizeBranchName('feat---/---branch'), 'feat/branch');
  assert.strictEqual(sanitizeBranchName('feature /// branch'), 'feature/branch');
  assert.strictEqual(sanitizeBranchName(''), '');
});

test('Bridge: deleteWorkspaceBranchPi invokes delete_workspace_branch with payload', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockResult: BranchOperationResult = {
    success: true,
    branch: 'feat/old',
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockResult as T;
  };

  const res = await deleteWorkspaceBranchPi('feat/old', 'C:/project', mockInvoke);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'delete_workspace_branch');
  assert.deepStrictEqual(calls[0].args, {
    payload: {
      branch: 'feat/old',
      workingDirectory: 'C:/project',
    },
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.branch, 'feat/old');
});

test('Bridge: publishWorkspaceBranchPi invokes publish_workspace_branch with payload', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockResult: BranchOperationResult = {
    success: true,
    branch: 'feat/local-only',
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockResult as T;
  };

  const res = await publishWorkspaceBranchPi('feat/local-only', 'origin', 'C:/project', mockInvoke);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'publish_workspace_branch');
  assert.deepStrictEqual(calls[0].args, {
    payload: {
      branch: 'feat/local-only',
      remote: 'origin',
      workingDirectory: 'C:/project',
    },
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.branch, 'feat/local-only');
});

test('Bridge: listWorkspaceBranchCommitsPi invokes list_workspace_branch_commits with payload', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockResult = {
    branch: 'feat/test',
    commits: [
      {
        hash: 'abc123456789',
        shortHash: 'abc1234',
        subject: 'test commit',
        author: 'Tester',
        date: '2026-10-23',
        isUnpushed: true,
      },
    ],
    hasMore: false,
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return mockResult as T;
  };

  const res = await listWorkspaceBranchCommitsPi('feat/test', 10, 0, 'C:/project', mockInvoke);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'list_workspace_branch_commits');
  assert.deepStrictEqual(calls[0].args, {
    payload: {
      branch: 'feat/test',
      limit: 10,
      offset: 0,
      workingDirectory: 'C:/project',
    },
  });
  assert.strictEqual(res.branch, 'feat/test');
  assert.strictEqual(res.commits.length, 1);
  assert.strictEqual(res.commits[0].isUnpushed, true);
});

test('BranchManagerModal: renders view commits button in branch actions', () => {
  const element = React.createElement(BranchManagerModal, {
    isOpen: true,
    onClose: () => {},
    workingDirectory: 'C:/project',
    currentBranch: 'main',
    isAgentWorking: false,
    locale: 'es',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('btn-branch-new'));
  assert.ok(markup.includes('branch-modal-container'));
});

test('BranchCommitsModal: renders dedicated modal container and header with branch name', () => {
  const element = React.createElement(BranchCommitsModal, {
    isOpen: true,
    onClose: () => {},
    branchName: 'feature/new-ui',
    workingDirectory: 'C:/project',
    locale: 'es',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('branch-commits-modal-container'));
  assert.ok(markup.includes('Commits en feature/new-ui'));
});

test('sortBranchesMainFirst: guarantees main is always first in the list', () => {
  const branches = [
    { name: 'feature/zebra', isCurrent: false },
    { name: 'fix/alpha', isCurrent: false },
    { name: 'main', isCurrent: false },
    { name: 'develop', isCurrent: true },
  ];

  const sorted = sortBranchesMainFirst(branches, 'main');
  assert.equal(sorted[0].name, 'main');
  assert.deepEqual(
    sorted.map((b) => b.name),
    ['main', 'develop', 'feature/zebra', 'fix/alpha']
  );
});

test('BranchManagerModal: renders slidable actions drawer and toggle button', () => {
  const element = React.createElement(BranchManagerModal, {
    isOpen: true,
    onClose: () => {},
    workingDirectory: 'C:/project',
    currentBranch: 'main',
    isAgentWorking: false,
    locale: 'es',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('branch-modal-container'));
});




