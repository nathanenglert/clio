-- Deterministic seed: setseed for repeatable random ordering across resets.
SELECT setseed(0.42);

-- ── practices ─────────────────────────────────────────────────────
INSERT INTO public.practices (name, slug, timezone, settings) VALUES
    ('Cedar Park Family Medicine',  'cedar-park',  'America/Chicago', '{"after_hours_text": true, "online_booking": true}'),
    ('Lakeshore Pediatrics',        'lakeshore',   'America/Chicago', '{"language": "en", "specialty": "pediatrics"}'),
    ('Riverbend Internal Medicine', 'riverbend',   'America/Chicago', '{"telehealth_enabled": true}'),
    ('Highland Sports Clinic',      'highland',    'America/Denver',  '{"sports_intake": true, "online_booking": false}'),
    ('Elm Street Dental',           'elm-dental',  'America/New_York','{"reminders_hours_ahead": 24}');

-- ── users (≈4 per practice) ───────────────────────────────────────
INSERT INTO public.users (practice_id, email, full_name, role, is_active, last_login) VALUES
    (1, 'alice@cedarpark.test',   'Alice Nguyen',   'admin',       true,  now() - interval '2 hours'),
    (1, 'ben@cedarpark.test',     'Ben Carter',     'clinician',   true,  now() - interval '1 day'),
    (1, 'cara@cedarpark.test',    'Cara Patel',     'front_desk',  true,  now() - interval '6 hours'),
    (1, 'don@cedarpark.test',     'Don Riley',      'biller',      false, now() - interval '14 days'),
    (2, 'eli@lakeshore.test',     'Eli Rosen',      'admin',       true,  now() - interval '30 minutes'),
    (2, 'fae@lakeshore.test',     'Fae Okoro',      'clinician',   true,  now() - interval '3 hours'),
    (2, 'gus@lakeshore.test',     'Gus Vargas',     'front_desk',  true,  now() - interval '2 days'),
    (3, 'hana@riverbend.test',    'Hana Ito',       'clinician',   true,  now() - interval '4 hours'),
    (3, 'ira@riverbend.test',     'Ira Singh',      'front_desk',  true,  now() - interval '8 hours'),
    (3, 'jen@riverbend.test',     'Jen Park',       'biller',      true,  now() - interval '1 day'),
    (3, 'kat@riverbend.test',     'Kat Liu',        'admin',       true,  now() - interval '1 hour'),
    (4, 'leo@highland.test',      'Leo Diaz',       'clinician',   true,  now() - interval '5 hours'),
    (4, 'mae@highland.test',      'Mae Thompson',   'front_desk',  true,  now() - interval '20 hours'),
    (4, 'nin@highland.test',      'Nin Foster',     'admin',       true,  now() - interval '45 minutes'),
    (5, 'oli@elmdental.test',     'Oliver Banks',   'admin',       true,  now() - interval '90 minutes'),
    (5, 'pam@elmdental.test',     'Pam Howell',     'clinician',   true,  now() - interval '6 hours'),
    (5, 'quinn@elmdental.test',   'Quinn Rivera',   'front_desk',  true,  now() - interval '1 day'),
    (5, 'ron@elmdental.test',     'Ron Sato',       'biller',      false, NULL),
    (5, 'sue@elmdental.test',     'Sue Vance',      'readonly',    true,  now() - interval '3 days');

-- ── patients (200 generated deterministically) ────────────────────
INSERT INTO clinical.patients (practice_id, mrn, first_name, last_name, dob, phone_e164, email, address)
SELECT
    ((g - 1) % 5) + 1                              AS practice_id,
    'MRN' || lpad(g::text, 6, '0')                 AS mrn,
    (ARRAY['Avery','Bryn','Casey','Dakota','Elliot','Finley','Gray','Harper','Indigo','Jamie','Kai','Lane','Morgan','Nova','Onyx','Parker','Quinn','Reese','Sage','Tatum','Uma','Vale','Wren','Xan','Yael','Zion'])[1 + ((g * 31) % 26)]   AS first_name,
    (ARRAY['Alvarez','Brown','Chen','Davis','Edwards','Fischer','Garcia','Hayes','Iverson','Johnson','Kim','Lopez','Miller','Nakamura','OBrien','Patel','Quinones','Ramirez','Singh','Thompson','Underwood','Velez','Wilson','Xiong','Young','Zhang'])[1 + ((g * 17) % 26)] AS last_name,
    (date '1965-01-01' + (random() * 365 * 55)::int) AS dob,
    '+1512' || lpad(((g * 7919) % 9000000 + 1000000)::text, 7, '0') AS phone_e164,
    CASE WHEN g % 4 = 0 THEN NULL
         ELSE lower((ARRAY['avery','bryn','casey','dakota','elliot','finley'])[1 + (g % 6)] || g::text || '@example.test')
    END AS email,
    jsonb_build_object(
        'street', (1000 + g)::text || ' ' ||
                  (ARRAY['Maple','Oak','Pine','Elm','Cedar','Birch','Walnut','Willow'])[1 + (g % 8)] || ' ' ||
                  (ARRAY['St','Ave','Blvd','Ln','Way','Ct'])[1 + (g % 6)],
        'city', (ARRAY['Austin','Round Rock','Cedar Park','Pflugerville','Georgetown'])[1 + (g % 5)],
        'state', 'TX',
        'zip', (78700 + (g % 100))::text
    ) AS address
FROM generate_series(1, 200) g;

-- Soft-delete a handful so deleted_at column has non-null values.
UPDATE clinical.patients SET deleted_at = now() - interval '30 days'
WHERE mrn IN ('MRN000007','MRN000061','MRN000142','MRN000189');

-- ── appointments (≈3 per patient: 1 past, 1 imminent, 1 future) ───
INSERT INTO clinical.appointments (patient_id, clinician_id, starts_at, duration_min, status, notes)
SELECT
    p.id,
    (SELECT id FROM public.users WHERE practice_id = p.practice_id AND role = 'clinician' ORDER BY random() LIMIT 1),
    now() - interval '30 days' + (random() * interval '60 days') AS starts_at,
    (ARRAY[15, 30, 45, 60])[1 + (((row_number() OVER (PARTITION BY p.id)) * 11) % 4)] AS duration_min,
    (ARRAY['scheduled','confirmed','checked_in','completed','no_show','cancelled']::clinical.appointment_status[])[1 + (((row_number() OVER (PARTITION BY p.id)) * 13) % 6)] AS status,
    CASE WHEN random() > 0.7 THEN 'follow-up visit' ELSE NULL END AS notes
FROM clinical.patients p
CROSS JOIN generate_series(1, 3);

-- Force at least 40 future appointments so the example query has hits.
UPDATE clinical.appointments
SET starts_at = now() + (random() * interval '30 days'), status = 'scheduled'
WHERE id IN (SELECT id FROM clinical.appointments ORDER BY random() LIMIT 40);

-- ── lab results (a few per patient, only some) ────────────────────
INSERT INTO clinical.lab_results (patient_id, analyte, value_num, unit, flagged, attributes, drawn_at)
SELECT
    p.id,
    (ARRAY['hemoglobin_a1c','ldl','hdl','tsh','glucose','crp','sodium','potassium'])[1 + (g % 8)],
    round((random() * 200)::numeric, 3),
    (ARRAY['mg/dL','%','mIU/L','mmol/L'])[1 + (g % 4)],
    random() > 0.85,
    jsonb_build_object('method', (ARRAY['venous','capillary','arterial'])[1 + (g % 3)],
                       'qc_passed', random() > 0.05),
    now() - (random() * interval '180 days')
FROM clinical.patients p
CROSS JOIN generate_series(1, 2) g
WHERE p.deleted_at IS NULL;

-- ── leads (mix of statuses, including some expired) ───────────────
INSERT INTO public.leads (practice_id, phone_e164, full_name, source, status, expires_at, created_at)
SELECT
    ((g - 1) % 5) + 1,
    '+1512' || lpad(((g * 9941) % 9000000 + 1000000)::text, 7, '0'),
    CASE WHEN g % 3 = 0 THEN NULL ELSE 'Lead ' || g::text END,
    (ARRAY['web','referral','phone','walk-in'])[1 + (g % 4)],
    (ARRAY['new','contacted','converted','expired'])[1 + (g % 4)],
    now() - (random() * interval '120 days') + interval '30 days',
    now() - (random() * interval '180 days')
FROM generate_series(1, 100) g;

-- ── invoices (subset of patients have unpaid balances) ────────────
INSERT INTO billing.invoices (practice_id, patient_id, amount_cents, paid_cents, description, issued_at, paid_at)
SELECT
    p.practice_id,
    p.id,
    (50 + (random() * 400)::int) * 100 AS amount_cents,
    CASE WHEN random() > 0.4 THEN (50 + (random() * 400)::int) * 100 ELSE 0 END AS paid_cents,
    (ARRAY['Office visit','Lab work','Procedure','Telehealth consult','Follow-up'])[1 + (random() * 4)::int],
    now() - (random() * interval '120 days'),
    CASE WHEN random() > 0.4 THEN now() - (random() * interval '90 days') ELSE NULL END
FROM clinical.patients p
WHERE p.deleted_at IS NULL
  AND random() > 0.5;

-- Update paid_cents to actual amount where paid_at is set.
UPDATE billing.invoices SET paid_cents = amount_cents WHERE paid_at IS NOT NULL;

-- ── audit log (sprinkle a few rows with bytea + jsonb) ────────────
INSERT INTO public.audit_log (actor_id, action, target_kind, target_id, diff, diff_blob, at)
SELECT
    u.id,
    (ARRAY['insert','update','delete'])[1 + (g % 3)],
    (ARRAY['patient','appointment','lead','invoice'])[1 + (g % 4)],
    gen_random_uuid()::text,
    jsonb_build_object(
        'before', jsonb_build_object('status', 'old'),
        'after',  jsonb_build_object('status', 'new'),
        'fields', ARRAY['status', 'updated_at']
    ),
    decode(md5(g::text), 'hex'),
    now() - (random() * interval '90 days')
FROM (SELECT id FROM public.users ORDER BY random() LIMIT 5) u
CROSS JOIN generate_series(1, 20) g;
