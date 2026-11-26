import express from 'express';
import { authenticate, requirePermission } from './auth.js';
import { withTransaction } from './db.js';
import { ApiError, errorHandler } from './http.js';
import { readIdempotencyKey, requestHash, runIdempotent } from './idempotency.js';
import { createAccount, createTransfer, getAccount, getTransfer, listEntries } from './services/ledger.js';

const idParam = (value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    return id;
};

export const createApp = ({ pool, log } = {}) => {
    const app = express();
    app.disable('x-powered-by');

    app.get('/health', async (req, res) => {
        await pool.query('SELECT 1');
        res.json({ ok: true });
    });

    const api = express.Router();
    api.use(express.json({ limit: '32kb' }), authenticate(pool));

    api.post('/accounts', requirePermission('accounts:create'), async (req, res) => {
        const account = await withTransaction(pool, (client) => createAccount(client, req.actor, req.body));
        res.status(201).json({ data: account });
    });
    api.get('/accounts/:id', requirePermission('accounts:read'), async (req, res) => {
        res.json({ data: await getAccount(pool, req.actor, idParam(req.params.id)) });
    });
    api.get('/accounts/:id/entries', requirePermission('accounts:read'), async (req, res) => {
        res.json({ data: await listEntries(pool, req.actor, idParam(req.params.id)) });
    });

    api.post('/transfers', requirePermission('transfers:create'), async (req, res) => {
        const key = readIdempotencyKey(req);
        const hash = requestHash(req.method, req.originalUrl, req.body);
        const result = await runIdempotent(pool, { tenantId: req.actor.tenantId, key, hash },
            async (client) => ({ data: await createTransfer(client, req.actor, req.body) }));
        res.set('Idempotent-Replayed', String(result.replayed)).status(result.status).json(result.body);
    });
    api.get('/transfers/:id', requirePermission('transfers:read'), async (req, res) => {
        res.json({ data: await getTransfer(pool, req.actor, idParam(req.params.id)) });
    });

    app.use('/v1', api);
    app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route.' } }));
    app.use(errorHandler(log));
    return app;
};
