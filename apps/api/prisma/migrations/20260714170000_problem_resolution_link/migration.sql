-- Tie a governed commercial correction to exactly one production problem.

ALTER TABLE "order_resolution_cases"
ADD COLUMN "problemId" TEXT;

CREATE UNIQUE INDEX "order_resolution_cases_problemId_key"
ON "order_resolution_cases"("problemId");

ALTER TABLE "order_resolution_cases"
ADD CONSTRAINT "order_resolution_cases_problemId_fkey"
FOREIGN KEY ("problemId") REFERENCES "production_problems"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
