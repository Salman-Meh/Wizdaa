/**
 * SQLite Database Connection
 * Initializes and manages the database connection using better-sqlite3
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { Migrator } from './migrator';
import migrations from './migrations';

class DatabaseConnection {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string = process.env.DB_PATH || './data/timeoff.db') {
    this.dbPath = dbPath;
  }

  /**
   * Initialize database connection and run migrations
   */
  async initialize(): Promise<void> {
    try {
      // Create data directory if needed (skip for in-memory)
      if (this.dbPath !== ':memory:') {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      // Open database
      this.db = new Database(this.dbPath);

      // Enable foreign keys
      this.db.pragma('foreign_keys = ON');

      // Run migrations
      const migrator = new Migrator(this.db);
      const result = migrator.run(migrations);

      if (result.applied.length > 0) {
        console.log(`✓ Database initialized at ${this.dbPath} (${result.applied.length} migrations applied)`);
      } else {
        console.log(`✓ Database initialized at ${this.dbPath} (up to date)`);
      }
    } catch (error) {
      console.error('Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * Get database instance
   */
  getDatabase(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      console.log('✓ Database connection closed');
    }
  }

  /**
   * Check if database is initialized
   */
  isInitialized(): boolean {
    return this.db !== null;
  }

  /**
   * Reset database (for testing)
   */
  async reset(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // For in-memory databases, truncate all tables instead of recreating
    if (this.dbPath === ':memory:') {
      try {
        // Disable foreign key constraints temporarily to allow truncation
        this.db.pragma('foreign_keys = OFF');

        // Get all table names and truncate them
        const tables = this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as any[];

        for (const table of tables) {
          this.db.exec(`DELETE FROM ${table.name}`);
        }

        // Re-enable foreign keys
        this.db.pragma('foreign_keys = ON');
      } catch (error) {
        console.error('Failed to reset in-memory database:', error);
        throw error;
      }
    } else {
      // For file-based databases, close and reopen
      this.db.close();
      this.db = null;

      // Delete database file if it exists
      if (fs.existsSync(this.dbPath)) {
        fs.unlinkSync(this.dbPath);
      }

      // Re-initialize
      await this.initialize();
    }
  }
}

export { DatabaseConnection };
export default DatabaseConnection;
