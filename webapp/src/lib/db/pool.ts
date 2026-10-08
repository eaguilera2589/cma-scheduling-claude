/**
 * Postgres connection pool for the DB data source (DATA_SOURCE=db).
 *
 * Lazily created from DATABASE_URL so that a sheet-mode (prod) process never
 * requires this module or touches pg: the repository/pool are only imported
 * dynamically behind the DATA_SOURCE flag in lib/dataSource.ts.
 */
import { Pool } from 'pg';

let pool: Pool | undefined;

/** Lazily build (and memoize) the pool from DATABASE_URL. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. It is required when DATA_SOURCE=db (see infra/.env.staging).'
      );
    }
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

/** Close the pool (used by one-shot scripts; the server leaves it open). */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
