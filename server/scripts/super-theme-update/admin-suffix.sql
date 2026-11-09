-- Catalog ownership/ACL remain unchanged. The append-only ledger needs only these two privileges.
GRANT SELECT,INSERT ON TABLE public.membership_theme_claims TO qingye;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM theme_catalog WHERE theme_id='obsidian-archive'
    AND acquisition='SUPER_CLAIM' AND price_points=0 AND member_included=FALSE AND enabled=TRUE) THEN
    RAISE EXCEPTION 'Exclusive theme catalog verification failed';
  END IF;
  IF (SELECT jsonb_agg(to_jsonb(p) ORDER BY sku) FROM membership_products p)
    IS DISTINCT FROM (SELECT products FROM super_theme_before) THEN
    RAISE EXCEPTION 'Existing membership products changed';
  END IF;
  IF (SELECT jsonb_agg(to_jsonb(t) ORDER BY theme_id) FROM
    (SELECT theme_id,price_points,valid_days,enabled,member_included FROM theme_catalog
     WHERE theme_id<>'obsidian-archive') t)
    IS DISTINCT FROM (SELECT themes FROM super_theme_before) THEN
    RAISE EXCEPTION 'Existing theme settings changed';
  END IF;
  IF (SELECT relowner FROM pg_class WHERE oid='public.theme_catalog'::regclass)
    IS DISTINCT FROM (SELECT catalog_owner FROM super_theme_before)
    OR (SELECT relacl::text FROM pg_class WHERE oid='public.theme_catalog'::regclass)
    IS DISTINCT FROM (SELECT catalog_acl FROM super_theme_before) THEN
    RAISE EXCEPTION 'Catalog ownership or permissions changed';
  END IF;
  IF NOT has_table_privilege('qingye','membership_theme_claims','SELECT')
    OR NOT has_table_privilege('qingye','membership_theme_claims','INSERT') THEN
    RAISE EXCEPTION 'Application claim ledger privileges missing';
  END IF;
END $$;
COMMIT;
SELECT 'PASS: migration 023 committed; existing catalog owner/ACL and product settings preserved' AS result;
