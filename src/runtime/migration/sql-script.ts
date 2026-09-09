/**
 * Deliberately narrow SQL-script splitter for the handwritten `migrations/*.sql` files.
 *
 * This is NOT a general-purpose SQL parser. It only understands enough syntax to safely
 * separate the constructs actually used in this repository's migrations:
 *   - `--` line comments and `/* ... *\/` block comments
 *   - '...'-quoted string literals, with '' as an escaped quote
 *   - "..."-quoted identifiers
 *   - anonymous PL/SQL blocks (`DECLARE ... BEGIN ... END;` or `BEGIN ... END;`), including
 *     nested `BEGIN ... END` blocks and `IF ... END IF` / `LOOP ... END LOOP` constructs, which
 *     must not be split on their internal semicolons
 *   - plain SQL statements terminated by a top-level `;`
 *   - SQLcl/SQL*Plus-only conventions that must never be sent to the database driver: a lone
 *     `/` batch terminator line, and `SET ...` session commands
 *
 * Any construct outside this list (labelled blocks, nested quoting styles such as `q'[...]'`,
 * multiple statements per line mixing block/non-block syntax, etc.) is not supported. Prefer
 * keeping migrations within this subset over extending this splitter into a general parser.
 */

const WORD_CHAR = /[A-Za-z0-9_$#]/;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD_CHAR.test(ch);
}

/** True if `keyword` occurs at `pos` in `text` as a whole word (case-insensitive). */
function matchesKeywordAt(text: string, pos: number, keyword: string): boolean {
  if (text.slice(pos, pos + keyword.length).toUpperCase() !== keyword) return false;
  return !isWordChar(text[pos - 1]) && !isWordChar(text[pos + keyword.length]);
}

/** Returns the next whole word after `pos`, skipping whitespace, uppercased. */
function nextWordAfter(text: string, pos: number): string {
  let i = pos;
  const n = text.length;
  while (i < n && /\s/.test(text[i]!)) i += 1;
  const start = i;
  while (i < n && isWordChar(text[i])) i += 1;
  return text.slice(start, i).toUpperCase();
}

/** Strips comments (without altering length semantics we depend on) to test for "no real code yet". */
function hasNoCodeYet(text: string): boolean {
  const stripped = text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped.trim() === '';
}

export function splitSqlScript(script: string): string[] {
  const statements: string[] = [];
  const n = script.length;
  let i = 0;
  let out = '';

  // PL/SQL block tracking. `inPlSqlUnit` is set once the current top-level statement is
  // recognized (at its very start) as a DECLARE/BEGIN anonymous block; `depth` counts nested
  // BEGIN..END pairs (IF/LOOP/CASE END variants excluded); `sawBegin` distinguishes the
  // declare-section (no top-level BEGIN yet) from the executable section. A declared nested
  // procedure/function has its own BEGIN..END before the anonymous block's top-level BEGIN.
  let inPlSqlUnit = false;
  let depth = 0;
  let sawBegin = false;
  let inDeclaredSubprogram = false;

  const flush = () => {
    const trimmed = out.trim();
    out = '';
    inPlSqlUnit = false;
    depth = 0;
    sawBegin = false;
    inDeclaredSubprogram = false;
    if (!trimmed) return;
    if (/^\/$/.test(trimmed)) return; // SQLcl/SQL*Plus batch terminator, not SQL
    if (/^SET\s+\S/i.test(trimmed)) return; // SQLcl/SQL*Plus session command, not SQL
    statements.push(trimmed);
  };

  while (i < n) {
    const ch = script[i]!;

    // SQLcl/SQL*Plus batch terminator: a line containing only `/`, only meaningful between
    // statements (once the current statement text is empty). Consume the whole line and skip it
    // entirely rather than treating `/` as part of any statement.
    if (ch === '/' && out.trim() === '' && (i === 0 || script[i - 1] === '\n')) {
      const lineEnd = script.indexOf('\n', i);
      const stop = lineEnd === -1 ? n : lineEnd;
      if (script.slice(i, stop).trim() === '/') {
        i = stop;
        continue;
      }
    }

    // SQLcl/SQL*Plus session command (e.g. `SET DEFINE OFF`): only meaningful at the start of a
    // fresh statement, consumed and skipped as its own line rather than fed to the driver.
    if ((i === 0 || script[i - 1] === '\n') && hasNoCodeYet(out)) {
      const lineEnd = script.indexOf('\n', i);
      const stop = lineEnd === -1 ? n : lineEnd;
      if (/^SET\s+\S/i.test(script.slice(i, stop))) {
        i = stop;
        continue;
      }
    }

    if (ch === '-' && script[i + 1] === '-') {
      const end = script.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += script.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '/' && script[i + 1] === '*') {
      const end = script.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += script.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (script[j] === "'") {
          if (script[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += script.slice(i, j);
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < n && script[j] !== '"') j += 1;
      j = Math.min(j + 1, n);
      out += script.slice(i, j);
      i = j;
      continue;
    }

    if (!inPlSqlUnit && hasNoCodeYet(out) && (matchesKeywordAt(script, i, 'DECLARE') || matchesKeywordAt(script, i, 'BEGIN'))) {
      inPlSqlUnit = true;
      depth = 0;
      sawBegin = false;
    }

    if (inPlSqlUnit) {
      if (!sawBegin && (matchesKeywordAt(script, i, 'PROCEDURE') || matchesKeywordAt(script, i, 'FUNCTION'))) {
        inDeclaredSubprogram = true;
      } else if (matchesKeywordAt(script, i, 'BEGIN')) {
        depth += 1;
        if (!inDeclaredSubprogram) sawBegin = true;
      } else if (matchesKeywordAt(script, i, 'END')) {
        const nextWord = nextWordAfter(script, i + 3);
        if (nextWord !== 'IF' && nextWord !== 'LOOP' && nextWord !== 'CASE') {
          depth -= 1;
          if (!sawBegin && depth <= 0) inDeclaredSubprogram = false;
        }
      }
    }

    if (ch === ';') {
      if (inPlSqlUnit) {
        if (sawBegin && depth <= 0) {
          out += ch;
          flush();
          i += 1;
          continue;
        }
        // Declaration-section terminator or still-nested statement: keep accumulating.
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      flush();
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  flush();
  return statements;
}
