-- AlterTable
ALTER TABLE "ai_settings" ADD COLUMN     "assistantDailyLimit" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "assistantEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ai_usage_days" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "assistantMessages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_usage_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_days_organizationId_day_idx" ON "ai_usage_days"("organizationId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_days_organizationId_day_key" ON "ai_usage_days"("organizationId", "day");

-- AddForeignKey
ALTER TABLE "ai_usage_days" ADD CONSTRAINT "ai_usage_days_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
