-- ─────────────────────────────────────────────────────────────────────
-- Schema: two non-default schemas exercise the schema tree.
-- ─────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS clinical;
CREATE SCHEMA IF NOT EXISTS billing;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────
-- public: clinic config + staff + cross-schema audit
-- ─────────────────────────────────────────────────────────────────────

CREATE TYPE public.user_role AS ENUM ('admin', 'clinician', 'front_desk', 'biller', 'readonly');

CREATE TABLE public.practices (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    slug        text UNIQUE NOT NULL,
    timezone    text NOT NULL DEFAULT 'America/Chicago',
    settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.users (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    practice_id  int NOT NULL REFERENCES public.practices(id),
    email        text UNIQUE NOT NULL,
    full_name    text NOT NULL,
    role         public.user_role NOT NULL DEFAULT 'front_desk',
    is_active    boolean NOT NULL DEFAULT true,
    last_login   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_practice_idx ON public.users (practice_id);

CREATE TABLE public.leads (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    practice_id   int NOT NULL REFERENCES public.practices(id),
    phone_e164    text NOT NULL,
    full_name     text,
    source        text NOT NULL DEFAULT 'web',
    status        text NOT NULL DEFAULT 'new',  -- new | contacted | converted | expired
    expires_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leads_phone_idx ON public.leads (phone_e164);
CREATE INDEX leads_status_idx ON public.leads (status) WHERE status <> 'converted';

CREATE TABLE public.audit_log (
    id           bigserial PRIMARY KEY,
    actor_id     uuid REFERENCES public.users(id),
    action       text NOT NULL,                   -- 'insert' | 'update' | 'delete'
    target_kind  text NOT NULL,                   -- table name
    target_id    text NOT NULL,
    diff         jsonb NOT NULL DEFAULT '{}'::jsonb,
    diff_blob    bytea,                            -- exercise the bytea decoder
    at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_target_idx ON public.audit_log (target_kind, target_id);

-- ─────────────────────────────────────────────────────────────────────
-- clinical: patients + appointments (the PHI half)
-- ─────────────────────────────────────────────────────────────────────

CREATE TYPE clinical.appointment_status AS ENUM (
    'scheduled', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled'
);

CREATE TABLE clinical.patients (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    practice_id  int NOT NULL REFERENCES public.practices(id),
    mrn          varchar(16) NOT NULL,
    first_name   text NOT NULL,
    last_name    text NOT NULL,
    dob          date NOT NULL,
    phone_e164   text,
    email        text,
    address      jsonb NOT NULL DEFAULT '{}'::jsonb,
    deleted_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (practice_id, mrn)
);

CREATE INDEX patients_last_name_idx ON clinical.patients (last_name, first_name)
    WHERE deleted_at IS NULL;
CREATE INDEX patients_phone_idx ON clinical.patients (phone_e164)
    WHERE deleted_at IS NULL;

CREATE TABLE clinical.appointments (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id   uuid NOT NULL REFERENCES clinical.patients(id) ON DELETE CASCADE,
    clinician_id uuid REFERENCES public.users(id),
    starts_at    timestamptz NOT NULL,
    duration_min int NOT NULL DEFAULT 30,
    status       clinical.appointment_status NOT NULL DEFAULT 'scheduled',
    notes        text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX appointments_patient_idx ON clinical.appointments (patient_id);
CREATE INDEX appointments_starts_at_idx ON clinical.appointments (starts_at);

CREATE TABLE clinical.lab_results (
    id           bigserial PRIMARY KEY,
    patient_id   uuid NOT NULL REFERENCES clinical.patients(id) ON DELETE CASCADE,
    analyte      text NOT NULL,
    value_num    numeric(10, 3),
    unit         text,
    flagged      boolean NOT NULL DEFAULT false,
    attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
    drawn_at     timestamptz NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lab_results_patient_idx ON clinical.lab_results (patient_id, drawn_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- billing: invoices (a third schema)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE billing.invoices (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    practice_id   int NOT NULL REFERENCES public.practices(id),
    patient_id    uuid NOT NULL REFERENCES clinical.patients(id),
    amount_cents  int NOT NULL CHECK (amount_cents >= 0),
    paid_cents    int NOT NULL DEFAULT 0,
    description   text,
    issued_at     timestamptz NOT NULL DEFAULT now(),
    paid_at       timestamptz
);

CREATE INDEX invoices_patient_idx ON billing.invoices (patient_id);
