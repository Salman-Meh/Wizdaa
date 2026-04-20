/**
 * Migrator
 * Tracks and runs database migrations in order.
 * Creates a _migrations table to record applied migrations.
 */

import Database from 'better-sqlite3';

export interface Migration {
  name: string;
  up: (db: Database.Database) => void;
  down: (db: Database.Database) => void;
}

export class Migrator {
  constructor(private db: Database.Database) {}

  /**
   * Ensure the migrations tracking table exists
   */
  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Get list of already-applied migration names
   */
  private getApplied(): Set<string> {
    this.ensureTable();
    const rows = this.db.prepare('SELECT name FROM _migrations ORDER BY id ASC').all() as any[];
    return new Set(rows.map((r) => r.name));
  }

  /**
   * Run all pending migrations
   */
  run(migrations: Migration[]): { applied: string[]; skipped: string[] } {
    const applied: string[] = [];
    const skipped: string[] = [];
    const alreadyApplied = this.getApplied();

    for (const migration of migrations) {
      if (alreadyApplied.has(migration.name)) {
        skipped.push(migration.name);
        continue;
      }

      try {
        migration.up(this.db);

        this.db.prepare(
          'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)'
        ).run(migration.name, new Date().toISOString());

        applied.push(migration.name);
        console.log(`  ✓ Migration applied: ${migration.name}`);
      } catch (error) {
        console.error(`  ✗ Migration failed: ${migration.name}`, error);
        throw error;
      }
    }

    return { applied, skipped };
  }
}
