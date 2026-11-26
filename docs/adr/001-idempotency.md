# ADR 001: Idempotency serialized by the key's primary key

## Context

Clients retry payment requests on timeouts and network errors. Without protection, a retry moves the money twice. Two copies of the same request can also arrive at the same moment, for example from a double-click or two retrying proxies.

## Decision

`POST /v1/transfers` requires an `Idempotency-Key` header, scoped per tenant. The whole request runs in one transaction:

1. `INSERT INTO idempotency_keys (tenant_id, key, request_hash, …) ON CONFLICT DO NOTHING`.
2. If the row was inserted, do the work under a savepoint, store the response in the row, and commit.
3. If it conflicted, read the stored row. If the request hash matches, replay the stored status and body with `Idempotent-Replayed: true`. If it differs, return `422 IDEMPOTENCY_KEY_REUSED`.

The request hash covers the method, the path and a key-sorted JSON body, so `{"a":1,"b":2}` and `{"b":2,"a":1}` count as the same request.

Client errors (4xx) are stored and replayed. Server errors and crashes roll back the whole transaction, including the key row, so the client can retry.

## Why this shape

A concurrent duplicate's `INSERT` waits on the in-flight row's primary key until the first transaction ends. That turns a race into a queue, without advisory locks, an "in progress" status, or polling. A committed row always holds a final response, because the placeholder is never visible outside its own transaction.

## Alternatives considered

- **A separate "in progress" row committed first, with a 409 for concurrent duplicates.** This works across services, but forces clients to handle 409 and retry, and needs cleanup for rows stuck in progress after a crash.
- **Caching responses outside the database (for example Redis).** The cache and the money movement can't commit atomically, which reopens the double-charge window.

## Consequences

- A duplicate waits as long as the original request takes. That's fine for short transactions, but long-running work would need the 409 approach.
- Keys are never expired here (see Known limitations in the README).
