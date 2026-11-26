import { createApp } from './app.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const pool = createPool();
await migrate(pool);

const port = Number(process.env.PORT ?? 3000);
const server = createApp({ pool }).listen(port, () => console.log(`reliable-ledger listening on :${port}`));

const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
