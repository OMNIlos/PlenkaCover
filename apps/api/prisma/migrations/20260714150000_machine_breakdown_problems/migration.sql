-- Поломка станка как ProductionProblem (дизайн 2026-07-14):
-- machine_breakdown не привязан к заказу (orderId становится необязательным),
-- вместо этого проблема ссылается на пост (postId).
ALTER TABLE "production_problems" ALTER COLUMN "orderId" DROP NOT NULL;

ALTER TABLE "production_problems" ADD COLUMN "postId" TEXT;

ALTER TABLE "production_problems"
ADD CONSTRAINT "production_problems_postId_fkey"
FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "production_problems_postId_status_idx" ON "production_problems"("postId", "status");
