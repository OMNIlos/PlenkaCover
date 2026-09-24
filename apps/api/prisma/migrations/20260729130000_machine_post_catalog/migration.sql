-- Keep stable POST-* codes and hardware bindings while applying the production machine catalog.
INSERT INTO "posts" ("id", "code", "name", "status", "agentStatus", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'POST-1', 'Бегемот', 'active', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'POST-2', 'ABC новая', 'active', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'POST-3', 'ABC старая', 'active', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'POST-4', 'Китайка старая', 'active', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'POST-5', 'Матиль', 'active', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'POST-6', 'Пнд новая', 'active', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'POST-7', 'Урп', 'active', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "updatedAt" = CURRENT_TIMESTAMP;
