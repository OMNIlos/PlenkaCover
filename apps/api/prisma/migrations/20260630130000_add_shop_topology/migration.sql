-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "agentStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "roll_dispatch_items" ADD COLUMN     "postId" TEXT;

-- AlterTable
ALTER TABLE "machine_assignments" ADD COLUMN     "postId" TEXT;

-- AlterTable
ALTER TABLE "device_runtimes" ADD COLUMN     "postId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "posts_code_key" ON "posts"("code");

-- CreateIndex
CREATE INDEX "roll_dispatch_items_postId_idx" ON "roll_dispatch_items"("postId");

-- CreateIndex
CREATE INDEX "device_runtimes_postId_idx" ON "device_runtimes"("postId");

-- AddForeignKey
ALTER TABLE "roll_dispatch_items" ADD CONSTRAINT "roll_dispatch_items_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_runtimes" ADD CONSTRAINT "device_runtimes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
