-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "agentTokenHash" TEXT;

-- CreateTable
CREATE TABLE "gateway_commands" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "gateway_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_events" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "rawPayload" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "posts_agentTokenHash_key" ON "posts"("agentTokenHash");

-- CreateIndex
CREATE INDEX "gateway_commands_postId_status_idx" ON "gateway_commands"("postId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_events_eventId_key" ON "gateway_events"("eventId");

-- CreateIndex
CREATE INDEX "gateway_events_postId_idx" ON "gateway_events"("postId");

-- AddForeignKey
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_events" ADD CONSTRAINT "gateway_events_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
