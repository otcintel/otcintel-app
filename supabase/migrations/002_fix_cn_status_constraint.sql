-- Migration 002: Fix convertible_notes status CHECK constraint
--
-- The original constraint was narrower than the ConvertibleNote TypeScript type.
-- Missing: 'settled', 'cancelled', 'unknown'
-- Spurious: 'amended' (not in the TypeScript type)
--
-- Correct set matches ConvertibleNote['status'] exactly:
--   'outstanding' | 'converted' | 'repaid' | 'settled' | 'cancelled' | 'matured' | 'unknown'

ALTER TABLE convertible_notes
  DROP CONSTRAINT IF EXISTS convertible_notes_status_check;

ALTER TABLE convertible_notes
  ADD CONSTRAINT convertible_notes_status_check
  CHECK (status IN ('outstanding','converted','repaid','settled','cancelled','matured','unknown'));
