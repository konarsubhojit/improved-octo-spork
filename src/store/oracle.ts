import oracledb from 'oracledb';
import type { HeartbeatResult, HeartbeatStore, HeartbeatSubmission } from '../services/heartbeat.js';

export interface OracleSettings {
  user: string;
  password: string;
  connectString: string;
  poolMin?: number;
  poolMax?: number;
}

export async function createOraclePool(settings: OracleSettings): Promise<oracledb.Pool> {
  return oracledb.createPool({
    user: settings.user,
    password: settings.password,
    connectString: settings.connectString,
    poolMin: settings.poolMin ?? 0,
    poolMax: settings.poolMax ?? 3,
    poolIncrement: 1,
    queueTimeout: 5_000
  });
}

export class OracleHeartbeatStore implements HeartbeatStore {
  constructor(private readonly pool: oracledb.Pool) {}

  async record(submission: HeartbeatSubmission): Promise<HeartbeatResult> {
    const connection = await this.pool.getConnection();
    try {
      const credential = await connection.execute<{ WORKSPACE_ID: string; MONITOR_ID: string }>(
        `SELECT workspace_id, monitor_id
           FROM heartbeat_credentials
          WHERE token_hash = HEXTORAW(:token_hash)
            AND revoked_at IS NULL
          FOR UPDATE`,
        { token_hash: submission.tokenHash },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const row = credential.rows?.[0];
      if (!row) {
        await connection.rollback();
        return { accepted: false, duplicate: false };
      }
      if (submission.eventId) {
        const duplicate = await connection.execute(
          `SELECT 1 FROM heartbeat_receipts
            WHERE workspace_id = :workspace_id AND monitor_id = :monitor_id AND event_id = :event_id`,
          { workspace_id: row.WORKSPACE_ID, monitor_id: row.MONITOR_ID, event_id: submission.eventId }
        );
        if (duplicate.rows?.length) {
          await connection.rollback();
          return { accepted: true, duplicate: true };
        }
      }
      const monitor = await connection.execute<{ DEADLINE_VERSION: number }>(
        `SELECT deadline_version FROM monitors
          WHERE workspace_id = :workspace_id AND monitor_id = :monitor_id
            AND mode = 'push' AND paused_at IS NULL AND deleted_at IS NULL
          FOR UPDATE`,
        { workspace_id: row.WORKSPACE_ID, monitor_id: row.MONITOR_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const current = monitor.rows?.[0];
      if (!current) {
        await connection.rollback();
        return { accepted: false, duplicate: false };
      }
      await connection.execute(
        `INSERT INTO heartbeat_receipts(
           workspace_id, monitor_id, receipt_id, event_id, received_at, deadline_version
         ) VALUES (
           :workspace_id, :monitor_id, RAWTOHEX(SYS_GUID()), :event_id, :received_at, :deadline_version
         )`,
        {
          workspace_id: row.WORKSPACE_ID,
          monitor_id: row.MONITOR_ID,
          event_id: submission.eventId ?? null,
          received_at: submission.receivedAt,
          deadline_version: current.DEADLINE_VERSION + 1
        }
      );
      await connection.execute(
        `UPDATE monitors
            SET last_evidence_at = :received_at, state = 'healthy',
                deadline_version = deadline_version + 1
          WHERE workspace_id = :workspace_id AND monitor_id = :monitor_id
            AND deadline_version = :deadline_version`,
        {
          received_at: submission.receivedAt,
          workspace_id: row.WORKSPACE_ID,
          monitor_id: row.MONITOR_ID,
          deadline_version: current.DEADLINE_VERSION
        }
      );
      await connection.commit();
      return { accepted: true, duplicate: false };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  }
}
