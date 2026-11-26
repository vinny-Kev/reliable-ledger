# ADR 002: Pessimistic row locks in a fixed order

## Context

Concurrent transfers from the same account must not both pass a balance check that only one of them can afford. Transfers in opposite directions between the same two accounts must not deadlock.

## Decision

A transfer locks both account rows with `SELECT … WHERE id = ANY($ids) ORDER BY id FOR UPDATE`, checks the balance on the locked rows, then writes. Locks are always taken in ascending id order. `accounts.balance` also has `CHECK (balance >= 0)` as a backstop that no code path can bypass.

## Alternatives considered

- **SERIALIZABLE isolation with a retry loop.** Also correct, but conflicts surface as serialization failures that every caller must retry, and throughput under contention is harder to predict.
- **An atomic conditional update (`UPDATE … SET balance = balance - $1 WHERE balance >= $1`).** Fine for one account, but a transfer touches two rows, plus the ledger entries, and has to validate currency first.
- **Optimistic version columns.** These move retry logic into the application for a case where contention on hot accounts is expected.

## Consequences

- Transfers touching the same account run one at a time. That's the intended behavior for a balance. Throughput on one very hot account is bounded by transaction time.
- Tests show that 50 concurrent withdrawals from a balance of 1000 produce exactly 10 successes, and that 40 opposite-direction transfers finish with no deadlock errors.
