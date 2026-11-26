# ADR 004: Transactional outbox with at-least-once delivery

## Context

Other systems need to hear about transfers. Calling them inside the request either slows the request or loses events: if the call succeeds but the transaction rolls back, or the reverse.

## Decision

- The transfer transaction inserts a row into `outbox_events`, so an event exists if and only if the transfer committed.
- A worker claims due events with `FOR UPDATE SKIP LOCKED`, so several workers can run without blocking each other or claiming the same row.
- On failure it records the error and schedules the next attempt at `baseDelayMs * 2^(attempts-1)`. After `maxAttempts`, the event becomes `dead` for manual follow-up instead of retrying forever.

## Consequences

- Delivery is **at least once**. If the worker dies after a successful delivery but before committing, the event is sent again, so receivers must dedupe on the event id.
- The worker holds its transaction, and the row locks, open while delivering. That's simple and correct, but a slow receiver holds locks longer. At higher volume, claim with a short transaction that sets a lease (`locked_until`), deliver outside the transaction, then mark the result.
- Tests cover: one event per committed transfer, none for a failed one; retry then success; backoff delaying the next attempt; dead after the limit; and two concurrent workers never delivering the same event.
