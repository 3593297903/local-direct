# Project Visual Asset System Design

## Goal

Upgrade Local Director from a prompt-only workflow into a project visual bible workflow:
video prompts define what to shoot, while project visual assets define who, where, and which key props must stay consistent.

## Scope

This first version reuses the existing database models:

- `ProjectVisualEntity` is the fixed project-level visual object.
- `VisualAsset` is an image version attached to a visual object.
- `ShotVisualReference` remains the future bridge from shots to fixed visual objects.

No Prisma migration is required for this slice.

## Product Behavior

The project Asset Library becomes the control center for characters, scenes, props, and style references.

For each asset object, the user can:

- Generate the first image automatically from the entity's canonical prompt and visual lock.
- Regenerate a new image version when the result is not good enough.
- Save the generated image into the project asset library as a `VisualAsset`.
- Keep the generated asset tied to the project so later segments and storyboards can reference it.

The generated asset types map directly to existing enums:

- `CHARACTER` -> `CHARACTER_TURNAROUND`
- `SCENE` -> `SCENE_KEYART`
- `PROP` -> `PROP_SHEET`
- `STYLE` -> `SCENE_KEYART` with style metadata

## Architecture

Add a dedicated local Codex image queue for visual assets:

```text
Projects UI
  -> POST /api/visual-asset-image/jobs
  -> local JSON job in .tmp-visual-asset-codex
  -> visual-asset:codex-worker claims task
  -> codex exec uses $imagegen
  -> PNG saved to public/project-assets/visual-assets
  -> UI polls job
  -> UI saves completed image through /api/projects/visual-assets
```

This mirrors the existing storyboard image bridge but keeps asset jobs separate from shot storyboard jobs.

## Interfaces

Create job input:

```ts
{
  projectId: string;
  versionId: string;
  entityId: string;
  entityType: "CHARACTER" | "SCENE" | "PROP" | "STYLE";
  entityName: string;
  entityKey?: string;
  canonicalPrompt?: string;
  visualLock?: string;
  negativeLock?: string;
  mode?: "initial" | "regenerate" | "edit_text" | "edit_image";
  editInstruction?: string;
  referenceImageUrl?: string;
  size?: string;
  quality?: string;
}
```

Completed job output:

```ts
{
  status: "completed";
  task: {
    imageUrl: string;
    outputPath: string;
    prompt: string;
    assetType: VisualAssetType;
  }
}
```

## Generation Rules

Every asset image prompt must include:

- Project consistency language.
- The entity name and stable `@key`.
- Positive visual lock and negative lock.
- Clear asset format:
  - character turnaround / reference sheet
  - scene key art / layout reference
  - prop sheet / clean object reference
- No captions, watermarks, UI labels, or unrelated text.

## Safety And Reliability

The worker must:

- Capture full stdout/stderr logs per task.
- Detect global Codex quota errors with the shared runtime utility.
- Save only valid non-empty PNG output.
- Mark failed tasks with a readable message.
- Use a configurable concurrency value, defaulting to 2 for image generation stability.

## Frontend V1

In the Asset Library card:

- Empty asset shows "生成资产图".
- Existing asset shows "重新生成".
- During generation, the entity card shows a spinner and is disabled.
- On completion, the UI saves a new `VisualAsset` and refreshes the project detail.

Editing from text/image is represented in the queue contract now, but the first UI slice exposes initial generation and regeneration. Text/image editing can reuse the same endpoint later without another database change.

## Verification

Tests must prove:

- The queue creates one task with the right asset type and output path.
- The worker/API route files exist and call the queue functions.
- The Projects page has asset-library generation controls that call the visual asset job endpoint and save to `/api/projects/visual-assets`.
- Existing typecheck and tests still pass.
