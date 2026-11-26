import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashKey } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger_test';

/**
 * Fresh schema per test: DROP SCHEMA bypasses the audit log's TRUNCATE trigger, so no test needs
 * (or gets) a way around the append-only rule.
 */
export const startLedger = async () => {
    const pool = createPool(TEST_DB);
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    const server = await new Promise((resolve) => { const s = createApp({ pool, log: () => {} }).listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const close = async () => {
        await new Promise((resolve) => server.close(resolve));
        await pool.end();
    };
    return { pool, base, close };
};

/** Creates a tenant with one raw API key per role. */
export const createTenant = async (pool, name = 'Tenant') => {
    const { rows: [tenant] } = await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name]);
    const keys = {};
    for (const role of ['viewer', 'operator', 'admin']) {
        const raw = `test_${role}_${randomBytes(12).toString('hex')}`;
        await pool.query('INSERT INTO api_keys (tenant_id, key_hash, role, label) VALUES ($1, $2, $3, $4)',
            [tenant.id, hashKey(raw), role, `${name} ${role}`]);
        keys[role] = raw;
    }
    return { tenantId: tenant.id, keys };
};

export const client = (base, key) => {
    const call = async (method, path, body, headers = {}) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    };
    return {
        get: (path) => call('GET', path),
        post: (path, body, headers) => call('POST', path, body, headers),
        transfer: (body, idempotencyKey = randomBytes(8).toString('hex')) =>
            call('POST', '/v1/transfers', body, { 'idempotency-key': idempotencyKey }),
    };
};

export const openAccount = async (base, adminKey, { name = 'Account', currency = 'PHP', openingBalance = 0 } = {}) => {
    const res = await client(base, adminKey).post('/v1/accounts', { name, currency, openingBalance });
    if (res.status !== 201) throw new Error(`openAccount failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
};

export const count = async (pool, sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);
