-- Core schema. Amounts are integer minor units (for example centavos), never floats.

CREATE TABLE tenants (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys are stored as SHA-256 hashes; the raw key is shown once at creation and never stored.
CREATE TABLE api_keys (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    key_hash    TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
    label       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    currency    CHAR(3) NOT NULL,
    -- Last line of defence: even a buggy code path cannot commit a negative balance.
    balance     BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX accounts_tenant ON accounts(tenant_id);

CREATE TABLE transfers (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id),
    from_account_id   BIGINT NOT NULL REFERENCES accounts(id),
    to_account_id     BIGINT NOT NULL REFERENCES accounts(id),
    amount            BIGINT NOT NULL CHECK (amount > 0),
    currency          CHAR(3) NOT NULL,
    created_by_key_id BIGINT NOT NULL REFERENCES api_keys(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (from_account_id <> to_account_id)
);
CREATE INDEX transfers_tenant ON transfers(tenant_id);

-- Double-entry style ledger: every balance change has a row here, so balance = SUM(delta) per account.
CREATE TABLE ledger_entries (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    account_id   BIGINT NOT NULL REFERENCES accounts(id),
    transfer_id  BIGINT REFERENCES transfers(id),
    kind         TEXT NOT NULL CHECK (kind IN ('opening', 'transfer')),
    delta        BIGINT NOT NULL CHECK (delta <> 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'transfer') = (transfer_id IS NOT NULL))
);
CREATE INDEX ledger_entries_account ON ledger_entries(account_id);

-- One row per (tenant, Idempotency-Key). The primary key is what serializes concurrent duplicates.
CREATE TABLE idempotency_keys (
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id),
    key              TEXT NOT NULL,
    request_hash     TEXT NOT NULL,
    response_status  INTEGER NOT NULL,
    response_body    JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
);

CREATE TABLE audit_log (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    actor_key_id  BIGINT REFERENCES api_keys(id),
    action        TEXT NOT NULL,
    entity_type   TEXT NOT NULL,
    entity_id     BIGINT NOT NULL,
    detail        JSONB NOT NULL DEFAULT '{}',
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity ON audit_log(tenant_id, entity_type, entity_id);

-- Append-only, enforced by the database rather than by application discipline.
CREATE FUNCTION audit_log_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();

-- Transactional outbox: events are written in the same transaction as the change they describe.
CREATE TABLE outbox_events (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id),
    event_type       TEXT NOT NULL,
    payload          JSONB NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at     TIMESTAMPTZ
);
CREATE INDEX outbox_events_due ON outbox_events(next_attempt_at) WHERE status = 'pending';
