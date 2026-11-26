/** Appends one audit row inside the caller's transaction, so the audit trail commits or rolls back with the change. */
export const recordAudit = (client, { tenantId, actorKeyId, action, entityType, entityId, detail = {} }) =>
    client.query(
        `INSERT INTO audit_log (tenant_id, actor_key_id, action, entity_type, entity_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, actorKeyId, action, entityType, entityId, JSON.stringify(detail)]);

/** Queues an outbox event inside the caller's transaction (transactional outbox pattern). */
export const enqueueEvent = (client, { tenantId, eventType, payload }) =>
    client.query('INSERT INTO outbox_events (tenant_id, event_type, payload) VALUES ($1, $2, $3)',
        [tenantId, eventType, JSON.stringify(payload)]);
