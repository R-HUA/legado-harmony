BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public,pg_catalog;
DO $$ BEGIN
  IF current_database() <> 'legado_commerce' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Unexpected administrative database identity';
  END IF;
END $$;
CREATE TEMP TABLE super_theme_before ON COMMIT DROP AS
SELECT
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY sku) FROM membership_products p) AS products,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY theme_id) FROM
    (SELECT theme_id,price_points,valid_days,enabled,member_included FROM theme_catalog
     WHERE theme_id<>'obsidian-archive') t) AS themes,
  (SELECT relowner FROM pg_class WHERE oid='public.theme_catalog'::regclass) AS catalog_owner,
  (SELECT relacl::text FROM pg_class WHERE oid='public.theme_catalog'::regclass) AS catalog_acl;
