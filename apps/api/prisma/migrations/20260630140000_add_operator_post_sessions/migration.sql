-- AlterTable
ALTER TABLE "weight_captures" ADD COLUMN     "postId" TEXT;

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_post_sessions" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "shiftId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "operator_post_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operator_post_sessions_operatorId_idx" ON "operator_post_sessions"("operatorId");

-- CreateIndex
CREATE INDEX "operator_post_sessions_postId_idx" ON "operator_post_sessions"("postId");

-- AddForeignKey
ALTER TABLE "operator_post_sessions" ADD CONSTRAINT "operator_post_sessions_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_post_sessions" ADD CONSTRAINT "operator_post_sessions_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_post_sessions" ADD CONSTRAINT "operator_post_sessions_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
