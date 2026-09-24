-- CreateTable
CREATE TABLE "director_decisions" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "objectId" TEXT,
    "evidence" TEXT,
    "ownerRole" "Role" NOT NULL DEFAULT 'director',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "director_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "penalties" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT,
    "targetRole" "Role" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceObjectId" TEXT,
    "authorRole" "Role" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "penalties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_runtimes" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "ownerRole" "Role",
    "lastSeenAt" TIMESTAMP(3),
    "lastTestAt" TIMESTAMP(3),
    "parsedPayload" JSONB,
    "rawPayload" JSONB,
    "recovery" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_runtimes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_templates" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "setupStatus" TEXT NOT NULL DEFAULT 'draft',
    "assignments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "penalties_targetRole_idx" ON "penalties"("targetRole");
