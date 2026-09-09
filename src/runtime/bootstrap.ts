import { createOraclePool } from '../store/oracle.js';
import { OracleAppRepository } from '../store/oracleApp.js';
import { AppService } from '../app/service.js';
import { FakeMailer } from '../services/smtp.js';
import { loadConfig } from './config.js';

const config = loadConfig({ ...process.env, PROCESS_ROLE: 'scheduler' });
if (!config.database) throw new Error('Bootstrap requires Oracle credentials');

const workspaceId = process.argv[2];
const workspaceName = process.argv[3];
const email = process.argv[4];
if (!workspaceId || !workspaceName || !email) {
  throw new Error('Usage: tsx src/runtime/bootstrap.ts <workspace-id> <workspace-name> <invite-email>');
}

const pool = await createOraclePool(config.database);
const repository = new OracleAppRepository(pool);
const service = new AppService(repository, new FakeMailer(true));

try {
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `MERGE INTO workspaces w
       USING (SELECT :workspace_id workspace_id, :name name FROM dual) x
       ON (w.workspace_id = x.workspace_id)
       WHEN NOT MATCHED THEN
         INSERT (workspace_id, name) VALUES (x.workspace_id, x.name)`,
      { workspace_id: workspaceId, name: workspaceName }
    );
    await connection.commit();
  } finally {
    await connection.close();
  }

  const token = await service.createInvite(workspaceId, email);
  process.stdout.write(`Invite token (show once): ${token}\n`);
} finally {
  await pool.close(5);
}
