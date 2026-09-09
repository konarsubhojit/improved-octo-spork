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
