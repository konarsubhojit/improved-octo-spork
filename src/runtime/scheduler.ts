import { createOraclePool } from '../store/oracle.js';
import { OracleAppRepository } from '../store/oracleApp.js';
import { AppService } from '../app/service.js';
import { FakeMailer } from '../services/smtp.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
if (config.role !== 'scheduler' || !config.database) throw new Error('This entrypoint requires PROCESS_ROLE=scheduler');

const pool = await createOraclePool(config.database);
const service = new AppService(new OracleAppRepository(pool), new FakeMailer(true));
const intervalMs = 10_000;
const batchSize = 100;
let stopped = false;

async function tick() {
  if (stopped) return;
  const processed = await service.schedulerTick(batchSize);
  if (processed > 0) process.stdout.write(`scheduler queued ${processed} notification(s)\n`);
}

const timer = setInterval(() => {
  void tick().catch((error: unknown) => process.stderr.write(`scheduler tick failed: ${String(error)}\n`));
}, intervalMs);

void tick().catch((error: unknown) => process.stderr.write(`scheduler startup failed: ${String(error)}\n`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopped = true;
    clearInterval(timer);
    void pool.close(5).finally(() => process.exit(0));
  });
}
