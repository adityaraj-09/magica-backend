-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'STREAMING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'THINKING', 'WORKING', 'WAITING', 'STOPPING', 'COMPLETE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttachmentOrigin" AS ENUM ('UPLOAD', 'LIBRARY', 'GENERATED');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING', 'UPLOADING', 'PROCESSING', 'COMPLETE', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MessageAttachmentSource" AS ENUM ('DIRECT_UPLOAD', 'MEDIA_LIBRARY');

-- CreateEnum
CREATE TYPE "ToolProvider" AS ENUM ('MAGICA', 'E2B', 'EXA', 'SKILL', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ToolInvocationStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WaitpointType" AS ENUM ('OPTIONS', 'PLAN', 'CREDIT', 'MEDIA');

-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('WAITING', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CreditEntryType" AS ENUM ('GRANT', 'RESERVE', 'SETTLE', 'REFUND', 'ADJUST');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "creditBalance" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chatId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentRunId" UUID,
    "parentMessageId" UUID,
    "toolInvocationId" UUID,
    "clientMessageId" TEXT,
    "role" "MessageRole" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "contentBlocks" JSONB NOT NULL DEFAULT '[]',
    "searchText" VARCHAR(8192) NOT NULL DEFAULT '',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chatId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "userMessageId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "modelRequested" TEXT NOT NULL DEFAULT 'openrouter/free',
    "modelRouted" TEXT,
    "triggerRunId" TEXT,
    "traceId" TEXT NOT NULL,
    "processId" TEXT,
    "currentStep" TEXT,
    "progressPercent" INTEGER,
    "thinkingStartedAt" TIMESTAMP(3),
    "thinkingDurationMs" INTEGER,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "reservedCredits" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "settledCredits" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "chatId" UUID,
    "toolInvocationId" UUID,
    "origin" "AttachmentOrigin" NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING',
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "storageKey" TEXT,
    "url" TEXT,
    "thumbnailUrl" TEXT,
    "transloaditAssemblyId" TEXT,
    "transloaditFileId" TEXT,
    "tusUploadId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "messageId" UUID NOT NULL,
    "attachmentId" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "source" "MessageAttachmentSource" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_invocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentRunId" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "provider" "ToolProvider" NOT NULL,
    "status" "ToolInvocationStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "providerRunId" TEXT,
    "sequence" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "creditCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_skills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentRunId" UUID NOT NULL,
    "skillName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "assetPath" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentRunId" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "WaitpointType" NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'WAITING',
    "triggerWaitpointId" TEXT NOT NULL,
    "publicAccessToken" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "timeoutAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "chatId" UUID,
    "agentRunId" UUID,
    "toolInvocationId" UUID,
    "type" "CreditEntryType" NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "balanceAfter" DECIMAL(18,6) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "events" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "endpointId" UUID NOT NULL,
    "agentRunId" UUID,
    "toolInvocationId" UUID,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerkUserId_key" ON "users"("clerkUserId");

-- CreateIndex
CREATE INDEX "users_createdAt_id_idx" ON "users"("createdAt", "id");

-- CreateIndex
CREATE INDEX "chats_userId_lastMessageAt_id_idx" ON "chats"("userId", "lastMessageAt", "id");

-- CreateIndex
CREATE INDEX "chats_userId_isFavorite_lastMessageAt_id_idx" ON "chats"("userId", "isFavorite", "lastMessageAt", "id");

-- CreateIndex
CREATE INDEX "chats_userId_deletedAt_lastMessageAt_id_idx" ON "chats"("userId", "deletedAt", "lastMessageAt", "id");

-- CreateIndex
CREATE INDEX "chats_createdAt_id_idx" ON "chats"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_toolInvocationId_key" ON "messages"("toolInvocationId");

-- CreateIndex
CREATE INDEX "messages_chatId_createdAt_id_idx" ON "messages"("chatId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "messages_userId_createdAt_id_idx" ON "messages"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "messages_agentRunId_createdAt_id_idx" ON "messages"("agentRunId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "messages_parentMessageId_idx" ON "messages"("parentMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "messages_chatId_clientMessageId_key" ON "messages"("chatId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_userMessageId_key" ON "agent_runs"("userMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_idempotencyKey_key" ON "agent_runs"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_triggerRunId_key" ON "agent_runs"("triggerRunId");

-- CreateIndex
CREATE INDEX "agent_runs_chatId_createdAt_id_idx" ON "agent_runs"("chatId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "agent_runs_userId_createdAt_id_idx" ON "agent_runs"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "agent_runs_status_createdAt_id_idx" ON "agent_runs"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "agent_runs_triggerRunId_idx" ON "agent_runs"("triggerRunId");

-- CreateIndex
CREATE INDEX "agent_runs_traceId_idx" ON "agent_runs"("traceId");

-- CreateIndex
CREATE INDEX "attachments_userId_createdAt_id_idx" ON "attachments"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "attachments_chatId_createdAt_id_idx" ON "attachments"("chatId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "attachments_toolInvocationId_idx" ON "attachments"("toolInvocationId");

-- CreateIndex
CREATE INDEX "attachments_status_createdAt_idx" ON "attachments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "attachments_transloaditAssemblyId_idx" ON "attachments"("transloaditAssemblyId");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_transloaditAssemblyId_transloaditFileId_key" ON "attachments"("transloaditAssemblyId", "transloaditFileId");

-- CreateIndex
CREATE INDEX "message_attachments_chatId_createdAt_id_idx" ON "message_attachments"("chatId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_messageId_attachmentId_key" ON "message_attachments"("messageId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_messageId_sortOrder_key" ON "message_attachments"("messageId", "sortOrder");

-- CreateIndex
CREATE INDEX "tool_invocations_chatId_createdAt_id_idx" ON "tool_invocations"("chatId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "tool_invocations_userId_createdAt_id_idx" ON "tool_invocations"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "tool_invocations_provider_status_createdAt_idx" ON "tool_invocations"("provider", "status", "createdAt");

-- CreateIndex
CREATE INDEX "tool_invocations_providerRunId_idx" ON "tool_invocations"("providerRunId");

-- CreateIndex
CREATE INDEX "tool_invocations_agentRunId_sequence_idx" ON "tool_invocations"("agentRunId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "tool_invocations_agentRunId_toolCallId_key" ON "tool_invocations"("agentRunId", "toolCallId");

-- CreateIndex
CREATE INDEX "run_skills_agentRunId_createdAt_id_idx" ON "run_skills"("agentRunId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "run_skills_agentRunId_skillName_assetPath_key" ON "run_skills"("agentRunId", "skillName", "assetPath");

-- CreateIndex
CREATE UNIQUE INDEX "waitpoints_triggerWaitpointId_key" ON "waitpoints"("triggerWaitpointId");

-- CreateIndex
CREATE UNIQUE INDEX "waitpoints_idempotencyKey_key" ON "waitpoints"("idempotencyKey");

-- CreateIndex
CREATE INDEX "waitpoints_agentRunId_createdAt_id_idx" ON "waitpoints"("agentRunId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "waitpoints_chatId_status_idx" ON "waitpoints"("chatId", "status");

-- CreateIndex
CREATE INDEX "waitpoints_status_timeoutAt_idx" ON "waitpoints"("status", "timeoutAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_idempotencyKey_key" ON "credit_ledger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "credit_ledger_userId_createdAt_id_idx" ON "credit_ledger"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "credit_ledger_agentRunId_createdAt_id_idx" ON "credit_ledger"("agentRunId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "credit_ledger_toolInvocationId_idx" ON "credit_ledger"("toolInvocationId");

-- CreateIndex
CREATE INDEX "credit_ledger_chatId_createdAt_id_idx" ON "credit_ledger"("chatId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hashedKey_key" ON "api_keys"("hashedKey");

-- CreateIndex
CREATE INDEX "api_keys_userId_createdAt_id_idx" ON "api_keys"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_userId_createdAt_id_idx" ON "webhook_endpoints"("userId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_idempotencyKey_key" ON "webhook_deliveries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpointId_createdAt_id_idx" ON "webhook_deliveries"("endpointId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_createdAt_idx" ON "webhook_deliveries"("status", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_agentRunId_idx" ON "webhook_deliveries"("agentRunId");

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_parentMessageId_fkey" FOREIGN KEY ("parentMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "tool_invocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "tool_invocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_skills" ADD CONSTRAINT "run_skills_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitpoints" ADD CONSTRAINT "waitpoints_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitpoints" ADD CONSTRAINT "waitpoints_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitpoints" ADD CONSTRAINT "waitpoints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "tool_invocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "tool_invocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
