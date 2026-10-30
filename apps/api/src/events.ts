import type { ServerResponse } from 'node:http';
import type { DB } from './database.js';
import { listNodes, overview } from './nodes.js';

export class EventHub {
  private clients = new Map<ServerResponse, { session: string; expiresAt: number }>();
  constructor(private db: DB, private now: () => number) {}
  add(response: ServerResponse, session: string, expiresAt: number) {
    this.clients.set(response, { session, expiresAt });
    response.on('close', () => this.clients.delete(response));
    response.write('retry: 3000\n\n');
    this.writeSnapshot(response);
  }
  private writeSnapshot(response: ServerResponse, data?: string) {
    if (!data) {
      const nodes = listNodes(this.db, this.now());
      data = JSON.stringify({ nodes, overview: overview(nodes) });
    }
    if (!response.write(`event: snapshot\ndata: ${data}\n\n`)) {
      response.end(); this.clients.delete(response);
    }
  }
  broadcast() {
    if (!this.clients.size) return;
    const now = this.now();
    const nodes = listNodes(this.db, now), data = JSON.stringify({ nodes, overview: overview(nodes) });
    for (const [response, client] of this.clients) {
      if (client.expiresAt <= now || !this.db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(client.session)) {
        response.end(); this.clients.delete(response); continue;
      }
      this.writeSnapshot(response, data);
    }
  }
  close() { for (const response of this.clients.keys()) response.end(); this.clients.clear(); }
}
