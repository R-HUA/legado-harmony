BEGIN;
SET LOCAL lock_timeout='10s';
DO $$
BEGIN
  IF current_database() <> 'legado_commerce' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Unexpected administrative database identity';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='theme_catalog' AND column_name='acquisition') THEN
    UPDATE public.theme_catalog SET enabled=FALSE WHERE theme_id='obsidian-archive' AND acquisition='SUPER_CLAIM';
  END IF;
END $$;
COMMIT;
SELECT 'PASS: exclusive catalog disabled by administrator; all claim records retained' AS result;
