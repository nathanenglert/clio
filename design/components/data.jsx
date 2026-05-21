/* Fake data for the mockups: schema, queries, agent activity log.
   Healthcare-ish domain — patients, appointments, leads, providers. */

const SCHEMA = {
  connections: [
    {
      id: 'prod', name: 'lassomd-prod', host: 'prod.lassomd.internal',
      readOnly: true, active: false,
      schemas: [
        { name: 'public', tables: [
          { name: 'patients',       cols: 24, rows: '128,447' },
          { name: 'appointments',   cols: 17, rows: '2.3M' },
          { name: 'providers',      cols: 11, rows: '342' },
          { name: 'leads',          cols: 19, rows: '47,210' },
          { name: 'visits',         cols: 22, rows: '891,304' },
          { name: 'insurance_claims', cols: 31, rows: '1.2M' },
          { name: 'prescriptions',  cols: 14, rows: '438,219' },
        ]},
      ]
    },
    {
      id: 'staging', name: 'lassomd-staging', host: 'staging.lassomd.internal',
      readOnly: false, active: true,
      schemas: [
        { name: 'public', tables: [
          { name: 'patients',       cols: 24, rows: '12,840', pinned: true, agentTouched: true,
            columns: [
              { name: 'id', type: 'uuid', pk: true },
              { name: 'mrn', type: 'text', idx: true, comment: 'medical record number' },
              { name: 'first_name', type: 'text' },
              { name: 'last_name', type: 'text', idx: true },
              { name: 'dob', type: 'date' },
              { name: 'phone_e164', type: 'text' },
              { name: 'email', type: 'citext', nullable: true },
              { name: 'address_jsonb', type: 'jsonb', nullable: true },
              { name: 'preferred_provider_id', type: 'uuid', fk: 'providers.id', nullable: true },
              { name: 'consent_flags', type: 'bit(8)' },
              { name: 'created_at', type: 'timestamptz' },
              { name: 'updated_at', type: 'timestamptz' },
              { name: 'deleted_at', type: 'timestamptz', nullable: true },
            ],
          },
          { name: 'appointments',   cols: 17, rows: '231,008', agentTouched: true,
            columns: [
              { name: 'id', type: 'uuid', pk: true },
              { name: 'patient_id', type: 'uuid', fk: 'patients.id' },
              { name: 'provider_id', type: 'uuid', fk: 'providers.id' },
              { name: 'starts_at', type: 'timestamptz', idx: true },
              { name: 'ends_at', type: 'timestamptz' },
              { name: 'status', type: 'appt_status' },
              { name: 'reason_code', type: 'text', nullable: true },
              { name: 'notes', type: 'text', nullable: true },
              { name: 'created_at', type: 'timestamptz' },
            ],
          },
          { name: 'providers',      cols: 11, rows: '38' },
          { name: 'leads',          cols: 19, rows: '4,728', agentTouched: true },
          { name: 'visits',         cols: 22, rows: '89,142' },
          { name: 'insurance_claims', cols: 31, rows: '120,891' },
          { name: 'prescriptions',  cols: 14, rows: '43,200' },
          { name: 'lead_sources',   cols: 8,  rows: '14',  isView: true },
          { name: 'patient_summary', cols: 12, rows: '12,840', isView: true },
        ]},
        { name: 'audit', tables: [
          { name: 'change_log',     cols: 9,  rows: '8.4M' },
          { name: 'access_log',     cols: 7,  rows: '24.1M' },
        ]},
        { name: 'reporting', tables: [
          { name: 'daily_metrics',  cols: 18, rows: '1,247', isView: true },
          { name: 'cohort_retention', cols: 22, rows: '−',   isMatView: true },
        ]},
      ]
    },
    {
      id: 'local', name: 'localhost', host: 'localhost:5432',
      readOnly: false, active: false,
      schemas: [{ name: 'public', tables: [{ name: 'scratch', cols: 4, rows: '0' }] }]
    },
  ],
};

// Sample rows for the patients table (results grid)
const PATIENT_ROWS = [
  ['7a2c…', 'M0048221', 'Maya',     'Okonkwo',    '1992-03-14', '+1 415 555 0142', 'maya.o@…',     '{"city":"Oakland","state":"CA"}',     '2025-11-04 09:12',  '—'],
  ['9b4f…', 'M0048220', 'Ravi',     'Sundaram',   '1981-08-22', '+1 415 555 0188', 'ravi@…',       '{"city":"SF","state":"CA"}',          '2025-11-04 09:08',  '—'],
  ['3d1e…', 'M0048219', 'Lena',     'Brückner',   '1968-01-30', '+1 510 555 0103', 'lena.b@…',     '{"city":"Berkeley","state":"CA"}',    '2025-11-04 08:54',  '2025-11-04 14:22'],
  ['c8a2…', 'M0048218', 'Damián',   'Reyes',      '2001-11-09', '+1 415 555 0114', null,           '{"city":"Daly City","state":"CA"}',   '2025-11-04 08:42',  '—'],
  ['1f5d…', 'M0048217', 'Aiyana',   'Tallchief',  '1976-06-18', '+1 415 555 0166', 'aiyana.t@…',   '{"city":"SF","state":"CA"}',          '2025-11-04 08:31',  '—'],
  ['4e9c…', 'M0048216', 'Yusuf',    'el-Hassan',  '1955-09-04', '+1 650 555 0177', 'yusuf@…',      '{"city":"San Mateo","state":"CA"}',   '2025-11-04 08:18',  '2025-11-04 10:01'],
  ['8a3b…', 'M0048215', 'Brigit',   'Halloran',   '1989-12-27', '+1 510 555 0144', 'b.halloran@…', '{"city":"Oakland","state":"CA"}',     '2025-11-04 08:02',  '—'],
  ['2c7f…', 'M0048214', 'Tomás',    'Pereira',    '1994-04-11', '+1 415 555 0199', 'tomas.p@…',    '{"city":"SF","state":"CA"}',          '2025-11-04 07:58',  '—'],
  ['6d0a…', 'M0048213', 'Hema',     'Joshi',      '1962-07-05', '+1 408 555 0123', 'hema.j@…',     '{"city":"San Jose","state":"CA"}',    '2025-11-04 07:44',  '—'],
  ['5b8e…', 'M0048212', 'Olamide',  'Adeyemi',    '1985-02-19', '+1 415 555 0155', 'ola@…',        '{"city":"SF","state":"CA"}',          '2025-11-04 07:31',  '—'],
  ['e1a3…', 'M0048211', 'Sigrid',   'Lindqvist',  '1973-10-08', '+1 415 555 0102', 'sigrid.l@…',   '{"city":"SF","state":"CA"}',          '2025-11-04 07:22',  '2025-11-04 13:48'],
  ['ab44…', 'M0048210', 'Kenji',    'Nakamura',   '1998-05-26', '+1 650 555 0145', 'kenji@…',      '{"city":"Palo Alto","state":"CA"}',   '2025-11-04 07:14',  '—'],
];

const PATIENT_COLS = [
  { name: 'id',          type: 'uuid',        w: 78  },
  { name: 'mrn',         type: 'text',        w: 100, idx: true },
  { name: 'first_name',  type: 'text',        w: 100 },
  { name: 'last_name',   type: 'text',        w: 116, idx: true },
  { name: 'dob',         type: 'date',        w: 96  },
  { name: 'phone_e164',  type: 'text',        w: 132 },
  { name: 'email',       type: 'citext',      w: 124 },
  { name: 'address_jsonb', type: 'jsonb',     w: 196 },
  { name: 'created_at',  type: 'timestamptz', w: 144 },
  { name: 'deleted_at',  type: 'timestamptz', w: 128 },
];

// Agent activity entries
const AGENT_LOG = [
  { t: '14:22:08', kind: 'read',     who: 'agent', verb: 'inspected schema',
    detail: 'public.patients', rows: 24, ms: 12 },
  { t: '14:22:14', kind: 'read',     who: 'agent', verb: 'SELECT',
    detail: 'patients WHERE created_at > now() - interval \'7 days\'', rows: 1847, ms: 86 },
  { t: '14:22:21', kind: 'read',     who: 'agent', verb: 'EXPLAIN',
    detail: 'plan for join patients × appointments', rows: null, ms: 4 },
  { t: '14:22:34', kind: 'read',     who: 'agent', verb: 'SELECT',
    detail: 'appointments WHERE patient_id IN (…) AND starts_at >= …', rows: 412, ms: 124 },
  { t: '14:23:02', kind: 'write',    who: 'agent', verb: 'UPDATE',
    detail: 'leads SET status = \'qualified\' WHERE id = $1', rows: 1, ms: 8, gated: false },
  { t: '14:23:18', kind: 'destruct', who: 'agent', verb: 'DELETE',
    detail: 'leads WHERE created_at < now() - interval \'90 days\' AND status = \'expired\'',
    rows: null, gated: true, awaiting: true, est: '~218 rows' },
];

const RECENT_QUERIES = [
  { t: '14:18', who: 'user',  text: 'select count(*) from appointments where starts_at::date = current_date' },
  { t: '14:14', who: 'agent', text: 'select id, mrn, last_name from patients where last_name ilike \'a%\' limit 50' },
  { t: '14:09', who: 'user',  text: 'select * from providers order by created_at desc limit 20' },
  { t: '13:58', who: 'agent', text: 'explain analyze select … from appointments a join patients p …' },
  { t: '13:51', who: 'user',  text: 'update leads set notes = $1 where id = $2' },
];

Object.assign(window, { SCHEMA, PATIENT_ROWS, PATIENT_COLS, AGENT_LOG, RECENT_QUERIES });
