-- Preserve immutable provenance for templates created before version snapshots existed.
INSERT INTO "counterparty_order_template_versions"
  ("id", "templateId", "version", "positions", "createdById", "createdAt")
SELECT
  'ctv-backfill-' || md5(template."id" || ':' || template."version"::text),
  template."id",
  template."version",
  template."positions",
  template."createdById",
  template."updatedAt"
FROM "counterparty_order_templates" AS template
WHERE NOT EXISTS (
  SELECT 1
  FROM "counterparty_order_template_versions" AS version
  WHERE version."templateId" = template."id"
    AND version."version" = template."version"
)
ON CONFLICT ("templateId", "version") DO NOTHING;
