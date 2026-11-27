import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { outputFiles: [{ text: fixture }] } = await build({
  stdin: {
    loader: 'tsx', resolveDir: root, contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ExtensionUiPromptBar } from './src/features/chat/components/ExtensionUiPromptBar';
      import { useExtensionUiDialog } from './src/features/chat/hooks/useExtensionUiDialog';

      function Fixture() {
        const [revision, rerender] = useState(0);
        const ui = useExtensionUiDialog({ cwd: '/project-a', sessionId: 'a' });
        window.rerender = () => rerender(value => value + 1);
        window.openQuestion = (id, options) => {
          void ui.dialogAdapter.select({ type: 'extension_ui_request', id, method: 'select', cwd: '/project-a', sessionId: 'a', title: 'Choose features', options });
        };
        return <><output data-revision={revision} />{ui.activeDialog &&
          <ExtensionUiPromptBar dialog={ui.activeDialog} pendingCount={ui.pendingCount}
            canGoBack={ui.canGoBack} flowAnswers={ui.flowAnswers} onBack={ui.handleBack}
            onSelect={ui.handleSelect} onMultiSelectSubmit={ui.handleMultiSelectSubmit}
            onInput={ui.handleInput} onConfirm={ui.handleConfirm} onCancel={ui.handleCancel} />}</>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `,
  },
  tsconfig: `${root}/tsconfig.app.json`, bundle: true, write: false,
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: fixture });
  await page.locator('output').waitFor({ state: 'attached' });

  const cases = [
    { id: 'single', options: ['Alpha', 'Beta'], role: 'option', attr: 'aria-selected', marks: ['true', 'false'] },
    { id: 'multi', options: ['[ ] Alpha', '[ ] Beta', '[ ] Gamma', 'Done'], role: 'checkbox', attr: 'aria-checked', marks: ['true', 'true', 'false'] },
  ];
  const results = [];
  for (const [index, { id, options, role, attr, marks }] of cases.entries()) {
    await page.evaluate(({ id, options }) => window.openQuestion(id, options), { id, options });
    const choices = page.getByRole(role);
    const submit = page.locator('.extension-prompt-step-content .btn-extension-prompt-primary');
    const readMarks = () => choices.evaluateAll((elements, attr) => elements.map(el => el.getAttribute(attr)), attr);
    await choices.first().waitFor();
    assert.deepEqual(await readMarks(), marks.map(() => 'false'));
    assert.equal(await submit.isEnabled(), false);
    for (const [i, mark] of marks.entries()) if (mark === 'true') await choices.nth(i).click();
    assert.deepEqual(await readMarks(), marks);
    assert.equal(await submit.isEnabled(), true);

    // An unrelated app update (such as completion of a tool in another project)
    // renders the hook again without changing the active dialog or saved answers.
    await page.evaluate(() => window.rerender());
    await page.locator(`output[data-revision="${index + 1}"]`).waitFor({ state: 'attached' });
    results.push({ id, marks: await readMarks(), enabled: await submit.isEnabled() });
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await choices.first().waitFor({ state: 'hidden' });
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(results, cases.map(({ id, marks }) => ({ id, marks, enabled: true })));
  console.log('PASS: single and multiple draft selections survive an unrelated render');
} finally {
  await browser.close();
}
