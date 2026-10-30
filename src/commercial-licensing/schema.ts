import type { Sql } from "../saas/neon.js";

export const COMMERCIAL_LICENSE_MIGRATIONS = [
  {
    version: 1,
    name: "commercial_licensing_core",
    sql: /* sql */ `
create table if not exists commercial_license_tiers (
  id text primary key,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  billing_interval text not null default 'year',
  billing_days integer not null default 365,
  seats integer not null check (seats > 0),
  organizations integer not null check (organizations > 0),
  revenue_cap_usd bigint,
  white_label boolean not null default false,
  summary text not null,
  features jsonb not null default '[]'::jsonb,
  whop_product_id text,
  whop_plan_id text unique,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into commercial_license_tiers
  (id,name,price_cents,seats,organizations,revenue_cap_usd,white_label,summary,features)
values
  ('indie','Indie Commercial',29900,1,1,1000000,false,'For a solo builder or small company shipping one commercial product.','["Competing commercial use","One legal entity","One operator seat","Email support"]'),
  ('business','Team / Business',149900,20,3,10000000,false,'For product teams operating InfiniBot commercially across several workspaces.','["Up to 20 seats","Up to 3 organizations","Hosted or embedded service","Priority email support"]'),
  ('agency','Agency / Reseller',249900,50,25,25000000,true,'For agencies, managed-service providers, resellers and white-label deployments.','["Up to 50 staff seats","Up to 25 client organizations","Resale and managed hosting","White-label rights"]'),
  ('enterprise','Enterprise / OEM',249900,250,100,null,true,'For large deployments, OEM distribution and negotiated support or source terms.','["Up to 250 seats","Up to 100 organizations","OEM and white-label rights","Contract and support addenda"]')
on conflict (id) do nothing;

create table if not exists commercial_licenses (
  id uuid primary key,
  checkout_ref text unique,
  jti uuid not null unique,
  tier_id text not null references commercial_license_tiers(id),
  licensee text not null,
  email text not null,
  status text not null check (status in ('pending','active','grace','revoked','expired')),
  seats integer not null,
  organizations integer not null,
  source text not null check (source in ('whop','manual','complimentary')),
  whop_membership_id text unique,
  whop_payment_id text unique,
  whop_plan_id text,
  token text,
  token_hash text,
  issued_at timestamptz,
  starts_at timestamptz,
  expires_at timestamptz,
  grace_until timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists commercial_licenses_email_idx on commercial_licenses(lower(email));
create index if not exists commercial_licenses_status_idx on commercial_licenses(status, expires_at desc);

create table if not exists commercial_license_webhook_events (
  id bigserial primary key,
  event_id text not null unique,
  event_type text not null,
  action text not null,
  status text not null,
  license_id uuid references commercial_licenses(id) on delete set null,
  whop_membership_id text,
  whop_payment_id text,
  detail jsonb not null default '{}'::jsonb,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists commercial_license_audit (
  id bigserial primary key,
  actor_email text not null,
  action text not null,
  license_id uuid references commercial_licenses(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists commercial_license_schema_migrations (
  version integer primary key,
  name text not null,
  applied_at timestamptz not null default now()
);
`,
  },
  {
    version: 2,
    name: "commercial_licensing_whop_billing_intervals",
    sql: /* sql */ `
alter table commercial_license_tiers add column if not exists billing_days integer not null default 365;
update commercial_license_tiers set price_cents=249900,billing_interval='180_days',billing_days=180 where id='agency';
update commercial_license_tiers set price_cents=249900,billing_interval='60_days',billing_days=60 where id='enterprise';
update commercial_license_tiers set billing_interval='year',billing_days=365 where id in ('indie','business');
`,
  },
] as const;

export async function runCommercialLicenseMigrations(sql: Sql): Promise<number[]> {
  await sql.unsafe(
    `create table if not exists commercial_license_schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())`,
  );
  const rows = await sql<
    { version: number }[]
  >`select version from commercial_license_schema_migrations`;
  const have = new Set(rows.map((r) => Number(r.version)));
  const applied: number[] = [];
  for (const migration of COMMERCIAL_LICENSE_MIGRATIONS) {
    if (have.has(migration.version)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx`insert into commercial_license_schema_migrations (version,name) values (${migration.version},${migration.name}) on conflict do nothing`;
    });
    applied.push(migration.version);
  }
  return applied;
}
