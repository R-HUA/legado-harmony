BEGIN READ ONLY;
DO $$
BEGIN
  IF current_database() <> 'legado_commerce' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Unexpected administrative database identity';
  END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'Local administrator must be able to migrate and grant the claim ledger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qingye') THEN
    RAISE EXCEPTION 'Application role qingye is absent';
  END IF;
  IF to_regclass('public.theme_catalog') IS NULL THEN
    RAISE EXCEPTION 'Theme catalog is absent';
  END IF;
END $$;
COMMIT;
SELECT 'PASS: local database administrator available; no schema changes performed' AS result;
