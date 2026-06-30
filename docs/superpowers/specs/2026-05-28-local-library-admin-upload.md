# Local Library Admin Upload

## Goal

Add a local admin workflow that lets the user upload preview images, GIFs, or videos and edit knowledge-library metadata from the browser without touching source files.

## Approach

Use local filesystem storage for this MVP:

- Uploaded media files are stored under `public/previews`.
- Editable knowledge items are stored in `data/knowledge-items.json`.
- The existing hardcoded `lib/knowledge.ts` items remain as defaults.
- Runtime library reads merge default items with local JSON items, with local items overriding defaults by `id`.

## Admin UI

Add `/admin/library` with a dark console-style form:

- Select existing item or create a new one.
- Edit type, category, name, description, tags, stability, use case, avoid text, and prompt.
- Upload `jpg`, `jpeg`, `png`, `webp`, `gif`, `mp4`, or `webm`.
- Save item through an API route.

## Frontend Library Preview

Library cards and drawers should prefer `previewUrl`:

- Image/GIF: render `<img>`.
- MP4/WebM: render `<video muted loop playsInline controls={false}>`.
- Missing media: fall back to the current CSS animation preview.

## API

Add:

- `GET /api/admin/library`: returns merged knowledge items.
- `POST /api/admin/library`: saves metadata and optional uploaded file.

For this local MVP, no auth gate is added because the app is running on the user's machine. Before public deployment, this route must be protected.

## Verification

- Typecheck and build pass.
- `/admin/library` loads.
- Saving metadata writes `data/knowledge-items.json`.
- Uploading a media file writes to `public/previews`.
- `/library?type=transition` shows uploaded media in place of dynamic preview.
