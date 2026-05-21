-- A handful of views to populate `list_tables` results beyond base tables.

CREATE OR REPLACE VIEW clinical.upcoming_appointments AS
SELECT
    a.id              AS appointment_id,
    a.starts_at,
    a.duration_min,
    a.status,
    p.id              AS patient_id,
    p.mrn,
    p.first_name,
    p.last_name,
    p.phone_e164,
    pr.name           AS practice
FROM clinical.appointments a
JOIN clinical.patients p   ON p.id = a.patient_id
JOIN public.practices pr   ON pr.id = p.practice_id
WHERE a.starts_at >= now()
  AND a.status IN ('scheduled', 'confirmed', 'checked_in')
  AND p.deleted_at IS NULL;

CREATE OR REPLACE VIEW public.lead_funnel AS
SELECT
    pr.slug                          AS practice,
    l.status,
    count(*)                         AS lead_count,
    count(*) FILTER (WHERE l.created_at > now() - interval '30 days')
                                     AS recent_count
FROM public.leads l
JOIN public.practices pr ON pr.id = l.practice_id
GROUP BY pr.slug, l.status
ORDER BY pr.slug, l.status;

CREATE OR REPLACE VIEW billing.unpaid_balances AS
SELECT
    p.id                             AS patient_id,
    p.first_name || ' ' || p.last_name AS patient,
    sum(i.amount_cents - i.paid_cents) AS balance_cents,
    count(*)                         AS invoice_count,
    max(i.issued_at)                 AS most_recent_invoice
FROM billing.invoices i
JOIN clinical.patients p ON p.id = i.patient_id
WHERE i.amount_cents > i.paid_cents
GROUP BY p.id, p.first_name, p.last_name
HAVING sum(i.amount_cents - i.paid_cents) > 0;
