-- 002_backend_hardening.sql
-- Safe additive migration for production hardening

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS idempotency_records (
  user_id UUID NOT NULL,
  endpoint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status_code INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, endpoint, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_created_at ON idempotency_records(created_at);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  bucket TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_window_start ON rate_limit_windows(window_start);

ALTER TABLE shift_photos
  ADD COLUMN IF NOT EXISTS accuracy DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sha256 TEXT,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS file_size BIGINT,
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_bucket TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_window TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  IF p_limit <= 0 OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'rate limit config invalida';
  END IF;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO rate_limit_windows(bucket, window_start, hit_count)
  VALUES (p_bucket, v_window, 1)
  ON CONFLICT (bucket, window_start)
  DO UPDATE SET hit_count = rate_limit_windows.hit_count + 1
  RETURNING hit_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION idempotency_begin(
  p_user_id UUID,
  p_endpoint TEXT,
  p_key TEXT
)
RETURNS TABLE (
  is_new BOOLEAN,
  status_code INTEGER,
  response_body JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO idempotency_records(user_id, endpoint, idempotency_key)
  VALUES (p_user_id, p_endpoint, p_key)
  ON CONFLICT DO NOTHING;

  RETURN QUERY
  SELECT
    (status_code IS NULL) AS is_new,
    status_code,
    response_body
  FROM idempotency_records
  WHERE user_id = p_user_id
    AND endpoint = p_endpoint
    AND idempotency_key = p_key;
END;
$$;

CREATE OR REPLACE FUNCTION idempotency_finish(
  p_user_id UUID,
  p_endpoint TEXT,
  p_key TEXT,
  p_status_code INTEGER,
  p_response_body JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE idempotency_records
  SET
    status_code = p_status_code,
    response_body = p_response_body,
    updated_at = NOW()
  WHERE user_id = p_user_id
    AND endpoint = p_endpoint
    AND idempotency_key = p_key;
END;
$$;
