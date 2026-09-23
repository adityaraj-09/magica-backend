-- AlterTable
ALTER TABLE "projects" ADD COLUMN "icon" TEXT NOT NULL DEFAULT 'writing';
ALTER TABLE "projects" ADD COLUMN "memoryEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "projects" ADD COLUMN "instructions" TEXT NOT NULL DEFAULT '';
