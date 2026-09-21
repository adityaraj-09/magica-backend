-- Applied AFTER `prisma migrate`. Prisma cannot express partial unique indexes.
-- Rollback: DROP INDEX CONCURRENTLY each index below, then migrate down.

-- One active agent turn per chat. Waiting/stopping still count as active so a
-- second send cannot sneak in while a waitpoint or cancel is in flight.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_runs_one_active_per_chat
  ON agent_runs ("chatId")
  WHERE status IN ('QUEUED', 'THINKING', 'WORKING', 'WAITING', 'STOPPING');

-- Duplicate Transloadit assembly completion must not create a second attachment.
-- Generated assets leave these columns null and are not covered here.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS attachments_assembly_file_uidx
  ON attachments ("transloaditAssemblyId", "transloaditFileId")
  WHERE "transloaditAssemblyId" IS NOT NULL
    AND "transloaditFileId" IS NOT NULL;

-- Client message ids are optional on assistant/system/tool rows.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS messages_chat_client_uidx
  ON messages ("chatId", "clientMessageId")
  WHERE "clientMessageId" IS NOT NULL;

-- A run may only have one unanswered waitpoint at a time.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS waitpoints_one_open_per_run
  ON waitpoints ("agentRunId")
  WHERE status = 'WAITING';
