-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "chats" ADD COLUMN "projectId" UUID;

-- CreateIndex
CREATE INDEX "projects_userId_createdAt_id_idx" ON "projects"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "projects_userId_deletedAt_createdAt_id_idx" ON "projects"("userId", "deletedAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "chats_userId_projectId_lastMessageAt_id_idx" ON "chats"("userId", "projectId", "lastMessageAt", "id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
