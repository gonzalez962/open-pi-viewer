export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  input_modalities?: string[];
  [key: string]: unknown;
}

export interface FetchModelsOptions {
  fetchFn?: typeof fetch;
  catalogFetchFn?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function extractModelBaseId(id: string): string {
  if (!id || typeof id !== 'string') return '';
  let clean = id.trim();
  if (clean.startsWith('models/')) clean = clean.slice(7);
  const slashIdx = clean.lastIndexOf('/');
  if (slashIdx >= 0) clean = clean.slice(slashIdx + 1);
  return clean;
}

function normalizeModelSlug(id: string): string {
  const base = extractModelBaseId(id).toLowerCase();
  if (!base) return '';
  const withoutColon = base.split(':')[0].split('@')[0];
  return withoutColon.replace(/-(high|medium|low|thinking|minimal|max|xhigh)$/i, '');
}

function parseModelsPayload(payload: unknown): DiscoveredModel[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = payload as Record<string, unknown>;
  let list: unknown[] = [];
  if (Array.isArray(raw.data)) list = raw.data;
  else if (Array.isArray(raw.models)) list = raw.models;
  else if (Array.isArray(payload)) list = payload as unknown[];

  const result: DiscoveredModel[] = [];
  const seenIds = new Set<string>();

  for (const item of list) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed || seenIds.has(trimmed)) continue;
      seenIds.add(trimmed);
      result.push({ id: trimmed, name: trimmed });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    let rawId = typeof obj.id === 'string' ? obj.id.trim() : typeof obj.name === 'string' ? obj.name.trim() : '';
    if (rawId.startsWith('models/')) rawId = rawId.slice(7);
    if (!rawId || seenIds.has(rawId)) continue;
    seenIds.add(rawId);

    const modelName = typeof obj.name === 'string' && obj.name.trim() ? (obj.name.trim().startsWith('models/') ? obj.name.trim().slice(7) : obj.name.trim()) : rawId;
    const model: DiscoveredModel = { id: rawId, name: modelName };
    if (typeof obj.context_length === 'number') model.contextWindow = obj.context_length;
    else if (typeof obj.contextWindow === 'number') model.contextWindow = obj.contextWindow;
    if (typeof obj.max_completion_tokens === 'number') model.maxTokens = obj.max_completion_tokens;
    else if (typeof obj.maxTokens === 'number') model.maxTokens = obj.maxTokens;

    const arch = obj.architecture as Record<string, unknown> | undefined;
    if (arch && Array.isArray(arch.input_modalities)) {
      model.input_modalities = arch.input_modalities.filter((m): m is string => typeof m === 'string');
    }
    result.push(model);
  }
  return result;
}

export async function fetchBackendProviderModels(
  baseUrl: string,
  apiProtocol: string,
  apiKey?: string,
  options?: FetchModelsOptions
): Promise<DiscoveredModel[]> {
  const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
  if (!cleanUrl) throw new Error('Base URL is required');

  const effectiveFetch = options?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!effectiveFetch) throw new Error('Fetch API is not available');

  const timeoutMs = options?.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options?.signal ?? controller.signal;

  try {
    let targetUrl: string;
    const headers: Record<string, string> = { Accept: 'application/json' };
    const hasRealKey = Boolean(apiKey && apiKey.trim() && !apiKey.trim().startsWith('$'));

    if (apiProtocol === 'google-generative-ai') {
      targetUrl = hasRealKey ? `${cleanUrl}/models?key=${encodeURIComponent(apiKey!.trim())}` : `${cleanUrl}/models`;
    } else if (apiProtocol === 'anthropic-messages') {
      targetUrl = cleanUrl.endsWith('/models') ? cleanUrl : `${cleanUrl}/models`;
      headers['anthropic-version'] = '2023-06-01';
      if (hasRealKey) headers['x-api-key'] = apiKey!.trim();
    } else {
      if (cleanUrl.endsWith('/models') || cleanUrl.endsWith('/tags')) targetUrl = cleanUrl;
      else if (cleanUrl.includes(':11434') && !cleanUrl.includes('/v1')) targetUrl = `${cleanUrl}/v1/models`;
      else targetUrl = `${cleanUrl}/models`;
      if (hasRealKey) headers['Authorization'] = `Bearer ${apiKey!.trim()}`;
    }

    const res = await effectiveFetch(targetUrl, { headers, signal });
    if (!res.ok) throw new Error(`API returned HTTP ${res.status}: ${res.statusText}`);

    const payload = await res.json();
    clearTimeout(timeoutId);

    const parsed = parseModelsPayload(payload);
    if (parsed.length === 0) throw new Error('No models found in the API response');

    // Enrich with OpenRouter catalog if available
    try {
      const catalogFetch = options?.catalogFetchFn ?? effectiveFetch;
      const catRes = await catalogFetch(OPENROUTER_MODELS_URL, { headers: { Accept: 'application/json' } });
      if (catRes.ok) {
        const catData = (await catRes.json()) as { data?: Array<{ id: string; architecture?: { input_modalities?: string[] } }> };
        if (Array.isArray(catData?.data)) {
          const modMap = new Map<string, string[]>();
          for (const entry of catData.data) {
            if (entry.id && Array.isArray(entry.architecture?.input_modalities)) {
              modMap.set(normalizeModelSlug(entry.id), entry.architecture.input_modalities);
            }
          }
          for (const m of parsed) {
            const mods = modMap.get(normalizeModelSlug(m.id));
            if (mods && !m.input_modalities) m.input_modalities = mods;
          }
        }
      }
    } catch {}

    return parsed;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error) {
      if (err.name === 'AbortError') throw new Error(`Request timed out while connecting to ${cleanUrl}`);
      throw err;
    }
    throw new Error(String(err));
  }
}
