-- Run this in your Supabase SQL editor
-- https://supabase.com → your project → SQL Editor

-- ── Licenses table ───────────────────────────────────────────────
CREATE TABLE licenses (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,
  email       TEXT,
  stripe_session_id TEXT,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast license lookups
CREATE INDEX idx_licenses_key ON licenses(key);

-- ── Usage table (optional but useful for monitoring) ──────────────
CREATE TABLE usage (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  license_key TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Row Level Security ────────────────────────────────────────────
-- Only your backend (service key) can read/write — users cannot
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage ENABLE ROW LEVEL SECURITY;
