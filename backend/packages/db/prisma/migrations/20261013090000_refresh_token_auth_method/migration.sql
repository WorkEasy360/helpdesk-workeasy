-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "authMethod" TEXT NOT NULL DEFAULT 'PASSWORD';

