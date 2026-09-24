-- A machine post may have historical resolved breakdowns, but only one current
-- open machine_breakdown. All application writers serialize on the Post row;
-- this partial index is the final database boundary for future/raw writers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "production_problems"
    WHERE "postId" IS NOT NULL
      AND "type" = 'machine_breakdown'
      AND "status" = 'open'
    GROUP BY "postId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce open machine breakdown uniqueness: resolve duplicate open problems first';
  END IF;
END
$$;

CREATE UNIQUE INDEX "production_problems_one_open_breakdown_per_post_uidx"
  ON "production_problems" ("postId")
  WHERE "postId" IS NOT NULL
    AND "type" = 'machine_breakdown'
    AND "status" = 'open';
