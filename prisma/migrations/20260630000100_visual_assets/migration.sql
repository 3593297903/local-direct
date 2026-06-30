CREATE TYPE "VisualAssetType" AS ENUM (
  'SHOT_STORYBOARD',
  'CHARACTER_TURNAROUND',
  'SCENE_KEYART',
  'PROP_SHEET'
);

CREATE TYPE "VisualAssetStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED'
);

CREATE TABLE "VisualAsset" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "versionId" UUID,
  "shotId" UUID,
  "shotNumber" INTEGER,
  "type" "VisualAssetType" NOT NULL,
  "name" TEXT NOT NULL,
  "prompt" TEXT,
  "imageUrl" TEXT,
  "status" "VisualAssetStatus" NOT NULL DEFAULT 'COMPLETED',
  "error" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VisualAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VisualAsset_userId_projectId_idx" ON "VisualAsset"("userId", "projectId");
CREATE INDEX "VisualAsset_projectId_versionId_idx" ON "VisualAsset"("projectId", "versionId");
CREATE INDEX "VisualAsset_versionId_shotNumber_idx" ON "VisualAsset"("versionId", "shotNumber");
CREATE INDEX "VisualAsset_shotId_type_idx" ON "VisualAsset"("shotId", "type");

ALTER TABLE "VisualAsset"
  ADD CONSTRAINT "VisualAsset_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisualAsset"
  ADD CONSTRAINT "VisualAsset_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisualAsset"
  ADD CONSTRAINT "VisualAsset_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "ProjectVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisualAsset"
  ADD CONSTRAINT "VisualAsset_shotId_fkey"
  FOREIGN KEY ("shotId") REFERENCES "StoryboardShot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
