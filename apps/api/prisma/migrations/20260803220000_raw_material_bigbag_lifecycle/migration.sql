BEGIN;

DO $$
DECLARE
  material RECORD;
  target_id TEXT;
BEGIN
  FOR material IN
    SELECT *
    FROM (
      VALUES
        ('rmd-base-primary', 'ПВД Первичное', 'пвд первичное', 'base'),
        ('rmd-base-secondary', 'ПВД Вторичное', 'пвд вторичное', 'base'),
        ('rmd-base-aika', 'ПВД Айка', 'пвд айка', 'base'),
        ('rmd-base-pvd-tsp', 'ПВД ТСП', 'пвд тсп', 'base'),
        ('rmd-base-danaflex', 'Данафлекс', 'данафлекс', 'base'),
        ('rmd-base-stretch', 'Стрейч', 'стрейч', 'base'),
        ('rmd-product-antiblock', 'Антиблок', 'антиблок', 'custom'),
        ('rmd-product-antistatic', 'Антистатик', 'антистатик', 'custom'),
        ('rmd-product-pvd-mel', 'ПВД МЕЛ', 'пвд мел', 'custom'),
        ('rmd-product-pvd-primary-108', 'ПВД Первичка 108', 'пвд первичка 108', 'custom'),
        ('rmd-product-pvd-primary-153', 'ПВД Первичка 153', 'пвд первичка 153', 'custom'),
        ('rmd-product-pvd-primary-tape', 'ПВД Первичка ленты', 'пвд первичка ленты', 'custom'),
        ('rmd-product-pvd-primary-ll092', 'ПВД Первичка линейка LL092', 'пвд первичка линейка ll092', 'custom'),
        ('rmd-product-pvd-primary-blue-tape', 'ПВД Первичка синие ленты', 'пвд первичка синие ленты', 'custom'),
        ('rmd-product-pnd-primary', 'ПНД Первичка', 'пнд первичка', 'custom'),
        ('rmd-product-pnd-primary-hd', 'ПНД Первичка HD', 'пнд первичка hd', 'custom'),
        ('rmd-product-pp-primary', 'ПП Первичка', 'пп первичка', 'custom'),
        ('rmd-product-klinol', 'Клинол', 'клинол', 'custom'),
        ('rmd-product-color-yellow', 'Краситель желтый', 'краситель желтый', 'custom'),
        ('rmd-product-color-white', 'Краситель белый', 'краситель белый', 'custom'),
        ('rmd-product-color-green', 'Краситель зеленый', 'краситель зеленый', 'custom'),
        ('rmd-product-color-orange', 'Краситель оранжевый', 'краситель оранжевый', 'custom'),
        ('rmd-product-color-blue', 'Краситель синей', 'краситель синей', 'custom'),
        ('rmd-product-color-black', 'Краситель черный', 'краситель черный', 'custom'),
        ('rmd-product-chalk-additive', 'Меловая добавка', 'меловая добавка', 'custom'),
        ('rmd-product-processing-additive', 'Процессинговая добавка', 'процессинговая добавка', 'custom'),
        ('rmd-product-slip', 'Скользячка / слип', 'скользячка / слип', 'custom'),
        ('rmd-product-uv-stabilizer', 'Уф - стабилизатор', 'уф - стабилизатор', 'custom')
    ) AS desired("id", "name", "normalizedName", "kind")
  LOOP
    SELECT definition."id"
    INTO target_id
    FROM "raw_material_definitions" definition
    WHERE definition."normalizedName" = material."normalizedName"
    LIMIT 1;

    IF target_id IS NOT NULL THEN
      UPDATE "raw_material_definitions"
      SET
        "name" = material."name",
        "kind" = material."kind",
        "status" = 'active',
        "isProductionSelectable" = true,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = target_id;

      IF target_id <> material."id" AND EXISTS (
        SELECT 1
        FROM "raw_material_definitions"
        WHERE "id" = material."id"
      ) THEN
        UPDATE "raw_material_definitions"
        SET
          "status" = 'archived',
          "isProductionSelectable" = false,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = material."id";
      END IF;
    ELSIF EXISTS (
      SELECT 1
      FROM "raw_material_definitions"
      WHERE "id" = material."id"
    ) THEN
      UPDATE "raw_material_definitions"
      SET
        "name" = material."name",
        "normalizedName" = material."normalizedName",
        "kind" = material."kind",
        "status" = 'active',
        "isProductionSelectable" = true,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = material."id";
    ELSE
      INSERT INTO "raw_material_definitions" (
        "id", "name", "normalizedName", "kind", "status",
        "isProductionSelectable", "createdByRole", "createdAt", "updatedAt"
      )
      VALUES (
        material."id", material."name", material."normalizedName", material."kind",
        'active', true, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    END IF;

    target_id := NULL;
  END LOOP;
END
$$;

ALTER TABLE "big_bag_units"
  ADD COLUMN "registrationStatus" TEXT NOT NULL DEFAULT 'pending_scan',
  ADD COLUMN "location" TEXT NOT NULL DEFAULT 'warehouse',
  ADD COLUMN "locationRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastWarehouseMeasuredKg" DOUBLE PRECISION,
  ADD COLUMN "lastWarehouseMeasuredAt" TIMESTAMP(3),
  ADD COLUMN "lastWarehouseActorId" TEXT;

UPDATE "big_bag_units"
SET "registrationStatus" = 'registered',
    "location" = CASE WHEN "status" = 'in_use' THEN 'production' ELSE 'warehouse' END,
    "locationRevision" = 1;

ALTER TABLE "shift_bag_usages"
  ADD COLUMN "releasedReason" TEXT;

CREATE TABLE "big_bag_scan_tokens" (
  "id" TEXT NOT NULL,
  "bigBagId" TEXT NOT NULL,
  "token" CHAR(68) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "big_bag_scan_tokens_pkey" PRIMARY KEY ("id")
);

INSERT INTO "big_bag_scan_tokens" ("id", "bigBagId", "token")
SELECT
  'bbt-row-' || md5("id"),
  "id",
  'bbt_' || replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '')
FROM "big_bag_units";

CREATE TABLE "big_bag_movements" (
  "id" TEXT NOT NULL,
  "bigBagId" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "kind" TEXT NOT NULL,
  "fromLocation" TEXT,
  "toLocation" TEXT NOT NULL,
  "locationRevision" INTEGER NOT NULL,
  "operatorReportedKg" DOUBLE PRECISION,
  "warehouseMeasuredKg" DOUBLE PRECISION,
  "differenceKg" DOUBLE PRECISION,
  "differencePercent" DOUBLE PRECISION,
  "actorId" TEXT,
  "actorRole" "Role" NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "big_bag_movements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "big_bag_label_print_jobs" (
  "id" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "bigBagId" TEXT NOT NULL,
  "printerId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "failureReason" TEXT,
  "reason" TEXT,
  "replacesPrintJobId" TEXT,
  "gatewayCommandId" TEXT,
  "requestedById" TEXT,
  "requestedByRole" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "big_bag_label_print_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "big_bag_scan_tokens_bigBagId_key"
  ON "big_bag_scan_tokens"("bigBagId");
CREATE UNIQUE INDEX "big_bag_scan_tokens_token_key"
  ON "big_bag_scan_tokens"("token");
CREATE UNIQUE INDEX "big_bag_movements_operationKey_key"
  ON "big_bag_movements"("operationKey");
CREATE UNIQUE INDEX "big_bag_label_print_jobs_requestId_key"
  ON "big_bag_label_print_jobs"("requestId");
CREATE INDEX "bbu_lifecycle_idx"
  ON "big_bag_units"("registrationStatus", "location", "status", "createdAt", "id");
CREATE INDEX "big_bag_movements_bigBagId_createdAt_id_idx"
  ON "big_bag_movements"("bigBagId", "createdAt", "id");
CREATE INDEX "big_bag_label_print_jobs_bigBagId_createdAt_id_idx"
  ON "big_bag_label_print_jobs"("bigBagId", "createdAt", "id");

ALTER TABLE "big_bag_scan_tokens"
  ADD CONSTRAINT "big_bag_scan_tokens_bigBagId_fkey"
  FOREIGN KEY ("bigBagId") REFERENCES "big_bag_units"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "big_bag_movements"
  ADD CONSTRAINT "big_bag_movements_bigBagId_fkey"
  FOREIGN KEY ("bigBagId") REFERENCES "big_bag_units"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "big_bag_label_print_jobs"
  ADD CONSTRAINT "big_bag_label_print_jobs_bigBagId_fkey"
  FOREIGN KEY ("bigBagId") REFERENCES "big_bag_units"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "big_bag_label_print_jobs"
  ADD CONSTRAINT "big_bag_label_print_jobs_replacesPrintJobId_fkey"
  FOREIGN KEY ("replacesPrintJobId") REFERENCES "big_bag_label_print_jobs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "big_bag_units"
  ADD CONSTRAINT "big_bag_units_registration_status_check"
  CHECK ("registrationStatus" IN ('pending_scan', 'registered')),
  ADD CONSTRAINT "big_bag_units_location_check"
  CHECK ("location" IN ('warehouse', 'production')),
  ADD CONSTRAINT "big_bag_units_location_revision_check"
  CHECK ("locationRevision" >= 0);
ALTER TABLE "big_bag_scan_tokens"
  ADD CONSTRAINT "big_bag_scan_tokens_token_format_check"
  CHECK ("token" ~ '^bbt_[0-9a-f]{64}$');
ALTER TABLE "big_bag_movements"
  ADD CONSTRAINT "big_bag_movements_destination_check"
  CHECK ("toLocation" IN ('warehouse', 'production')),
  ADD CONSTRAINT "big_bag_movements_kind_check"
  CHECK ("kind" IN ('registration', 'to_production', 'to_warehouse')),
  ADD CONSTRAINT "big_bag_movements_request_fingerprint_check"
  CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "big_bag_label_print_jobs"
  ADD CONSTRAINT "big_bag_label_print_jobs_status_check"
  CHECK ("status" IN ('queued', 'submitted', 'uncertain', 'failed'));

COMMIT;
