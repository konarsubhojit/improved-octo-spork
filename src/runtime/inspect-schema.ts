import oracledb from 'oracledb';
import { createOraclePool } from '../store/oracle.js';

const { ORACLE_USER: user, ORACLE_PASSWORD: password, ORACLE_CONNECT_STRING: connectString } = process.env;
if (!user || !password || !connectString) throw new Error('Schema inspection requires Oracle credentials');

const pool = await createOraclePool({ user, password, connectString });
try {
  const connection = await pool.getConnection();
  try {
    const columns = await connection.execute(
      `SELECT table_name, column_name, data_type, data_precision, data_scale
         FROM user_tab_columns
        WHERE table_name IN ('REMINDER_OCCURRENCES', 'CHECK_RUNS')
        ORDER BY table_name, column_id`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const constraints = await connection.execute(
      `SELECT c.table_name, c.constraint_type, cc.constraint_name, cc.position, cc.column_name
         FROM user_constraints c
         JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name
        WHERE c.table_name IN ('REMINDER_OCCURRENCES', 'CHECK_RUNS')
          AND c.constraint_type IN ('P', 'U')
        ORDER BY c.table_name, cc.constraint_name, cc.position`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    process.stdout.write(`${JSON.stringify({ columns: columns.rows ?? [], constraints: constraints.rows ?? [] }, null, 2)}\n`);
  } finally {
    await connection.close();
  }
} catch (error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
  process.stderr.write(`Schema inspection failed (${code}).\n`);
  process.exitCode = 1;
} finally {
  await pool.close(5);
}
