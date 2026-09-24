ALTER TABLE "roll_dispatch_items"
ADD COLUMN "replacesDispatchItemId" TEXT;

CREATE UNIQUE INDEX "roll_dispatch_items_replacesDispatchItemId_key"
ON "roll_dispatch_items"("replacesDispatchItemId");

ALTER TABLE "roll_dispatch_items"
ADD CONSTRAINT "roll_dispatch_items_replacesDispatchItemId_fkey"
FOREIGN KEY ("replacesDispatchItemId")
REFERENCES "roll_dispatch_items"("id")
ON DELETE RESTRICT
ON UPDATE RESTRICT;
