-- DropIndex
DROP INDEX "gateway_events_eventId_key";

-- CreateIndex
CREATE UNIQUE INDEX "gateway_events_postId_eventId_key" ON "gateway_events"("postId", "eventId");
