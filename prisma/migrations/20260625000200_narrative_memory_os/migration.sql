DO $$
BEGIN
  ALTER TYPE "MemoryItemType" ADD VALUE IF NOT EXISTS 'RELATIONSHIP';
  ALTER TYPE "MemoryItemType" ADD VALUE IF NOT EXISTS 'WORLD_RULE';
  ALTER TYPE "MemoryItemType" ADD VALUE IF NOT EXISTS 'QUALITY_CHECK';
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StoryLoopStatus') THEN
    CREATE TYPE "StoryLoopStatus" AS ENUM ('OPEN', 'RESOLVED', 'DROPPED');
  END IF;
END $$;

ALTER TABLE "ProjectVersion" ADD COLUMN IF NOT EXISTS "qualityCheck" JSONB;
ALTER TABLE "MemoryItem" ADD COLUMN IF NOT EXISTS "isEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MemoryItem" ADD COLUMN IF NOT EXISTS "source" TEXT;

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'pgvector extension is not available in this database; keeping JSON embeddings only. %', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE "MemoryItem" ADD COLUMN IF NOT EXISTS "embeddingVector" vector(64);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CharacterProfile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "role" TEXT,
  "appearance" TEXT,
  "personality" TEXT,
  "relationshipState" TEXT,
  "visualLock" TEXT,
  "referenceImageUrl" TEXT,
  "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "firstSeenVersionId" UUID,
  "lastSeenVersionId" UUID,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CharacterProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StoryLoop" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "createdVersionId" UUID,
  "resolvedVersionId" UUID,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" "StoryLoopStatus" NOT NULL DEFAULT 'OPEN',
  "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  "evidence" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoryLoop_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CharacterProfile_projectId_name_key" ON "CharacterProfile"("projectId", "name");
CREATE INDEX IF NOT EXISTS "CharacterProfile_userId_projectId_idx" ON "CharacterProfile"("userId", "projectId");
CREATE INDEX IF NOT EXISTS "CharacterProfile_projectId_importance_idx" ON "CharacterProfile"("projectId", "importance");

CREATE UNIQUE INDEX IF NOT EXISTS "StoryLoop_projectId_title_key" ON "StoryLoop"("projectId", "title");
CREATE INDEX IF NOT EXISTS "StoryLoop_userId_projectId_idx" ON "StoryLoop"("userId", "projectId");
CREATE INDEX IF NOT EXISTS "StoryLoop_projectId_status_idx" ON "StoryLoop"("projectId", "status");
CREATE INDEX IF NOT EXISTS "StoryLoop_projectId_importance_idx" ON "StoryLoop"("projectId", "importance");
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_isEnabled_idx" ON "MemoryItem"("projectId", "isEnabled");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CharacterProfile_userId_fkey') THEN
    ALTER TABLE "CharacterProfile"
      ADD CONSTRAINT "CharacterProfile_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CharacterProfile_projectId_fkey') THEN
    ALTER TABLE "CharacterProfile"
      ADD CONSTRAINT "CharacterProfile_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StoryLoop_userId_fkey') THEN
    ALTER TABLE "StoryLoop"
      ADD CONSTRAINT "StoryLoop_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StoryLoop_projectId_fkey') THEN
    ALTER TABLE "StoryLoop"
      ADD CONSTRAINT "StoryLoop_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
