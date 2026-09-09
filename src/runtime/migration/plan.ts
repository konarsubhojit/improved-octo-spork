/** Pure helpers for deciding which migration files to apply. No I/O, no Oracle imports. */

export interface MigrationFile {
  name: string;
  version: number;
}

/**
 * Parses and orders migration file names of the form `<version>_<label>.sql`.
 * Non-matching file names are ignored (e.g. README.md).
 */
export function parseMigrationFileNames(names: string[]): MigrationFile[] {
  return names
    .map((name) => ({ name, match: /^(\d+)_.*\.sql$/.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => !!item.match)
    .map((item) => ({ name: item.name, version: Number(item.match[1]) }))
    .sort((left, right) => left.version - right.version);
}

/** Returns migration files that have not yet been recorded in `schema_migrations`, in order. */
export function pendingMigrations(files: MigrationFile[], appliedVersions: ReadonlySet<number>): MigrationFile[] {
  return files.filter((file) => !appliedVersions.has(file.version));
}
