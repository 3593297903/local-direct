# Claude Context For Local Director

Read `AGENTS.md` first. It is the source of truth for this local project.

This workspace is:

```text
E:\localdirector
```

Do not assume the active project is `E:\video-director-main`.

The product is a portable two-section copy of AI Video Director:

- `/dashboard` 工作台
- `/projects` 我的项目

The codebase still keeps internal/admin/library compatibility routes, but normal user navigation should stay focused on those two sections.

Use the isolated local runtime:

```text
Frontend:   http://localhost:3100
Nest API:   http://localhost:4100/api
PostgreSQL: localhost:55432
Redis:      localhost:56379
```

Before claiming work is complete, run the relevant checks:

```powershell
npm run typecheck
npm run api:typecheck
npm run build
```

Use `README-localdirector.md` for setup details and `docs/localdirector-project-context.md` for architecture context.
