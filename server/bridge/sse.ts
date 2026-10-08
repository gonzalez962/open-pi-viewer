import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) Client Manager
// ---------------------------------------------------------------------------

const sseClients = new Map<ServerResponse, { owner?: string; authorized?: () => boolean }>();

export function addSseClient(res: ServerResponse, owner?: string, authorized?: () => boolean): void {
  sseClients.set(res, { owner, authorized });
}

export function removeSseClient(res: ServerResponse): void {
  sseClients.delete(res);
}

export function broadcastSse(event: string, payload: any, owner?: string): void {
  // Authentication prompts must never fall back to the shared event stream.
  if (event === 'pi://oauth-event' && !owner) return;
  const data = `data: ${JSON.stringify({ event, payload })}\n\n`;
  for (const [client, session] of sseClients) {
    if (owner && (owner !== session.owner || (session.authorized && !session.authorized()))) continue;
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}
