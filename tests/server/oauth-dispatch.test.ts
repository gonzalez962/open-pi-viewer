import test from 'node:test';
import assert from 'node:assert/strict';
import { handleIpcCommand } from '@server/web-ipc-bridge';

for (const command of ['get_builtin_oauth_providers', 'start_oauth_login', 'cancel_oauth_login', 'send_oauth_prompt_response', 'logout_oauth_provider']) {
  test(`web OAuth dispatch denies ${command} without server-provided identity`, async () => {
    await assert.rejects(handleIpcCommand(command, { oauthOwner: 'spoofed', payload: { providerId: 'openai-codex' } }), /OAUTH_UNAUTHORIZED/);
  });
}
