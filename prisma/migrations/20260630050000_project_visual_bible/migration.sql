CREATE TYPE "VisualEntityType" AS ENUM ('CHARACTER', 'SCENE', 'PROP', 'STYLE');

CREATE TYPE "VisualEntityStatus" AS ENUM ('CANDIDATE', 'APPROVED', 'LOCKED', 'ARCHIVED');

CREATE TYPE "ShotVisualReferenceRole" AS ENUM ('SUBJECT', 'BACKGROUND', 'PROP', 'STYLE');

ALTER TABLE "VisualAsset"
  ADD COLUMN "entityId" UUID,
  ADD COLUMN "variantKey" TEXT,
  ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "referenceWeight" DOUBLE PRECISION NOT NULL DEFAULT 1;

CREATE TABLE "ProjectVisualEntity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "type" "VisualEntityType" NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "canonicalPrompt" TEXT,
  "visualLock" TEXT,
  "negativeLock" TEXT,
  "status" "VisualEntityStatus" NOT NULL DEFAULT 'CANDIDATE',
  "primaryAssetId" UUID,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectVisualEntity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShotVisualReference" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "versionId" UUID NOT NULL,
  "shotId" UUID NOT NULL,
  "entityId" UUID NOT NULL,
  "role" "ShotVisualReferenceRole" NOT NULL DEFAULT 'SUBJECT',
  "order" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ShotVisualReference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectVisualEntity_projectId_key_key" ON "ProjectVisualEntity"("projectId", "key");
CREATE INDEX "ProjectVisualEntity_userId_projectId_idx" ON "ProjectVisualEntity"("userId", "projectId");
CREATE INDEX "ProjectVisualEntity_projectId_type_idx" ON "ProjectVisualEntity"("projectId", "type");
CREATE INDEX "ProjectVisualEntity_projectId_status_idx" ON "ProjectVisualEntity"("projectId", "status");

CREATE UNIQUE INDEX "ShotVisualReference_shotId_entityId_role_key" ON "ShotVisualReference"("shotId", "entityId", "role");
CREATE INDEX "ShotVisualReference_projectId_versionId_idx" ON "ShotVisualReference"("projectId", "versionId");
CREATE INDEX "ShotVisualReference_shotId_idx" ON "ShotVisualReference"("shotId");
CREATE INDEX "ShotVisualReference_entityId_idx" ON "ShotVisualReference"("entityId");

CREATE INDEX "VisualAsset_entityId_type_idx" ON "VisualAsset"("entityId", "type");
CREATE INDEX "VisualAsset_projectId_type_idx" ON "VisualAsset"("projectId", "type");

ALTER TABLE "ProjectVisualEntity"
  ADD CONSTRAINT "ProjectVisualEntity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectVisualEntity"
  ADD CONSTRAINT "ProjectVisualEntity_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectVisualEntity"
  ADD CONSTRAINT "ProjectVisualEntity_primaryAssetId_fkey"
  FOREIGN KEY ("primaryAssetId") REFERENCES "VisualAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ShotVisualReference"
  ADD CONSTRAINT "ShotVisualReference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShotVisualReference"
  ADD CONSTRAINT "ShotVisualReference_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShotVisualReference"
  ADD CONSTRAINT "ShotVisualReference_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "ProjectVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShotVisualReference"
  ADD CONSTRAINT "ShotVisualReference_shotId_fkey"
  FOREIGN KEY ("shotId") REFERENCES "StoryboardShot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShotVisualReference"
  ADD CONSTRAINT "ShotVisualReference_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "ProjectVisualEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisualAsset"
  ADD CONSTRAINT "VisualAsset_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "ProjectVisualEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
