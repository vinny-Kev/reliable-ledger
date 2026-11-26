import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { migrate } from '../src/migrate.js';
import { processOutboxBatch } from '../src/worker/outbox.js';
import { client, count, createTenant, openAccount, startLedger } from './helpers.js';

describe('transactional outbox worker', () => {
    let ledger, tenant;
    beforeEach(async () => {
        ledger = await startLedger();
        tenant = await createTenant(ledger.pool);
        const a = await openAccount(ledger.base, tenant.keys.admin, { openingBalance: 1_000 });
        const b = await openAccount(ledger.base, tenant.keys.admin);
        const operator = client(ledger.base, tenant.keys.operator);
        for (let index = 0; index < 5; index++) await operator.transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 10 });
    });
    afterEach(async () => ledger.close());

    test('each committed transfer queues one event, and a delivered event is not sent again', async () => {
        assert.equal(await count(ledger.pool, `SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'pending'`), 5);
        const seen = [];
        const first = await processOutboxBatch(ledger.pool, async (event) => seen.push(event.id));
        assert.equal(first.delivered, 5);
        const second = await processOutboxBatch(ledger.pool, async (event) => seen.push(event.id));
        assert.equal(second.claimed, 0);
        assert.equal(new Set(seen).size, 5);
    });

    test('failures retry with backoff, then succeed', async () => {
        let calls = 0;
        const flaky = async () => { calls++; if (calls <= 2) throw new Error('receiver unavailable'); };
        const options = { batchSize: 1, baseDelayMs: 0 };
        await processOutboxBatch(ledger.pool, flaky, options);
        await processOutboxBatch(ledger.pool, flaky, options);
        const third = await processOutboxBatch(ledger.pool, flaky, options);
        assert.equal(third.delivered, 1);
        const { rows: [event] } = await ledger.pool.query('SELECT status, attempts, last_error FROM outbox_events ORDER BY id LIMIT 1');
        assert.deepEqual(event, { status: 'delivered', attempts: 3, last_error: null });
    });

    test('backoff delays the next attempt, and repeated failure ends in dead instead of retrying forever', async () => {
        const failing = async () => { throw new Error('always down'); };
        await processOutboxBatch(ledger.pool, failing, { batchSize: 1, baseDelayMs: 60_000 });
        const delayed = await processOutboxBatch(ledger.pool, failing, { batchSize: 5, baseDelayMs: 60_000 });
        // The first event is now scheduled a minute out, so only the other four are due.
        assert.equal(delayed.claimed, 4);

        await ledger.pool.query(`UPDATE outbox_events SET next_attempt_at = now()`);
        for (let round = 0; round < 3; round++) {
            await processOutboxBatch(ledger.pool, failing, { batchSize: 5, maxAttempts: 3, baseDelayMs: 0 });
        }
        assert.equal(await count(ledger.pool, `SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'dead'`), 5);
        assert.equal((await processOutboxBatch(ledger.pool, failing, { baseDelayMs: 0 })).claimed, 0);
    });

    test('two workers running at once never deliver the same event (SKIP LOCKED)', async () => {
        const deliveries = [];
        const slow = (worker) => async (event) => {
            deliveries.push({ worker, id: event.id });
            await new Promise((resolve) => setTimeout(resolve, 50));
        };
        const [one, two] = await Promise.all([
            processOutboxBatch(ledger.pool, slow('one'), { batchSize: 3 }),
            processOutboxBatch(ledger.pool, slow('two'), { batchSize: 3 }),
        ]);
        assert.equal(one.delivered + two.delivered, 5);
        assert.equal(new Set(deliveries.map((delivery) => delivery.id)).size, deliveries.length);
        assert.ok(one.claimed > 0 && two.claimed > 0, 'both workers should claim work');
    });
});

describe('migrations', () => {
    let ledger;
    beforeEach(async () => { ledger = await startLedger(); });
    afterEach(async () => ledger.close());

    test('re-running is a no-op, and concurrent runners do not apply a file twice', async () => {
        assert.deepEqual(await migrate(ledger.pool), []);
        await ledger.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        const results = await Promise.all([migrate(ledger.pool), migrate(ledger.pool), migrate(ledger.pool)]);
        assert.equal(results.flat().length, 1);
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM schema_migrations'), 1);
    });
});
