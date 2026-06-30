CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MemoryItemType') THEN
    CREATE TYPE "MemoryItemType" AS ENUM ('CHARACTER', 'OBJECT', 'SCENE', 'EVENT', 'CLUE', 'STYLE');
  END IF;
END $$;

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "stateVector" JSONB;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "openLoops" JSONB;
ALTER TABLE "ProjectVersion" ADD COLUMN IF NOT EXISTS "stateVector" JSONB;
ALTER TABLE "ProjectVersion" ADD COLUMN IF NOT EXISTS "openLoops" JSONB;

CREATE TABLE IF NOT EXISTS "MemoryItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "versionId" UUID,
  "type" "MemoryItemType" NOT NULL,
  "title" TEXT,
  "content" TEXT NOT NULL,
  "keywords" JSONB,
  "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "recency" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "embedding" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MemoryItem_userId_createdAt_idx" ON "MemoryItem"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_type_idx" ON "MemoryItem"("projectId", "type");
CREATE INDEX IF NOT EXISTS "MemoryItem_versionId_idx" ON "MemoryItem"("versionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MemoryItem_userId_fkey') THEN
    ALTER TABLE "MemoryItem"
      ADD CONSTRAINT "MemoryItem_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MemoryItem_projectId_fkey') THEN
    ALTER TABLE "MemoryItem"
      ADD CONSTRAINT "MemoryItem_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MemoryItem_versionId_fkey') THEN
    ALTER TABLE "MemoryItem"
      ADD CONSTRAINT "MemoryItem_versionId_fkey"
      FOREIGN KEY ("versionId") REFERENCES "ProjectVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
