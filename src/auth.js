import { createHash } from 'node:crypto';
import { ApiError } from './http.js';

export const hashKey = (rawKey) => createHash('sha256').update(rawKey).digest('hex');

// Roles are cumulative: each one adds permissions to the one before it.
const viewer = ['accounts:read', 'transfers:read'];
const operator = [...viewer, 'transfers:create'];
const admin = [...operator, 'accounts:create'];
export const rolePermissions = { viewer: new Set(viewer), operator: new Set(operator), admin: new Set(admin) };

/** Resolves `Authorization: Bearer <key>` to req.actor = { keyId, tenantId, role }. */
export const authenticate = (pool) => async (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    if (!match) throw new ApiError(401, 'UNAUTHENTICATED', 'Send an API key as "Authorization: Bearer <key>".');
    const { rows: [key] } = await pool.query('SELECT id, tenant_id, role FROM api_keys WHERE key_hash = $1', [hashKey(match[1])]);
    if (!key) throw new ApiError(401, 'UNAUTHENTICATED', 'Unknown API key.');
    req.actor = { keyId: key.id, tenantId: key.tenant_id, role: key.role };
    next();
};

export const requirePermission = (permission) => (req, res, next) => {
    if (!rolePermissions[req.actor.role]?.has(permission)) {
        throw new ApiError(403, 'FORBIDDEN', `Role "${req.actor.role}" lacks permission "${permission}".`);
    }
    next();
};
