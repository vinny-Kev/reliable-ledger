# reliable-ledger

A small reference service for correctness-critical payment APIs, built on Express 5 and PostgreSQL.

It moves money between accounts, and it is built around the failure modes that matter in payments:
- a client retrying a request it thinks failed;
- two requests racing for the same balance;
- someone trying to quietly edit history;
- a downstream system that is temporarily unavailable.

Each of those has a mechanism here and a test that runs against a real Postgres database.

> This is a reference implementation, not a product. It is written from scratch to show patterns I use in commercial work. None of that work's code, schema or business logic is included.

## What it demonstrates

| Problem | Mechanism | Proven by |
|---|---|---|
| Retries and duplicate submissions | `Idempotency-Key` per tenant. The request hash is stored, and the original response (including errors) is replayed. | `test/idempotency.test.js` |
| Concurrent requests with the same key | The key's primary key serializes them inside one transaction. Exactly one does the work, and the rest replay its response. | 20 parallel requests produce 1 transfer |
| Overdrafts under concurrency | `SELECT … FOR UPDATE` on both accounts, plus a `CHECK (balance >= 0)` backstop | 50 parallel withdrawals: exactly 10 succeed |
| Deadlocks between A→B and B→A | Locks are always taken in ascending account id | 40 opposite-direction transfers, no failures |
| Lost or invented money | Every balance change has a ledger entry, so `balance = SUM(delta)` | Invariant check after 60 random concurrent transfers |
| Tampering with history | An audit log made append-only by database triggers (UPDATE, DELETE, TRUNCATE all rejected) | `test/audit-and-access.test.js` |
| Cross-tenant access | Every query is scoped by tenant. A foreign id returns 404, not 403. | Tenant isolation tests |
| Notifying other systems reliably | Transactional outbox and a worker using `FOR UPDATE SKIP LOCKED`, exponential backoff, and a dead-letter state | `test/outbox-and-migrations.test.js` |

## Architecture

```mermaid
flowchart LR
    C[Client] -->|Bearer key + Idempotency-Key| API[Express 5 API]
    API --> AUTH[authenticate + requirePermission]
    AUTH --> IDEM[runIdempotent]
    IDEM --> SVC[createTransfer]
    SVC -->|one transaction| PG[(PostgreSQL)]
    PG --- T1[accounts / transfers / ledger_entries]
    PG --- T2[idempotency_keys]
    PG --- T3[audit_log - append-only]
    PG --- T4[outbox_events]
    W[Outbox worker] -->|SKIP LOCKED batch| PG
    W -->|deliver, retry, dead-letter| EXT[Downstream system]
```

A transfer request and a concurrent duplicate:

```mermaid
sequenceDiagram
    participant A as Request 1
    participant B as Request 2 (same key)
    participant DB as PostgreSQL
    A->>DB: BEGIN, INSERT idempotency_keys (tenant, key)
    B->>DB: BEGIN, INSERT idempotency_keys (tenant, key)
    Note over B,DB: blocks on the primary key until request 1 finishes
    A->>DB: SELECT accounts … ORDER BY id FOR UPDATE
    A->>DB: insert transfer, 2 ledger entries, update balances
    A->>DB: insert audit row + outbox event, store response
    A->>DB: COMMIT
    DB-->>B: conflict: row now exists
    B->>DB: SELECT stored response (hash must match)
    B-->>B: replay 201 with Idempotent-Replayed: true
```

If request 1 rolls back (a crash or a 5xx), its key row disappears and request 2 does the work itself.

## Stack

- Node.js 22, Express 5 (async errors reach the error handler without wrappers)
- PostgreSQL 16, `pg`
- `node:test`, running against a real database with no mocks
- GitHub Actions, with a Postgres service container

## Repository structure

```text
migrations/001_init.sql     schema, constraints, append-only triggers
src/app.js                  routes and middleware wiring
src/auth.js                 API key auth (SHA-256 hashed keys), role permissions
src/idempotency.js          request hashing, key validation, runIdempotent
src/services/ledger.js      accounts and transfers (locking, ledger entries)
src/services/audit.js       audit rows and outbox events, in the caller's transaction
src/worker/outbox.js        batch delivery with SKIP LOCKED, backoff, dead-letter
src/migrate.js              migration runner guarded by an advisory lock
test/                       integration tests against Postgres
docs/adr/                   architecture decision records
```

## Key decisions

- [ADR 001: Idempotency serialized by the key's primary key](docs/adr/001-idempotency.md)
- [ADR 002: Pessimistic row locks in a fixed order](docs/adr/002-row-locking.md)
- [ADR 003: Append-only audit log enforced in the database](docs/adr/003-append-only-audit.md)
- [ADR 004: Transactional outbox with at-least-once delivery](docs/adr/004-outbox.md)

## Setup

Requirements: Node.js 22+ and Docker (or any PostgreSQL 16).

```bash
docker run -d --name ledger-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ledger postgres:16-alpine
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger npm start
```

The server applies migrations on start. Tenants and API keys are created directly in the database, since there is no admin API. `test/helpers.js` shows how.

### API

| Method | Path | Permission |
|---|---|---|
| `POST` | `/v1/accounts` | `accounts:create` (admin) |
| `GET` | `/v1/accounts/:id` | `accounts:read` |
| `GET` | `/v1/accounts/:id/entries` | `accounts:read` |
| `POST` | `/v1/transfers` (requires `Idempotency-Key`) | `transfers:create` (operator, admin) |
| `GET` | `/v1/transfers/:id` | `transfers:read` |

```bash
curl -X POST http://localhost:3000/v1/transfers \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: order-1042" \
  -H "Content-Type: application/json" \
  -d '{"fromAccountId": 1, "toAccountId": 2, "amount": 2500}'
```

Amounts are integer minor units (2500 means 25.00). Errors always look like `{ "error": { "code", "message" } }`.

## Testing

```bash
docker run -d --name ledger-test-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ledger_test postgres:16-alpine
npm install
npm test
```

Each test drops and recreates the schema, so point `TEST_DATABASE_URL` only at a disposable database.

**Verification status:**
- 21 tests pass on Node 22.22 against PostgreSQL 16 (run in Docker).
- To check that the tests can actually fail, three bugs were injected by hand: removing the row locks, letting a duplicate key re-run the work, and removing the audit UPDATE/DELETE trigger. Each made the suite fail (2, 4 and 1 failures).
- CI runs the same suite on every push.

## Known limitations

- No admin API for tenants or keys, and no key rotation.
- Idempotency keys are kept forever. A real service would expire them (for example after 24 hours) with a cleanup job.
- A transfer needs both accounts in the same currency. There is no FX.
- Amounts are limited to `Number.MAX_SAFE_INTEGER` minor units, and larger values are rejected.
- The outbox worker holds its transaction open while delivering. This is simple and correct, but a slow receiver keeps row locks longer. A lease column would avoid that at higher volume (see ADR 004).
- `GET /v1/accounts/:id/entries` is not paginated.
- No rate limiting, request logging or metrics.

## License

MIT. See [LICENSE](LICENSE).
