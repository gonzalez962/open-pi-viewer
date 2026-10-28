import { loadViewerStorage, saveViewerStorage } from '../storage';

type Provider = 'openai' | 'openai-compatible';
type Entry = { provider: Provider; endpoint: string; apiKey: string };

function identity(provider: unknown, endpoint: unknown): { provider: Provider; endpoint: string } {
  if (provider !== 'openai' && provider !== 'openai-compatible') throw new Error('Invalid voice provider');
  if (typeof endpoint !== 'string') throw new Error('Invalid voice endpoint');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid voice endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid voice endpoint');
  return { provider, endpoint: url.toString().replace(/\/+$/, '') };
}

function read(): Entry[] {
  try {
    const storage = loadViewerStorage();
    if (!storage.voiceCredentials || !Array.isArray(storage.voiceCredentials)) return [];
    return (storage.voiceCredentials as Entry[]).filter(
      (e) => e && (e.provider === 'openai' || e.provider === 'openai-compatible') && typeof e.endpoint === 'string' && typeof e.apiKey === 'string'
    );
  } catch {
    throw new Error('Unable to read voice credentials');
  }
}

function update(transform: (entries: Entry[]) => Entry[]): void {
  try {
    const current = read();
    const updated = transform(current);
    saveViewerStorage({ voiceCredentials: updated });
  } catch {
    throw new Error('Unable to update voice credentials');
  }
}

export function getVoiceCredential(provider: unknown, endpoint: unknown): string | undefined {
  const id = identity(provider, endpoint);
  return read().find((entry) => entry.provider === id.provider && entry.endpoint === id.endpoint)?.apiKey;
}

export function voiceCredentialStatus(provider: unknown, endpoint: unknown) {
  return { configured: Boolean(getVoiceCredential(provider, endpoint)) };
}

export function saveVoiceCredential(provider: unknown, endpoint: unknown, apiKey: unknown) {
  const id = identity(provider, endpoint);
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Voice API key is required');
  update((entries) => [...entries.filter((entry) => entry.provider !== id.provider || entry.endpoint !== id.endpoint), { ...id, apiKey: apiKey.trim() }]);
  return { configured: true };
}

export function clearVoiceCredential(provider: unknown, endpoint: unknown) {
  const id = identity(provider, endpoint);
  update((entries) => entries.filter((entry) => entry.provider !== id.provider || entry.endpoint !== id.endpoint));
  return { configured: false };
}
