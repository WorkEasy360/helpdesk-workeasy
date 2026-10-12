-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "workeasy360OrganizationId" UUID;

-- CreateTable
CREATE TABLE "external_identities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "lastLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_identities_organizationId_idx" ON "external_identities"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_issuer_subject_organizationId_key" ON "external_identities"("issuer", "subject", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_issuer_userId_key" ON "external_identities"("issuer", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_workeasy360OrganizationId_key" ON "organizations"("workeasy360OrganizationId");

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

