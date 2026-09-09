/**
 * Static audit helper for Oracle reserved words used as *identifiers* (table, column, index and
 * alias names) in this repository's handwritten SQL.
 *
 * Why this exists: `migrations/001_mvp.sql` originally declared a `monitors.mode` column, which
 * Oracle rejects with `ORA-03050: invalid identifier: "MODE" is a reserved word`
 * (https://docs.oracle.com/error-help/db/ora-03050/). A reserved word may only be used as an
 * identifier when it is double-quoted, which then makes every reference case-sensitive and quoted
 * forever; renaming the physical column is the safer fix. This module lets the test-suite prove,
 * against the real SQL text, that no reserved word is used as an unquoted identifier.
 *
 * Sources for the word list (checked against the Oracle SQL Language Reference appendix
 * "Oracle SQL Reserved Words", which is stable across 19c/21c/23ai/26ai for these words):
 *   - https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Oracle-SQL-Reserved-Words.html
 *   - https://docs.oracle.com/error-help/db/ora-03050/
 * The authoritative, version-specific list for a *live* database is `V$RESERVED_WORDS`
 * (https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/V-RESERVED_WORDS.html);
 * see migrations/README.md for opt-in, read-only instructions. This file is a static copy, so it
 * cannot know about words a specific release/edition reserves in addition to the documented list.
 */

/** Oracle SQL reserved words: never valid as an unquoted identifier. */
export const ORACLE_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'ACCESS', 'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'AUDIT', 'BETWEEN', 'BY', 'CHAR',
  'CHECK', 'CLUSTER', 'COLUMN', 'COMMENT', 'COMPRESS', 'CONNECT', 'CREATE', 'CURRENT', 'DATE',
  'DECIMAL', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'EXCLUSIVE', 'EXISTS',
  'FILE', 'FLOAT', 'FOR', 'FROM', 'GRANT', 'GROUP', 'HAVING', 'IDENTIFIED', 'IMMEDIATE', 'IN',
  'INCREMENT', 'INDEX', 'INITIAL', 'INSERT', 'INTEGER', 'INTERSECT', 'INTO', 'IS', 'LEVEL', 'LIKE',
  'LOCK', 'LONG', 'MAXEXTENTS', 'MINUS', 'MLSLABEL', 'MODE', 'MODIFY', 'NOAUDIT', 'NOCOMPRESS',
  'NOT', 'NOWAIT', 'NULL', 'NUMBER', 'OF', 'OFFLINE', 'ON', 'ONLINE', 'OPTION', 'OR', 'ORDER',
  'PCTFREE', 'PRIOR', 'PUBLIC', 'RAW', 'RENAME', 'RESOURCE', 'REVOKE', 'ROW', 'ROWID', 'ROWNUM',
  'ROWS', 'SELECT', 'SESSION', 'SET', 'SHARE', 'SIZE', 'SMALLINT', 'START', 'SUCCESSFUL',
  'SYNONYM', 'SYSDATE', 'TABLE', 'THEN', 'TO', 'TRIGGER', 'UID', 'UNION', 'UNIQUE', 'UPDATE',
  'USER', 'VALIDATE', 'VALUES', 'VARCHAR', 'VARCHAR2', 'VIEW', 'WHENEVER', 'WHERE', 'WITH'
]);

/**
 * Reserved words that are legitimately *referenced* (never declared) in this repository's SQL as
 * pseudocolumns/keywords rather than as identifiers, e.g. `WHERE ROWNUM = 1`. They are excluded
 * from operand scanning only; a declaration of a column with one of these names is still reported.
 */
const KEYWORD_OPERANDS: ReadonlySet<string> = new Set(['ROWNUM', 'ROWID', 'LEVEL', 'SYSDATE', 'USER', 'UID', 'NULL', 'DEFAULT']);

export interface ReservedIdentifierFinding {
  /** The offending word, uppercased. */
  identifier: string;
  /** Where it was used (e.g. `column of CREATE TABLE MONITORS`). */
  context: string;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_$#]*';

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Replaces `"..."` quoted identifiers with a placeholder: quoting a reserved word is legal. */
function blankQuotedIdentifiers(sql: string): string {
  return sql.replace(/"[^"]*"/g, 'quoted_identifier');
}

function stringLiterals(sql: string): string[] {
  return [...sql.matchAll(/'(?:[^']|'')*'/g)].map((match) => match[0].slice(1, -1).replace(/''/g, "'"));
}

function blankStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Splits a parenthesised list body on top-level commas. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Returns the body of the parenthesised group that starts at `open` (index of `(`). */
function parenBody(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return sql.slice(open + 1);
}

function report(findings: ReservedIdentifierFinding[], word: string | undefined, context: string): void {
  if (!word) return;
  const upper = word.toUpperCase();
  if (!ORACLE_RESERVED_WORDS.has(upper)) return;
  findings.push({ identifier: upper, context });
}

const CONSTRAINT_START = /^\s*(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;

function scanCreateTable(sql: string, findings: ReservedIdentifierFinding[]): void {
  const pattern = new RegExp(`\\bCREATE\\s+TABLE\\s+(${IDENT})\\s*\\(`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    const table = match[1]!;
    report(findings, table, `table name of CREATE TABLE ${table.toUpperCase()}`);
    const body = parenBody(sql, match.index! + match[0].length - 1);
    for (const part of splitTopLevel(body)) {
      if (CONSTRAINT_START.test(part)) {
        // Key/constraint clauses reference columns declared elsewhere in the same statement.
        continue;
      }
      const column = new RegExp(`^\\s*(${IDENT})`).exec(part)?.[1];
      report(findings, column, `column of CREATE TABLE ${table.toUpperCase()}`);
    }
  }
}

function scanCreateIndex(sql: string, findings: ReservedIdentifierFinding[]): void {
  const pattern = new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(${IDENT})\\s+ON\\s+(${IDENT})`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    report(findings, match[1], `index name of CREATE INDEX ${match[1]!.toUpperCase()}`);
    report(findings, match[2], `indexed table of CREATE INDEX ${match[1]!.toUpperCase()}`);
  }
}

function scanAlterTable(sql: string, findings: ReservedIdentifierFinding[]): void {
  const rename = new RegExp(`\\bALTER\\s+TABLE\\s+(${IDENT})\\s+RENAME\\s+COLUMN\\s+(${IDENT})\\s+TO\\s+(${IDENT})`, 'gi');
  for (const match of sql.matchAll(rename)) {
    report(findings, match[1], 'table name of ALTER TABLE');
    report(findings, match[2], 'source column of ALTER TABLE RENAME COLUMN');
    report(findings, match[3], 'target column of ALTER TABLE RENAME COLUMN');
  }
  const addModify = new RegExp(`\\bALTER\\s+TABLE\\s+(${IDENT})\\s+(?:ADD|MODIFY)\\s*\\(?\\s*(${IDENT})`, 'gi');
  for (const match of sql.matchAll(addModify)) {
    report(findings, match[1], 'table name of ALTER TABLE');
    report(findings, match[2], 'column of ALTER TABLE ADD/MODIFY');
  }
}

function scanInsert(sql: string, findings: ReservedIdentifierFinding[]): void {
  const pattern = new RegExp(`\\bINSERT\\s+INTO\\s+(${IDENT})\\s*\\(`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    const table = match[1]!;
    report(findings, table, `table name of INSERT INTO ${table.toUpperCase()}`);
    const body = parenBody(sql, match.index! + match[0].length - 1);
    for (const part of splitTopLevel(body)) {
      const column = new RegExp(`^\\s*(${IDENT})\\s*$`).exec(part)?.[1];
      report(findings, column, `column list of INSERT INTO ${table.toUpperCase()}`);
    }
  }
}

function scanTableReferences(sql: string, findings: ReservedIdentifierFinding[]): void {
  const pattern = new RegExp(`\\b(FROM|JOIN|UPDATE|MERGE\\s+INTO|INSERT\\s+INTO)\\s+(${IDENT})`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    report(findings, match[2], `table reference after ${match[1]!.toUpperCase()}`);
  }
}

/** Column names and aliases in a select list, e.g. `SELECT a, b AS c FROM t`. */
function scanSelectList(sql: string, findings: ReservedIdentifierFinding[]): void {
  for (const match of sql.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi)) {
    for (const rawItem of splitTopLevel(match[1]!)) {
      const item = rawItem.trim();
      if (!item || item === '*') continue;
      const plain = new RegExp(`^(?:${IDENT}\\.)?(${IDENT})$`).exec(item)?.[1];
      if (plain) {
        report(findings, plain, 'select-list column');
        continue;
      }
      const alias = new RegExp(`(?:\\bAS\\s+)?(${IDENT})\\s*$`).exec(item)?.[1];
      if (alias) report(findings, alias, 'select-list alias');
    }
  }
}

/** Left-hand identifiers of predicates and assignments, e.g. `WHERE mode = 'push'`. */
function scanOperands(sql: string, findings: ReservedIdentifierFinding[]): void {
  const pattern = new RegExp(`(?<![:.\\w$#])(?:(${IDENT})\\.)?(${IDENT})\\s*(?:=|!=|<>|<=|>=|<|>|\\bIS\\b|\\bIN\\b|\\bLIKE\\b)`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    const word = match[2]!;
    if (KEYWORD_OPERANDS.has(word.toUpperCase())) continue;
    report(findings, word, 'predicate/assignment operand');
  }
}

/**
 * Reports every Oracle reserved word used as an unquoted identifier in `sql`. SQL embedded in
 * single-quoted PL/SQL literals (how `migrations/*.sql` carries its `EXECUTE IMMEDIATE` DDL) is
 * unescaped and scanned recursively.
 *
 * Limitations: this is a targeted scanner for the SQL subset this repository writes by hand, not a
 * SQL parser. Index key *expressions*, dynamic identifier concatenation, and words a specific
 * Oracle release reserves beyond the documented list are out of scope.
 */
export function findReservedIdentifiers(sql: string): ReservedIdentifierFinding[] {
  const text = blankQuotedIdentifiers(stripComments(sql));
  const findings: ReservedIdentifierFinding[] = [];

  for (const literal of stringLiterals(text)) {
    if (/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|MERGE|SELECT)\b/i.test(literal)) {
      findings.push(...findReservedIdentifiers(literal));
    }
  }

  const code = blankStringLiterals(text);
  scanCreateTable(code, findings);
  scanCreateIndex(code, findings);
  scanAlterTable(code, findings);
  scanInsert(code, findings);
  scanTableReferences(code, findings);
  scanSelectList(code, findings);
  scanOperands(code, findings);

  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.identifier}|${finding.context}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extracts SQL text from backtick template literals in a TypeScript source file, so the same
 * reserved-word audit can be applied to the runtime queries (which are not in `.sql` files).
 */
export function extractSqlLiteralsFromSource(source: string): string[] {
  return [...source.matchAll(/`([^`]*)`/g)]
    .map((match) => match[1]!)
    .filter((text) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(text));
}
