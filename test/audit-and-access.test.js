import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { client, count, createTenant, openAccount, startLedger } from './helpers.js';

describe('append-only audit log', () => {
    let ledger, tenant;
    beforeEach(async () => {
        ledger = await startLedger();
        tenant = await createTenant(ledger.pool);
    });
    afterEach(async () => ledger.close());

    test('every account and transfer writes an audit row in the same transaction', async () => {
        const a = await openAccount(ledger.base, tenant.keys.admin, { openingBalance: 100 });
        const b = await openAccount(ledger.base, tenant.keys.admin);
        await client(ledger.base, tenant.keys.operator).transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 40 });
        const actions = (await ledger.pool.query('SELECT action FROM audit_log ORDER BY id')).rows.map((row) => row.action);
        assert.deepEqual(actions, ['account.created', 'account.created', 'transfer.created']);
    });

    test('a failed transfer leaves no audit row, no outbox event and no ledger entry', async () => {
        const a = await openAccount(ledger.base, tenant.keys.admin, { openingBalance: 10 });
        const b = await openAccount(ledger.base, tenant.keys.admin);
        const res = await client(ledger.base, tenant.keys.operator).transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 50 });
        assert.equal(res.status, 422);
        assert.equal(await count(ledger.pool, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'transfer.created'`), 0);
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM outbox_events'), 0);
        assert.equal(await count(ledger.pool, `SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = 'transfer'`), 0);
    });

    test('UPDATE, DELETE and TRUNCATE on the audit log are rejected by the database', async () => {
        await openAccount(ledger.base, tenant.keys.admin);
        await assert.rejects(ledger.pool.query(`UPDATE audit_log SET action = 'tampered'`), /append-only \(UPDATE rejected\)/);
        await assert.rejects(ledger.pool.query('DELETE FROM audit_log'), /append-only \(DELETE rejected\)/);
        await assert.rejects(ledger.pool.query('TRUNCATE audit_log'), /append-only \(TRUNCATE rejected\)/);
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM audit_log'), 1);
    });
});

describe('authentication, roles and tenant isolation', () => {
    let ledger, tenantA, tenantB, accountA, accountA2;
    beforeEach(async () => {
        ledger = await startLedger();
        tenantA = await createTenant(ledger.pool, 'A');
        tenantB = await createTenant(ledger.pool, 'B');
        accountA = await openAccount(ledger.base, tenantA.keys.admin, { openingBalance: 500 });
        accountA2 = await openAccount(ledger.base, tenantA.keys.admin);
    });
    afterEach(async () => ledger.close());

    test('missing or unknown API keys get 401', async () => {
        assert.equal((await client(ledger.base).get(`/v1/accounts/${accountA.id}`)).status, 401);
        assert.equal((await client(ledger.base, 'not-a-real-key').get(`/v1/accounts/${accountA.id}`)).status, 401);
    });

    test('roles are enforced per endpoint', async () => {
        const viewer = client(ledger.base, tenantA.keys.viewer);
        assert.equal((await viewer.get(`/v1/accounts/${accountA.id}`)).status, 200);
        const denied = await viewer.transfer({ fromAccountId: accountA.id, toAccountId: accountA2.id, amount: 1 });
        assert.equal(denied.status, 403);
        assert.equal(denied.body.error.code, 'FORBIDDEN');
        assert.equal((await client(ledger.base, tenantA.keys.operator).post('/v1/accounts', { name: 'x', currency: 'PHP' })).status, 403);
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM transfers'), 0);
    });

    test("another tenant's accounts look like they do not exist", async () => {
        const outsider = client(ledger.base, tenantB.keys.admin);
        assert.equal((await outsider.get(`/v1/accounts/${accountA.id}`)).status, 404);
        assert.equal((await outsider.get(`/v1/accounts/${accountA.id}/entries`)).status, 404);
        const theft = await client(ledger.base, tenantB.keys.operator)
            .transfer({ fromAccountId: accountA.id, toAccountId: accountA2.id, amount: 100 });
        assert.equal(theft.status, 404);
        assert.equal((await client(ledger.base, tenantA.keys.viewer).get(`/v1/accounts/${accountA.id}`)).body.data.balance, 500);
    });

    test('input validation and safe error responses', async () => {
        const operator = client(ledger.base, tenantA.keys.operator);
        for (const amount of [0, -5, 1.5, '100', Number.MAX_SAFE_INTEGER + 2]) {
            const res = await operator.transfer({ fromAccountId: accountA.id, toAccountId: accountA2.id, amount });
            assert.equal(res.status, 400, `amount ${amount}`);
        }
        const same = await operator.transfer({ fromAccountId: accountA.id, toAccountId: accountA.id, amount: 1 });
        assert.equal(same.status, 400);
        const usd = await openAccount(ledger.base, tenantA.keys.admin, { currency: 'USD' });
        const mismatch = await operator.transfer({ fromAccountId: accountA.id, toAccountId: usd.id, amount: 1 });
        assert.equal(mismatch.status, 422);
        assert.equal(mismatch.body.error.code, 'CURRENCY_MISMATCH');
        const badJson = await fetch(`${ledger.base}/v1/accounts`, { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${tenantA.keys.admin}` }, body: '{oops' });
        assert.equal(badJson.status, 400);
        assert.equal((await badJson.json()).error.code, 'INVALID_JSON');
    });
});
