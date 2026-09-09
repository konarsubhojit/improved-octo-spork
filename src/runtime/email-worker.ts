import { createOraclePool } from '../store/oracle.js';
import { OracleAppRepository } from '../store/oracleApp.js';
import { AppService } from '../app/service.js';
import { GmailMailer } from '../services/smtp.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
if (config.role !== 'email-worker' || !config.database || !config.gmail) {
  throw new Error('This entrypoint requires PROCESS_ROLE=email-worker');
}

const pool = await createOraclePool(config.database);
const service = new AppService(new OracleAppRepository(pool), new GmailMailer(config.gmail));
const intervalMs = 10_000;
const batchSize = 50;
let stopped = false;

async function tick() {
  if (stopped) return;
  const processed = await service.emailWorkerTick(batchSize);
  if (processed > 0) process.stdout.write(`email worker processed ${processed} notification(s)\n`);
}

const timer = setInterval(() => {
  void tick().catch((error: unknown) => process.stderr.write(`email worker tick failed: ${String(error)}\n`));
}, intervalMs);

void tick().catch((error: unknown) => process.stderr.write(`email worker startup failed: ${String(error)}\n`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopped = true;
    clearInterval(timer);
    void pool.close(5).finally(() => process.exit(0));
  });
}
