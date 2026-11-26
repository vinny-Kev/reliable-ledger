# ADR 003: Append-only audit log enforced in the database

## Context

An audit trail is only useful if it can't be quietly edited, including by application code with a bug or by someone holding the application's database credentials.

## Decision

- `audit_log` rows are written in the same transaction as the change they describe, so a rolled-back transfer leaves no audit row and a committed one always has one.
- Triggers reject `UPDATE`, `DELETE` (per row) and `TRUNCATE` (per statement) on `audit_log` with a clear error.

## Alternatives considered

- **Application-level discipline only.** One stray `UPDATE` defeats it.
- **Revoking UPDATE/DELETE privileges from the application role.** This is a good complement, and should be done in production. But it depends on deployment setup, and the triggers also protect against the owner role during normal operation.
- **Hash-chaining rows.** This makes tampering detectable rather than impossible. It's a natural next step, but out of scope here.

## Consequences

- A table owner or superuser can still drop the triggers. Protection against a fully compromised database needs off-site log shipping or hash chaining.
- Tests reset the database with `DROP SCHEMA`, so no test needs a way around the triggers.
