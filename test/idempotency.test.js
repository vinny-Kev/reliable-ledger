import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { client, count, createTenant, openAccount, startLedger } from './helpers.js';

describe('idempotent transfers', () => {
    let ledger, tenant, api, from, to;
    beforeEach(async () => {
        ledger = await startLedger();
        tenant = await createTenant(ledger.pool);
        api = client(ledger.base, tenant.keys.operator);
        from = await openAccount(ledger.base, tenant.keys.admin, { name: 'from', openingBalance: 10_000 });
        to = await openAccount(ledger.base, tenant.keys.admin, { name: 'to' });
    });
    afterEach(async () => ledger.close());

    test('a retried request replays the stored response and moves money once', async () => {
        const body = { fromAccountId: from.id, toAccountId: to.id, amount: 2_500 };
        const first = await api.transfer(body, 'retry-1');
        const second = await api.transfer(body, 'retry-1');
        assert.equal(first.status, 201);
        assert.equal(first.headers.get('idempotent-replayed'), 'false');
        assert.equal(second.status, 201);
        assert.equal(second.headers.get('idempotent-replayed'), 'true');
        assert.deepEqual(second.body, first.body);
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM transfers'), 1);
        assert.equal((await api.get(`/v1/accounts/${from.id}`)).body.data.balance, 7_500);
    });

    test('20 concurrent requests with one key produce exactly one transfer and identical responses', async () => {
        const body = { fromAccountId: from.id, toAccountId: to.id, amount: 100 };
        const responses = await Promise.all(Array.from({ length: 20 }, () => api.transfer(body, 'burst-key')));
        assert.ok(responses.every((res) => res.status === 201), JSON.stringify(responses.map((res) => res.status)));
        const ids = new Set(responses.map((res) => res.body.data.id));
        assert.equal(ids.size, 1);
        assert.equal(responses.filter((res) => res.headers.get('idempotent-replayed') === 'false').length, 1);
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM transfers'), 1);
        assert.equal((await api.get(`/v1/accounts/${from.id}`)).body.data.balance, 9_900);
    });

    test('reusing a key with a different body is rejected and changes nothing', async () => {
        await api.transfer({ fromAccountId: from.id, toAccountId: to.id, amount: 100 }, 'reuse');
        const reused = await api.transfer({ fromAccountId: from.id, toAccountId: to.id, amount: 999 }, 'reuse');
        assert.equal(reused.status, 422);
        assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM transfers'), 1);
    });

    test('a business error is stored and replayed, even after the condition changes', async () => {
        const body = { fromAccountId: to.id, toAccountId: from.id, amount: 500 };
        const failed = await api.transfer(body, 'no-funds');
        assert.equal(failed.status, 422);
        assert.equal(failed.body.error.code, 'INSUFFICIENT_FUNDS');
        await api.transfer({ fromAccountId: from.id, toAccountId: to.id, amount: 1_000 });
        const replay = await api.transfer(body, 'no-funds');
        assert.equal(replay.status, 422);
        assert.equal(replay.headers.get('idempotent-replayed'), 'true');
        assert.deepEqual(replay.body, failed.body);
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM transfers'), 1);
    });

    test('the header is required and validated; keys are scoped per tenant', async () => {
        const missing = await client(ledger.base, tenant.keys.operator).post('/v1/transfers', { fromAccountId: from.id, toAccountId: to.id, amount: 1 });
        assert.equal(missing.status, 400);
        assert.equal(missing.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
        const invalid = await api.transfer({ fromAccountId: from.id, toAccountId: to.id, amount: 1 }, 'has spaces');
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error.code, 'IDEMPOTENCY_KEY_INVALID');

        const other = await createTenant(ledger.pool, 'Other');
        const otherFrom = await openAccount(ledger.base, other.keys.admin, { openingBalance: 50 });
        const otherTo = await openAccount(ledger.base, other.keys.admin);
        await api.transfer({ fromAccountId: from.id, toAccountId: to.id, amount: 10 }, 'shared-key');
        const otherRes = await client(ledger.base, other.keys.operator)
            .transfer({ fromAccountId: otherFrom.id, toAccountId: otherTo.id, amount: 10 }, 'shared-key');
        assert.equal(otherRes.status, 201);
        assert.equal(otherRes.headers.get('idempotent-replayed'), 'false');
    });
});
