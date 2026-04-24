-- OTCIntel Supabase Schema
-- Run this in your Supabase SQL editor to scaffold the database

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================================
-- COMPANIES
-- ============================================================
create table if not exists companies (
  id uuid primary key default uuid_generate_v4(),
  ticker text not null unique,
  name text not null,
  market text,
  sector text,
  otc_tier text, -- 'Pink Sheets', 'Expert Market', 'OTCQB', 'OTCQX'
  price numeric(18, 6),
  price_change_pct numeric(8, 4),
  price_change_amt numeric(18, 6),
  market_cap_display text,
  shares_outstanding bigint,
  float_shares bigint,
  authorized_shares bigint,
  preferred_shares bigint,
  reserved_shares bigint,
  shares_remaining bigint,
  risk_score integer check (risk_score >= 0 and risk_score <= 100),
  risk_level text check (risk_level in ('high', 'med', 'low')),
  financing_type text,
  financing_type_category text check (financing_type_category in ('convertible', 'equity', 'none')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- FILINGS
-- ============================================================
create table if not exists filings (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id) on delete cascade,
  ticker text not null,
  filing_type text not null, -- '8-K', 'S-1', '10-Q', '10-K', 'NT 10-Q', '8-K/A', etc.
  filed_date date not null,
  cik text,
  sec_edgar_url text,
  summary text,
  has_financing boolean default false,
  created_at timestamptz default now()
);

-- ============================================================
-- FINANCING DEALS
-- ============================================================
create table if not exists financing_deals (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id) on delete cascade,
  ticker text not null,
  filing_id uuid references filings(id),
  deal_type text not null, -- 'convertible_note', 'equity_line', 'preferred_stock', 'warrant'
  principal_amount numeric(18, 2),
  discount_pct numeric(6, 3),
  lookback_days integer,
  floor_price numeric(18, 6),
  has_floor_price boolean default false,
  has_reset_provisions boolean default false,
  maturity_date date,
  investor_name text,
  warrant_shares bigint,
  warrant_exercise_price numeric(18, 6),
  warrant_expiration_date date,
  est_conversion_price numeric(18, 6),
  est_shares_from_note bigint,
  est_shares_from_warrants bigint,
  est_total_new_shares bigint,
  est_fully_diluted bigint,
  est_dilution_pct numeric(6, 3),
  is_active boolean default true,
  announced_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- RISK SCORES
-- ============================================================
create table if not exists risk_scores (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id) on delete cascade,
  ticker text not null,
  score integer not null check (score >= 0 and score <= 100),
  level text check (level in ('high', 'med', 'low')),
  -- Factor breakdown (0–100 each)
  factor_discount_depth integer,
  factor_lookback_window integer,
  factor_warrant_coverage integer,
  factor_reset_provisions integer,
  factor_floor_price integer,
  -- Score drivers (JSON array of text)
  drivers jsonb,
  scored_at timestamptz default now(),
  created_at timestamptz default now()
);

-- ============================================================
-- ALERTS
-- ============================================================
create table if not exists alerts (
  id uuid primary key default uuid_generate_v4(),
  ticker text not null,
  company_name text,
  alert_type text not null check (
    alert_type in ('financing', 'registration', 'filing', 'risk', 'watchlist')
  ),
  alert_message text not null,
  status text default 'new' check (status in ('new', 'reviewed', 'flagged', 'cleared')),
  priority text default 'normal' check (priority in ('high', 'normal', 'low')),
  filing_id uuid references filings(id),
  company_id uuid references companies(id),
  triggered_at timestamptz default now(),
  reviewed_at timestamptz,
  created_at timestamptz default now()
);

-- ============================================================
-- ALERT PREFERENCES (per user, ready for auth)
-- ============================================================
create table if not exists alert_preferences (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid, -- references auth.users(id) when auth is enabled
  convertible_financing boolean default true,
  risk_score_changes boolean default true,
  s1_registrations boolean default true,
  late_filing_notices boolean default false,
  warrant_exercises boolean default false,
  risk_threshold integer default 10, -- minimum score change to trigger
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- WATCHLIST (per user)
-- ============================================================
create table if not exists watchlist (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid, -- references auth.users(id) when auth is enabled
  company_id uuid references companies(id) on delete cascade,
  ticker text not null,
  added_at timestamptz default now(),
  unique(user_id, ticker)
);

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists idx_companies_ticker on companies(ticker);
create index if not exists idx_companies_risk_level on companies(risk_level);
create index if not exists idx_filings_ticker on filings(ticker);
create index if not exists idx_filings_filed_date on filings(filed_date desc);
create index if not exists idx_financing_deals_ticker on financing_deals(ticker);
create index if not exists idx_financing_deals_active on financing_deals(is_active) where is_active = true;
create index if not exists idx_risk_scores_ticker on risk_scores(ticker);
create index if not exists idx_risk_scores_scored_at on risk_scores(scored_at desc);
create index if not exists idx_alerts_ticker on alerts(ticker);
create index if not exists idx_alerts_status on alerts(status);
create index if not exists idx_alerts_triggered_at on alerts(triggered_at desc);

-- ============================================================
-- ROW LEVEL SECURITY (scaffold — enable when auth is wired)
-- ============================================================
-- alter table alert_preferences enable row level security;
-- alter table watchlist enable row level security;
-- create policy "Users manage own preferences" on alert_preferences
--   using (auth.uid() = user_id);
-- create policy "Users manage own watchlist" on watchlist
--   using (auth.uid() = user_id);
