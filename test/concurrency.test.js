import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { client, count, createTenant, openAccount, startLedger } from './helpers.js';

describe('concurrent transfers', () => {
    let ledger, tenant, api;
    beforeEach(async () => {
        ledger = await startLedger();
        tenant = await createTenant(ledger.pool);
        api = client(ledger.base, tenant.keys.operator);
    });
    afterEach(async () => ledger.close());

    test('50 parallel withdrawals never overdraw: exactly 10 of 100 succeed against a balance of 1000', async () => {
        const source = await openAccount(ledger.base, tenant.keys.admin, { name: 'source', openingBalance: 1_000 });
        const sink = await openAccount(ledger.base, tenant.keys.admin, { name: 'sink' });
        const responses = await Promise.all(Array.from({ length: 50 }, () =>
            api.transfer({ fromAccountId: source.id, toAccountId: sink.id, amount: 100 })));
        const statuses = responses.map((res) => res.status);
        assert.equal(statuses.filter((status) => status === 201).length, 10);
        assert.equal(statuses.filter((status) => status === 422).length, 40);
        assert.ok(responses.filter((res) => res.status === 422).every((res) => res.body.error.code === 'INSUFFICIENT_FUNDS'));
        assert.equal((await api.get(`/v1/accounts/${source.id}`)).body.data.balance, 0);
        assert.equal((await api.get(`/v1/accounts/${sink.id}`)).body.data.balance, 1_000);
    });

    test('opposite-direction transfers run in parallel without deadlocks or lost updates', async () => {
        const a = await openAccount(ledger.base, tenant.keys.admin, { name: 'a', openingBalance: 5_000 });
        const b = await openAccount(ledger.base, tenant.keys.admin, { name: 'b', openingBalance: 5_000 });
        const jobs = Array.from({ length: 40 }, (_, index) => index % 2 === 0
            ? api.transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 30 })
            : api.transfer({ fromAccountId: b.id, toAccountId: a.id, amount: 10 }));
        const responses = await Promise.all(jobs);
        assert.deepEqual([...new Set(responses.map((res) => res.status))], [201]);
        // 20 transfers of 30 out of a, 20 transfers of 10 back into a.
        assert.equal((await api.get(`/v1/accounts/${a.id}`)).body.data.balance, 5_000 - 600 + 200);
        assert.equal((await api.get(`/v1/accounts/${b.id}`)).body.data.balance, 5_000 + 600 - 200);
    });

    test('ledger invariant: every balance equals the sum of its entries and total money is conserved', async () => {
        const accounts = [];
        for (let index = 0; index < 4; index++) {
            accounts.push(await openAccount(ledger.base, tenant.keys.admin, { name: `acct-${index}`, openingBalance: 2_000 }));
        }
        // Deterministic pseudo-random mix of transfers, including some that must fail.
        let seed = 7;
        const next = () => (seed = (seed * 48271) % 2147483647);
        await Promise.all(Array.from({ length: 60 }, () => {
            const from = accounts[next() % 4];
            let to = accounts[next() % 4];
            if (to.id === from.id) to = accounts[(accounts.indexOf(from) + 1) % 4];
            return api.transfer({ fromAccountId: from.id, toAccountId: to.id, amount: 1 + (next() % 400) });
        }));

        const mismatched = await count(ledger.pool, `SELECT COUNT(*) AS n FROM accounts a
            WHERE a.balance <> (SELECT COALESCE(SUM(delta), 0) FROM ledger_entries e WHERE e.account_id = a.id)`);
        assert.equal(mismatched, 0);
        assert.equal(await count(ledger.pool, 'SELECT SUM(balance) AS n FROM accounts'), 8_000);
        assert.equal(await count(ledger.pool, 'SELECT COUNT(*) AS n FROM accounts WHERE balance < 0'), 0);
        // Each committed transfer has exactly two entries that cancel out.
        assert.equal(await count(ledger.pool, `SELECT COUNT(*) AS n FROM (SELECT transfer_id FROM ledger_entries
            WHERE kind = 'transfer' GROUP BY transfer_id HAVING COUNT(*) <> 2 OR SUM(delta) <> 0) bad`), 0);
    });

    test('the database rejects a negative balance even if application checks were bypassed', async () => {
        const account = await openAccount(ledger.base, tenant.keys.admin, { openingBalance: 10 });
        await assert.rejects(ledger.pool.query('UPDATE accounts SET balance = balance - 11 WHERE id = $1', [account.id]),
            /accounts_balance_check/);
    });
});
