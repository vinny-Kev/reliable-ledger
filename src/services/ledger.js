import { ApiError } from '../http.js';
import { enqueueEvent, recordAudit } from './audit.js';

const CURRENCY = /^[A-Z]{3}$/;

const positiveInteger = (value, field) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ApiError(400, 'INVALID_INPUT', `${field} must be a positive integer (minor units).`);
    }
    return value;
};

const toAccount = (row) => ({ id: row.id, name: row.name, currency: row.currency.trim(), balance: row.balance, createdAt: row.created_at });
const toTransfer = (row) => ({ id: row.id, fromAccountId: row.from_account_id, toAccountId: row.to_account_id,
    amount: row.amount, currency: row.currency.trim(), createdAt: row.created_at });

export const createAccount = async (client, actor, body) => {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) throw new ApiError(400, 'INVALID_INPUT', 'name is required (1-120 characters).');
    if (!CURRENCY.test(body?.currency ?? '')) throw new ApiError(400, 'INVALID_INPUT', 'currency must be a 3-letter ISO code such as PHP.');
    const opening = body.openingBalance === undefined ? 0 : body.openingBalance;
    if (opening !== 0) positiveInteger(opening, 'openingBalance');

    const { rows: [account] } = await client.query(
        'INSERT INTO accounts (tenant_id, name, currency, balance) VALUES ($1, $2, $3, $4) RETURNING *',
        [actor.tenantId, name, body.currency, opening]);
    if (opening > 0) {
        await client.query(`INSERT INTO ledger_entries (tenant_id, account_id, kind, delta) VALUES ($1, $2, 'opening', $3)`,
            [actor.tenantId, account.id, opening]);
    }
    await recordAudit(client, { tenantId: actor.tenantId, actorKeyId: actor.keyId, action: 'account.created',
        entityType: 'account', entityId: account.id, detail: { currency: body.currency, openingBalance: opening } });
    return toAccount(account);
};

/** Tenant-scoped read: another tenant's account id is indistinguishable from a missing one. */
export const getAccount = async (db, actor, id) => {
    const { rows: [account] } = await db.query('SELECT * FROM accounts WHERE tenant_id = $1 AND id = $2', [actor.tenantId, id]);
    if (!account) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');
    return toAccount(account);
};

export const listEntries = async (db, actor, accountId) => {
    await getAccount(db, actor, accountId);
    const { rows } = await db.query(
        'SELECT id, transfer_id, kind, delta, created_at FROM ledger_entries WHERE tenant_id = $1 AND account_id = $2 ORDER BY id',
        [actor.tenantId, accountId]);
    return rows.map((row) => ({ id: row.id, transferId: row.transfer_id, kind: row.kind, delta: row.delta, createdAt: row.created_at }));
};

export const getTransfer = async (db, actor, id) => {
    const { rows: [transfer] } = await db.query('SELECT * FROM transfers WHERE tenant_id = $1 AND id = $2', [actor.tenantId, id]);
    if (!transfer) throw new ApiError(404, 'NOT_FOUND', 'Transfer not found.');
    return toTransfer(transfer);
};

/**
 * Moves `amount` between two accounts of the same tenant and currency, inside the caller's transaction.
 *
 * Both account rows are locked with SELECT ... FOR UPDATE in ascending id order. A consistent lock
 * order means A->B and B->A transfers running at the same time queue up instead of deadlocking, and
 * the balance check happens on the locked row, so concurrent transfers cannot overdraw it.
 */
export const createTransfer = async (client, actor, body) => {
    const fromAccountId = positiveInteger(body?.fromAccountId, 'fromAccountId');
    const toAccountId = positiveInteger(body?.toAccountId, 'toAccountId');
    const amount = positiveInteger(body?.amount, 'amount');
    if (fromAccountId === toAccountId) throw new ApiError(400, 'INVALID_INPUT', 'fromAccountId and toAccountId must differ.');

    const { rows: locked } = await client.query(
        'SELECT id, currency, balance FROM accounts WHERE tenant_id = $1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE',
        [actor.tenantId, [fromAccountId, toAccountId]]);
    const from = locked.find((row) => row.id === fromAccountId);
    const to = locked.find((row) => row.id === toAccountId);
    if (!from || !to) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');
    if (from.currency !== to.currency) throw new ApiError(422, 'CURRENCY_MISMATCH', 'Both accounts must use the same currency.');
    if (from.balance < amount) throw new ApiError(422, 'INSUFFICIENT_FUNDS', 'The source account balance is too low.');

    const { rows: [transfer] } = await client.query(
        `INSERT INTO transfers (tenant_id, from_account_id, to_account_id, amount, currency, created_by_key_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [actor.tenantId, fromAccountId, toAccountId, amount, from.currency, actor.keyId]);
    await client.query(
        `INSERT INTO ledger_entries (tenant_id, account_id, transfer_id, kind, delta)
         VALUES ($1, $2, $4, 'transfer', -$5::bigint), ($1, $3, $4, 'transfer', $5::bigint)`,
        [actor.tenantId, fromAccountId, toAccountId, transfer.id, amount]);
    await client.query('UPDATE accounts SET balance = balance - $2 WHERE id = $1', [fromAccountId, amount]);
    await client.query('UPDATE accounts SET balance = balance + $2 WHERE id = $1', [toAccountId, amount]);

    const result = toTransfer(transfer);
    await recordAudit(client, { tenantId: actor.tenantId, actorKeyId: actor.keyId, action: 'transfer.created',
        entityType: 'transfer', entityId: transfer.id, detail: { fromAccountId, toAccountId, amount } });
    await enqueueEvent(client, { tenantId: actor.tenantId, eventType: 'transfer.created', payload: result });
    return result;
};
