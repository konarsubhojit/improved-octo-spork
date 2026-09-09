import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createOraclePool, OracleHeartbeatStore } from '../store/oracle.js';
import { HeartbeatService } from '../services/heartbeat.js';

const config = loadConfig(process.env);
if (config.role !== 'ingress' || !config.database) throw new Error('This entrypoint requires PROCESS_ROLE=ingress');
const pool = await createOraclePool(config.database);
const service = new HeartbeatService(new OracleHeartbeatStore(pool));

const server = createServer((request, response) => {
  void (async () => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const match = /^\/h\/([A-Za-z0-9_-]{43})$/.exec(request.url ?? '');
    if (request.method !== 'POST' || !match?.[1]) {
      response.writeHead(404).end();
      request.resume();
      return;
    }
    const length = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(length) || length > 1024) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    let read = 0;
    for await (const chunk of request) {
      read += Buffer.byteLength(chunk);
      if (read > 1024) {
        response.writeHead(413).end();
        return;
      }
    }
    const eventHeader = request.headers['idempotency-key'];
    const eventId = typeof eventHeader === 'string' ? eventHeader : undefined;
    const result = await service.submit(match[1], eventId);
    response.writeHead(result.accepted ? 204 : 404).end();
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.listen(config.port, '127.0.0.1');
