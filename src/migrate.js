import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPool } from './db.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// Arbitrary constant: every process that migrates takes the same advisory lock, so two
// instances starting together cannot apply the same file twice.
const MIGRATION_LOCK = 724100;

/** Applies pending migrations in filename order, each in its own transaction. Returns applied names. */
export const migrate = async (pool) => {
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
        const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
        const applied = [];
        for (const file of files) {
            if (done.has(file)) continue;
            const sql = await readFile(join(migrationsDir, file), 'utf8');
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw new Error(`Migration ${file} failed: ${error.message}`);
            }
            applied.push(file);
        }
        return applied;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
        client.release();
    }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const pool = createPool();
    try {
        const applied = await migrate(pool);
        console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date.');
    } finally {
        await pool.end();
    }
}
