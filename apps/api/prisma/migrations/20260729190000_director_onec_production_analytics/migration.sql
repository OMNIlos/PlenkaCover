-- Additive current mirror for read-only 1C production-report accounting evidence.
-- Source catalog GUIDs remain plain lossless references; only report ownership is relational.

CREATE TABLE "onec_production_reports" (
  "externalId" TEXT NOT NULL,
  "sourceVersion" TEXT,
  "number" TEXT NOT NULL,
  "date" TIMESTAMP(3),
  "posted" BOOLEAN NOT NULL DEFAULT false,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "organizationExternalId" TEXT,
  "warehouseExternalId" TEXT,
  "departmentExternalId" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onec_production_reports_pkey" PRIMARY KEY ("externalId")
);

CREATE TABLE "onec_production_output_lines" (
  "id" TEXT NOT NULL,
  "reportExternalId" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "nomenclatureExternalId" TEXT,
  "unitExternalId" TEXT,
  "unitName" TEXT,
  "quantity" DECIMAL(18,6) NOT NULL,
  CONSTRAINT "onec_production_output_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "onec_production_material_lines" (
  "id" TEXT NOT NULL,
  "reportExternalId" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "nomenclatureExternalId" TEXT,
  "productExternalId" TEXT,
  "unitExternalId" TEXT,
  "unitName" TEXT,
  "quantity" DECIMAL(18,6) NOT NULL,
  CONSTRAINT "onec_production_material_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "onec_production_reports_date_posted_deleted_idx"
  ON "onec_production_reports"("date", "posted", "deleted");

CREATE UNIQUE INDEX "onec_production_output_lines_reportExternalId_lineNumber_key"
  ON "onec_production_output_lines"("reportExternalId", "lineNumber");
CREATE INDEX "onec_production_output_lines_reportExternalId_idx"
  ON "onec_production_output_lines"("reportExternalId");
CREATE INDEX "onec_production_output_lines_nomenclatureExternalId_idx"
  ON "onec_production_output_lines"("nomenclatureExternalId");
CREATE INDEX "onec_production_output_lines_unitExternalId_idx"
  ON "onec_production_output_lines"("unitExternalId");

CREATE UNIQUE INDEX "onec_production_material_lines_reportExternalId_lineNumber_key"
  ON "onec_production_material_lines"("reportExternalId", "lineNumber");
CREATE INDEX "onec_production_material_lines_reportExternalId_idx"
  ON "onec_production_material_lines"("reportExternalId");
CREATE INDEX "onec_production_material_lines_nomenclatureExternalId_idx"
  ON "onec_production_material_lines"("nomenclatureExternalId");
CREATE INDEX "onec_production_material_lines_productExternalId_idx"
  ON "onec_production_material_lines"("productExternalId");
CREATE INDEX "onec_production_material_lines_unitExternalId_idx"
  ON "onec_production_material_lines"("unitExternalId");

ALTER TABLE "onec_production_output_lines"
  ADD CONSTRAINT "onec_production_output_lines_reportExternalId_fkey"
  FOREIGN KEY ("reportExternalId")
  REFERENCES "onec_production_reports"("externalId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "onec_production_material_lines"
  ADD CONSTRAINT "onec_production_material_lines_reportExternalId_fkey"
  FOREIGN KEY ("reportExternalId")
  REFERENCES "onec_production_reports"("externalId")
  ON DELETE CASCADE ON UPDATE CASCADE;
