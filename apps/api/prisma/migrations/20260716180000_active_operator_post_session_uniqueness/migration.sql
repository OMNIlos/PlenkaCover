BEGIN;

LOCK TABLE "operator_post_sessions" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "operator_post_sessions"
    WHERE "status" = 'active' AND "endedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'active operator post sessions with endedAt require explicit repair';
  END IF;
END
$$;

WITH ranked AS MATERIALIZED (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "operatorId"
      ORDER BY "startedAt" DESC, "id" DESC
    ) AS operator_rank,
    ROW_NUMBER() OVER (
      PARTITION BY "postId"
      ORDER BY "startedAt" DESC, "id" DESC
    ) AS post_rank
  FROM "operator_post_sessions"
  WHERE "status" = 'active'
),
losers AS (
  SELECT "id"
  FROM ranked
  WHERE operator_rank > 1 OR post_rank > 1
),
closed AS (
  UPDATE "operator_post_sessions" AS session
  SET
    "status" = 'closed',
    "endedAt" = COALESCE(session."endedAt", CURRENT_TIMESTAMP)
  FROM losers
  WHERE session."id" = losers."id"
  RETURNING session."id", session."operatorId", session."postId", session."shiftId"
)
INSERT INTO "domain_events" (
  "id",
  "family",
  "type",
  "objectId",
  "actorRole",
  "actorId",
  "detail",
  "oldValue",
  "newValue",
  "reason",
  "createdAt"
)
SELECT
  CONCAT('migration-32-operator-post-session-close-', closed."id"),
  'audit',
  'audit:operator_post_session_closed',
  closed."postId",
  'admin',
  NULL,
  jsonb_build_object(
    'sessionId', closed."id",
    'operatorId', closed."operatorId",
    'postId', closed."postId",
    'shiftId', closed."shiftId",
    'migrationReconciliation', TRUE
  ),
  jsonb_build_object('status', 'active'),
  jsonb_build_object('status', 'closed'),
  'Migration reconciliation: duplicate active operator/post session',
  CURRENT_TIMESTAMP
FROM closed;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "operator_post_sessions"
    WHERE "status" = 'active'
    GROUP BY "operatorId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate active operator sessions remain after reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "operator_post_sessions"
    WHERE "status" = 'active'
    GROUP BY "postId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate active post sessions remain after reconciliation';
  END IF;
END
$$;

CREATE UNIQUE INDEX "operator_post_sessions_active_operator_key"
ON "operator_post_sessions" ("operatorId")
WHERE "status" = 'active';

CREATE UNIQUE INDEX "operator_post_sessions_active_post_key"
ON "operator_post_sessions" ("postId")
WHERE "status" = 'active';

COMMIT;
