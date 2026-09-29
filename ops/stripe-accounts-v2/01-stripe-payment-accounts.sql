-- PR #91 (ADR-0006): the stripe_payment_accounts change, for a database that
-- applySchema did not build. It is the stripe_payment_accounts block of
-- applySchema in packages/db/src/index.ts (main at 95ac49f), plus checks.
--
-- Run it as the role that owns the schema (the PLATFORM_DATABASE_URL role,
-- cloud_admin), so the new sequence and function belong to that role:
--
--   psql "$SHP0_PROD_DATABASE_URL" -X -f ops/stripe-accounts-v2/01-stripe-payment-accounts.sql
--
-- It runs in one transaction, and stops with nothing changed if:
--   - the role running it does not own `stores` (or `stripe_payment_accounts`);
--   - a saved row breaks one of the new rules (the rows are listed first).
-- A second run changes nothing.
--
-- Stores whose charges_enabled is true today, with no card payments status
-- read from Stripe, cannot take payments after this until their account is
-- read again: when an Admin opens the Store's Payments page, or on an account
-- event from the thin destination (step 2).

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── Checks: nothing is changed above the DDL ──

DO $$
DECLARE
  stores_owner name;
  accounts_owner name;
BEGIN
  SELECT tableowner INTO stores_owner FROM pg_tables
    WHERE schemaname = current_schema() AND tablename = 'stores';
  IF stores_owner IS NULL THEN
    RAISE EXCEPTION 'no stores table in the first schema of search_path (%): wrong database, search_path or role',
      current_setting('search_path');
  END IF;
  IF stores_owner <> current_user THEN
    RAISE EXCEPTION 'connected as %, but stores is owned by %: connect as %', current_user, stores_owner, stores_owner;
  END IF;
  SELECT tableowner INTO accounts_owner FROM pg_tables
    WHERE schemaname = current_schema() AND tablename = 'stripe_payment_accounts';
  IF accounts_owner IS NOT NULL AND accounts_owner <> current_user THEN
    RAISE EXCEPTION 'connected as %, but stripe_payment_accounts is owned by %', current_user, accounts_owner;
  END IF;
END $$;

SELECT to_regclass('stripe_payment_accounts') IS NOT NULL AS has_accounts,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'stripe_payment_accounts'
                  AND column_name = 'card_payments_status') AS has_status
\gset

\if :has_accounts
\echo
\echo 'Saved Stripe accounts:'
SELECT count(*) AS accounts,
       count(*) FILTER (WHERE charges_enabled) AS charges_enabled_now
  FROM stripe_payment_accounts;

\echo 'Rows the new rules refuse (each list must be empty):'
SELECT connect_account_id, count(*) AS stores
  FROM stripe_payment_accounts GROUP BY connect_account_id HAVING count(*) > 1;
SELECT store_id, connect_account_id
  FROM stripe_payment_accounts WHERE connect_account_id !~ '^acct_[A-Za-z0-9]{1,64}$';
\if :has_status
SELECT store_id, card_payments_status
  FROM stripe_payment_accounts
 WHERE card_payments_status IS NOT NULL
   AND card_payments_status NOT IN ('active', 'pending', 'restricted', 'unsupported');
\endif

DO $$
DECLARE
  duplicate integer;
  malformed integer;
  bad_status integer := 0;
BEGIN
  SELECT count(*) INTO duplicate FROM (
    SELECT 1 FROM stripe_payment_accounts GROUP BY connect_account_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO malformed FROM stripe_payment_accounts
    WHERE connect_account_id !~ '^acct_[A-Za-z0-9]{1,64}$';
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'stripe_payment_accounts'
                AND column_name = 'card_payments_status') THEN
    EXECUTE $q$SELECT count(*) FROM stripe_payment_accounts
                WHERE card_payments_status IS NOT NULL
                  AND card_payments_status NOT IN ('active', 'pending', 'restricted', 'unsupported')$q$
      INTO bad_status;
  END IF;
  IF duplicate + malformed + bad_status > 0 THEN
    RAISE EXCEPTION 'refused, nothing changed: % account id(s) saved for more than one Store, % malformed account id(s), % unknown status(es)',
      duplicate, malformed, bad_status;
  END IF;
END $$;
\else
\echo
\echo 'No stripe_payment_accounts table yet: it is created.'
\endif

-- ── The change: applySchema's stripe_payment_accounts block, unchanged ──

CREATE TABLE IF NOT EXISTS stripe_payment_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
  connect_account_id text NOT NULL,
  charges_enabled boolean NOT NULL DEFAULT false,
  card_payments_status text,
  status_read bigint,
  status_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stripe_payment_accounts
  ADD COLUMN IF NOT EXISTS card_payments_status text,
  ADD COLUMN IF NOT EXISTS status_read bigint,
  ADD COLUMN IF NOT EXISTS status_checked_at timestamptz,
  DROP COLUMN IF EXISTS details_submitted;
CREATE SEQUENCE IF NOT EXISTS stripe_account_reads;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_payment_accounts'::regclass
                   AND conname = 'stripe_payment_accounts_card_payments_status_check') THEN
    ALTER TABLE stripe_payment_accounts ADD CONSTRAINT stripe_payment_accounts_card_payments_status_check
      CHECK (card_payments_status IN ('active', 'pending', 'restricted', 'unsupported'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_payment_accounts'::regclass
                   AND conname = 'stripe_payment_accounts_enabled_only_when_active') THEN
    -- A flag no read of Stripe set cannot stand: off until the next read.
    UPDATE stripe_payment_accounts SET charges_enabled = false, updated_at = now()
      WHERE charges_enabled AND card_payments_status IS DISTINCT FROM 'active';
    ALTER TABLE stripe_payment_accounts ADD CONSTRAINT stripe_payment_accounts_enabled_only_when_active
      CHECK (NOT charges_enabled OR card_payments_status IS NOT DISTINCT FROM 'active');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_payment_accounts'::regclass
                   AND conname = 'stripe_payment_accounts_connect_account_id_key') THEN
    ALTER TABLE stripe_payment_accounts ADD CONSTRAINT stripe_payment_accounts_connect_account_id_key
      UNIQUE (connect_account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_payment_accounts'::regclass
                   AND conname = 'stripe_payment_accounts_connect_account_id_check') THEN
    ALTER TABLE stripe_payment_accounts ADD CONSTRAINT stripe_payment_accounts_connect_account_id_check
      CHECK (connect_account_id ~ '^acct_[A-Za-z0-9]{1,64}$');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION stripe_payment_accounts_keep_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only with its Store: the cascade runs once the Store row is gone.
    IF EXISTS (SELECT 1 FROM stores WHERE id = OLD.store_id) THEN
      RAISE EXCEPTION 'a Store''s saved Stripe account is never replaced (ADR-0006)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.connect_account_id IS DISTINCT FROM OLD.connect_account_id OR NEW.store_id IS DISTINCT FROM OLD.store_id THEN
    RAISE EXCEPTION 'a Store''s saved Stripe account is never replaced (ADR-0006)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stripe_payment_accounts_keep_account ON stripe_payment_accounts;
CREATE TRIGGER stripe_payment_accounts_keep_account BEFORE UPDATE OR DELETE ON stripe_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION stripe_payment_accounts_keep_account();

-- ── After ──

\echo
\echo 'After the change:'
SELECT count(*) AS accounts,
       count(*) FILTER (WHERE charges_enabled) AS charges_enabled,
       count(*) FILTER (WHERE card_payments_status IS NULL) AS awaiting_first_read
  FROM stripe_payment_accounts;
SELECT conname FROM pg_constraint
 WHERE conrelid = 'stripe_payment_accounts'::regclass AND conname LIKE 'stripe_payment_accounts_%'
 ORDER BY conname;

COMMIT;
\echo 'Committed.'
