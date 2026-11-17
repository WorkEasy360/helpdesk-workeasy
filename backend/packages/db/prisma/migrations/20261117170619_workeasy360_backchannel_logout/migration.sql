-- CreateTable
CREATE TABLE "workeasy360_sign_ins" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "providerSid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "workeasy360_sign_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workeasy360_logout_tokens" (
    "issuer" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workeasy360_logout_tokens_pkey" PRIMARY KEY ("issuer","jti")
);

-- CreateIndex
CREATE UNIQUE INDEX "workeasy360_sign_ins_familyId_key" ON "workeasy360_sign_ins"("familyId");

-- CreateIndex
CREATE INDEX "workeasy360_sign_ins_issuer_providerSid_idx" ON "workeasy360_sign_ins"("issuer", "providerSid");

-- CreateIndex
CREATE INDEX "workeasy360_sign_ins_issuer_subject_idx" ON "workeasy360_sign_ins"("issuer", "subject");

-- CreateIndex
CREATE INDEX "workeasy360_sign_ins_organizationId_idx" ON "workeasy360_sign_ins"("organizationId");

-- CreateIndex
CREATE INDEX "workeasy360_sign_ins_userId_idx" ON "workeasy360_sign_ins"("userId");

-- CreateIndex
CREATE INDEX "workeasy360_logout_tokens_expiresAt_idx" ON "workeasy360_logout_tokens"("expiresAt");

-- AddForeignKey
ALTER TABLE "workeasy360_sign_ins" ADD CONSTRAINT "workeasy360_sign_ins_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workeasy360_sign_ins" ADD CONSTRAINT "workeasy360_sign_ins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
