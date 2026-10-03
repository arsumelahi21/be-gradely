-- A new enum value cannot be used in the transaction that adds it, so it ships alone.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DIRECTOR';
