ALTER TABLE "ProjectVersion"
ADD COLUMN "saveIdempotencyKey" TEXT;

UPDATE "ProjectVersion" AS version
SET "saveIdempotencyKey" = project."userId"::text || ':' || (version."contextSnapshot" ->> 'saveIdempotencyKey')
FROM "Project" AS project
WHERE project."id" = version."projectId"
  AND version."contextSnapshot" ->> 'saveIdempotencyKey' IS NOT NULL
  AND btrim(version."contextSnapshot" ->> 'saveIdempotencyKey') <> '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ProjectVersion"
    WHERE "saveIdempotencyKey" IS NOT NULL
    GROUP BY "saveIdempotencyKey"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate ProjectVersion saveIdempotencyKey values must be resolved before migration';
  END IF;
END $$;

CREATE UNIQUE INDEX "ProjectVersion_saveIdempotencyKey_key"
ON "ProjectVersion"("saveIdempotencyKey");
