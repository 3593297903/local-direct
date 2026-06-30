-- Add project versions so each regenerate can keep a lightweight history.
CREATE TABLE "ProjectVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "originalScript" TEXT NOT NULL,
    "optimizedScript" TEXT,
    "contentType" TEXT,
    "style" TEXT,
    "duration" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "storyboardImageUrl" TEXT,
    "storyboardImagePrompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectVersion_projectId_versionNumber_key" ON "ProjectVersion"("projectId", "versionNumber");
CREATE INDEX "ProjectVersion_projectId_createdAt_idx" ON "ProjectVersion"("projectId", "createdAt");

ALTER TABLE "ProjectVersion"
ADD CONSTRAINT "ProjectVersion_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ProjectVersion" (
    "id",
    "projectId",
    "versionNumber",
    "title",
    "originalScript",
    "optimizedScript",
    "contentType",
    "style",
    "duration",
    "status",
    "createdAt"
)
SELECT
    gen_random_uuid(),
    "id",
    1,
    "title",
    "originalScript",
    "optimizedScript",
    "contentType",
    "style",
    "duration",
    "status",
    "createdAt"
FROM "Project";

ALTER TABLE "StoryboardShot" ADD COLUMN "versionId" UUID;

UPDATE "StoryboardShot" AS shot
SET "versionId" = version."id"
FROM "ProjectVersion" AS version
WHERE version."projectId" = shot."projectId"
  AND version."versionNumber" = 1;

ALTER TABLE "StoryboardShot" ALTER COLUMN "versionId" SET NOT NULL;

DROP INDEX "StoryboardShot_projectId_shotNumber_key";

CREATE UNIQUE INDEX "StoryboardShot_versionId_shotNumber_key" ON "StoryboardShot"("versionId", "shotNumber");
CREATE INDEX "StoryboardShot_projectId_idx" ON "StoryboardShot"("projectId");

ALTER TABLE "StoryboardShot"
ADD CONSTRAINT "StoryboardShot_versionId_fkey"
FOREIGN KEY ("versionId") REFERENCES "ProjectVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
