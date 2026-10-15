import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { mergeProfileCatalog } from '@features/profiles/hooks/useProfiles';

function parse(relative: string) {
  const text = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  return ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

test('profile editor accepts late runtime models and preserves provider filtering', () => {
  const file = parse('../../../src/features/profiles/hooks/useProfiles.ts');
  let effect: ts.Expression | undefined;
  let enrichHelper: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'enrichApprovedModelsWithPassed') enrichHelper = node;
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' &&
        node.arguments[1]?.getText(file) === '[passedModels]') effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(effect);
  const old = { id: 'custom/old', provider: 'custom' };
  const added = { id: 'added', provider: 'custom', name: 'New model' };
  const hidden = { id: 'hidden', provider: 'custom' };
  let models = [old];
  const scope = {
    passedModels: [old, added, hidden],
    customProvidersRef: { current: { custom: { excludedModels: ['hidden'] } } },
    setAvailableModels: (update: (current: typeof models) => typeof models) => { models = update(models); },
    mergeProfileCatalog,
    extractApprovedProviderModels: () => [],
    enrichApprovedModelsWithPassed: new Function(ts.transpileModule(
      `${enrichHelper!.getText(file)}; return enrichApprovedModelsWithPassed;`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText)(),
  };
  const js = ts.transpileModule(`const effect = ${effect.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function(...Object.keys(scope), `${js}; effect();`)(...Object.values(scope));
  assert.deepEqual(models.map((model) => model.id), ['custom/old', 'custom/added']);
});

test('Settings profiles receives the App live catalog and forwards it to its hook', () => {
  const app = parse('../../../src/app/App.tsx');
  let supplied = false;
  function visitApp(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(app) === 'ProfilesView') {
        supplied = node.attributes.properties.some((prop) => ts.isJsxAttribute(prop) &&
          prop.name.getText(app) === 'availableModels' && prop.initializer?.getText(app) === '{state.availableModels}');
      }
    }
    ts.forEachChild(node, visitApp);
  }
  visitApp(app);
  assert.equal(supplied, true, 'Settings ProfilesView must receive live models');
  const view = parse('../../../src/features/profiles/ProfilesView.tsx');
  let forwarded = false;
  function visitView(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(view) === 'useProfiles') {
      forwarded = !!node.arguments[0] && /availableModels/.test(node.arguments[0].getText(view));
    }
    ts.forEachChild(node, visitView);
  }
  visitView(view);
  assert.equal(forwarded, true, 'ProfilesView must forward live models into useProfiles');
});
