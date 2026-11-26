import { withTransaction } from '../db.js';

/**
 * Delivers one batch of due outbox events.
 *
 * FOR UPDATE SKIP LOCKED lets several workers run at once: each claims different rows and none
 * blocks on another, so an event is never delivered by two workers in the same pass.
 * A failed delivery is retried with exponential backoff (baseDelayMs * 2^(attempts-1)); after
 * maxAttempts the event is marked dead for manual follow-up instead of retrying forever.
 *
 * Delivery is at-least-once: if the process dies after `deliver` succeeds but before COMMIT, the
 * event is sent again. Receivers should dedupe on the event id.
 */
export const processOutboxBatch = (pool, deliver, { batchSize = 20, maxAttempts = 5, baseDelayMs = 1000 } = {}) =>
    withTransaction(pool, async (client) => {
        const { rows } = await client.query(
            `SELECT id, tenant_id, event_type, payload, attempts FROM outbox_events
             WHERE status = 'pending' AND next_attempt_at <= now()
             ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
            [batchSize]);
        const summary = { claimed: rows.length, delivered: 0, retrying: 0, dead: 0 };
        for (const event of rows) {
            const attempts = event.attempts + 1;
            try {
                await deliver({ id: event.id, tenantId: event.tenant_id, type: event.event_type, payload: event.payload });
                await client.query(`UPDATE outbox_events SET status = 'delivered', attempts = $2, delivered_at = now(), last_error = NULL WHERE id = $1`,
                    [event.id, attempts]);
                summary.delivered++;
            } catch (error) {
                const dead = attempts >= maxAttempts;
                await client.query(
                    `UPDATE outbox_events SET attempts = $2, last_error = $3, status = $4,
                         next_attempt_at = now() + make_interval(secs => $5::double precision / 1000)
                     WHERE id = $1`,
                    [event.id, attempts, String(error?.message ?? error).slice(0, 500), dead ? 'dead' : 'pending',
                        baseDelayMs * 2 ** (attempts - 1)]);
                summary[dead ? 'dead' : 'retrying']++;
            }
        }
        return summary;
    });
