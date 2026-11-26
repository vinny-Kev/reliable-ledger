import pg from 'pg';

// BIGINT columns (ids, amounts) come back as JavaScript numbers. Inputs are validated to stay
// within Number.MAX_SAFE_INTEGER, so this conversion is lossless for every value we accept.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const createPool = (connectionString = process.env.DATABASE_URL) => {
    if (!connectionString) throw new Error('DATABASE_URL is not set.');
    return new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
};

/** Runs `work` inside one transaction on a dedicated client; rolls back on any thrown error. */
export const withTransaction = async (pool, work) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
};
