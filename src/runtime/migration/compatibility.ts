/**
 * Pure decision rules mirrored by the `ORA-00955` ("name already used") exception handlers
 * embedded in `migrations/001_mvp.sql`. Documented and unit-tested here as the single source of
 * truth for what "already applied and safe to skip" means for a colliding object name; the actual
 * PL/SQL in the migration file re-implements the same rules because it alone runs when a script
 * is applied directly (SQLcl / SQL Developer "Run Script") without this repository's code.
 *
 * These rules are intentionally narrow: they check object *type* and (for tables) *column count*
 * only. They are not a full DDL/definition diff (column types, defaults, constraints, and index
 * key columns are not compared). See migrations/README.md for the documented limits.
 */

export type ExpectedObject =
  | { kind: 'table'; name: string; expectedColumnCount: number }
  | { kind: 'index'; name: string; expectedTable: string };

export interface ExistingObjectLookup {
  /** Oracle `USER_OBJECTS.OBJECT_TYPE` for the colliding name; `undefined` if not visible at all. */
  objectType?: string;
  /** For tables: the `USER_TAB_COLUMNS` count for the existing table. Ignored for indexes. */
  columnCount?: number;
  /** For indexes: whether an index with this name exists on the expected table. Ignored for tables. */
  indexOnExpectedTable?: boolean;
}

export type CompatibilityResult = { status: 'compatible' } | { status: 'incompatible'; reason: string };

export function classifyExistingObject(expected: ExpectedObject, existing: ExistingObjectLookup): CompatibilityResult {
  if (existing.objectType === undefined) {
    return {
      status: 'incompatible',
      reason: `${expected.name} is already used but not visible in USER_OBJECTS; cannot verify compatibility.`
    };
  }

  if (expected.kind === 'table') {
    if (existing.objectType !== 'TABLE') {
      return { status: 'incompatible', reason: `${expected.name} already exists as ${existing.objectType}, expected TABLE.` };
    }
    if (existing.columnCount !== expected.expectedColumnCount) {
      return {
        status: 'incompatible',
        reason: `table ${expected.name} already exists with ${existing.columnCount} column(s), expected ${expected.expectedColumnCount}.`
      };
    }
    return { status: 'compatible' };
  }

  if (existing.objectType !== 'INDEX') {
    return { status: 'incompatible', reason: `${expected.name} already exists as ${existing.objectType}, expected INDEX.` };
  }
  if (!existing.indexOnExpectedTable) {
    return {
      status: 'incompatible',
      reason: `index ${expected.name} already exists but not on table ${expected.expectedTable}.`
    };
  }
  return { status: 'compatible' };
}

/**
 * Shape of the `MONITORS` monitor-mode column(s) as read from `USER_TAB_COLUMNS`. The physical
 * column is `MONITOR_MODE` because Oracle rejects `MODE` as an identifier
 * (ORA-03050, https://docs.oracle.com/error-help/db/ora-03050/); installs created before that
 * rename still carry the legacy `"MODE"` column.
 */
export interface MonitorModeColumn {
  dataType: string;
  charLength: number;
  nullable: boolean;
}

export interface MonitorModeState {
  /** The legacy `"MODE"` column, if present. */
  legacy?: MonitorModeColumn;
  /** The current `MONITOR_MODE` column, if present. */
  current?: MonitorModeColumn;
  /** Whether a CHECK constraint restricting the value to 'pull'/'push' exists on the table. */
  hasPullPushCheck: boolean;
}

export type MonitorModeDecision =
  /** `MONITOR_MODE` already present and valid: nothing to do. */
  | { action: 'none' }
  /** Only the legacy `"MODE"` column is present and valid: rename it in place, preserving data. */
  | { action: 'rename-legacy' }
  /** Ambiguous or incompatible: stop with an actionable error, never guess. */
  | { action: 'stop'; reason: string };

function isValidColumn(column: MonitorModeColumn): boolean {
  return column.dataType === 'VARCHAR2' && column.charLength === 8 && !column.nullable;
}

/**
 * Pure mirror of the `ensure_monitor_mode_column` PL/SQL procedure embedded in
 * `migrations/001_mvp.sql` and `migrations/002_monitor_mode.sql`, which alone runs when a script is
 * applied directly (SQLcl / SQL Developer "Run Script"). Both must stay in sync.
 */
export function classifyMonitorModeColumn(state: MonitorModeState): MonitorModeDecision {
  if (state.legacy && state.current) {
    return {
      action: 'stop',
      reason: 'table MONITORS has both the legacy "MODE" column and MONITOR_MODE; consolidate the values manually.'
    };
  }
  if (!state.legacy && !state.current) {
    return {
      action: 'stop',
      reason: 'table MONITORS has neither MONITOR_MODE nor a legacy "MODE" column.'
    };
  }

  const column = state.current ?? state.legacy!;
  const columnName = state.current ? 'MONITOR_MODE' : 'MODE';
  if (!isValidColumn(column)) {
    return { action: 'stop', reason: `MONITORS.${columnName} must be VARCHAR2(8) NOT NULL.` };
  }
  if (!state.hasPullPushCheck) {
    return {
      action: 'stop',
      reason: "MONITORS is missing a CHECK constraint restricting the monitor mode to 'pull'/'push'."
    };
  }
  return state.current ? { action: 'none' } : { action: 'rename-legacy' };
}
