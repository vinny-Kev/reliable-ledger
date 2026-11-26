import { createPool } from '../db.js';
import { processOutboxBatch } from './outbox.js';

// Reference worker: "delivers" events by logging them. Replace `deliver` with a webhook call,
// a queue publish, or similar. Throwing from it triggers the retry and backoff path.
const deliver = async (event) => console.log(JSON.stringify({ level: 'info', event: 'outbox_delivered', id: event.id, type: event.type }));

const pool = createPool();
const intervalMs = Number(process.env.OUTBOX_INTERVAL_MS ?? 2000);
let running = false;

const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
        await processOutboxBatch(pool, deliver);
    } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'outbox_batch_failed', message: error.message }));
    } finally {
        running = false;
    }
}, intervalMs);

const shutdown = () => { clearInterval(timer); pool.end().then(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
