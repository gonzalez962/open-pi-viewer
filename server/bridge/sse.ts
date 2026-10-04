import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) Client Manager
// ---------------------------------------------------------------------------

const sseClients = new Set<ServerResponse>();

export function addSseClient(res: ServerResponse): void {
  sseClients.add(res);
}

export function removeSseClient(res: ServerResponse): void {
  sseClients.delete(res);
}

export function broadcastSse(event: string, payload: any): void {
  const data = `data: ${JSON.stringify({ event, payload })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}
