import { createHash } from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError, errorBody } from './http.js';

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Sorts object keys recursively so semantically equal JSON bodies hash the same. */
const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
};

export const requestHash = (method, path, body) =>
    createHash('sha256').update(`${method} ${path}\n${JSON.stringify(canonical(body ?? null))}`).digest('hex');

export const readIdempotencyKey = (req) => {
    const key = req.get('idempotency-key');
    if (key === undefined) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'This endpoint requires an Idempotency-Key header.');
    if (!KEY_PATTERN.test(key)) throw new ApiError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 1-255 printable ASCII characters.');
    return key;
};

/**
 * Runs `work(client)` at most once per (tenant, key).
 *
 * Everything happens in one transaction. The INSERT on the (tenant_id, key) primary key is the
 * serialization point: a concurrent request with the same key blocks on that row until the first
 * transaction commits or rolls back.
 *  - Committed: the INSERT conflicts, and the stored response is replayed (or 422 if the body differs).
 *  - Rolled back (crash, 5xx): the row disappears, so the waiting request runs the work itself.
 *
 * Client errors (4xx ApiError) are part of the stored result: replaying a request that failed
 * with INSUFFICIENT_FUNDS returns the same 422 even if the account was topped up since.
 * Returns { status, body, replayed }.
 */
export const runIdempotent = (pool, { tenantId, key, hash, successStatus = 201 }, work) =>
    withTransaction(pool, async (client) => {
        // The response columns are NOT NULL, so the row is inserted with a placeholder and
        // updated before commit; other transactions never see the placeholder.
        const inserted = await client.query(
            `INSERT INTO idempotency_keys (tenant_id, key, request_hash, response_status, response_body)
             VALUES ($1, $2, $3, 0, 'null') ON CONFLICT (tenant_id, key) DO NOTHING`,
            [tenantId, key, hash]);

        if (inserted.rowCount === 0) {
            const { rows: [stored] } = await client.query(
                'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND key = $2',
                [tenantId, key]);
            if (stored.request_hash !== hash) {
                throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
            }
            return { status: stored.response_status, body: stored.response_body, replayed: true };
        }

        let result;
        await client.query('SAVEPOINT idempotent_work');
        try {
            result = { status: successStatus, body: await work(client) };
        } catch (error) {
            if (!(error instanceof ApiError) || error.status >= 500) throw error;
            // Undo the partial work but keep the key row, so the client error is recorded.
            await client.query('ROLLBACK TO SAVEPOINT idempotent_work');
            result = { status: error.status, body: errorBody(error) };
        }
        await client.query(
            'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE tenant_id = $1 AND key = $2',
            [tenantId, key, result.status, JSON.stringify(result.body)]);
        return { ...result, replayed: false };
    });
