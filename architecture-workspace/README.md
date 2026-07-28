# PadlHub Architecture Workspace

This folder is an isolated architecture project for the PadlHub LK migration.
It is intentionally separate from the current production docs, Node-RED exports,
runtime scripts, and Tilda artifacts.

## Purpose

- Map the current system before rewriting backend modules.
- Define the future API-first boundary for web, Android, and iOS.
- Keep diagrams, contracts, ADRs, and inventories versioned in Git.
- Avoid mixing architecture decisions with noisy legacy implementation files.

## Working Rules

- Do not store secrets, Mongo URIs, tokens, phone numbers, payment payloads, or client personal data here.
- Use anonymized examples only.
- Treat diagrams and OpenAPI files as source-of-truth artifacts.
- Prefer small, reviewable changes.
- Every important architecture choice should get an ADR.

## Recommended Tooling

Local on Mac:

- draw.io Desktop for manual `.drawio` diagrams.
- Mermaid files for lightweight diagrams in Git.
- Structurizr Lite for C4 modeling.
- Swagger UI or Redoc for OpenAPI preview.
- Redocly CLI or Spectral for OpenAPI linting.

Team/server later:

- GitFlic/GitVerse/self-hosted Git for shared review.
- draw.io Docker or sBoard for collaborative diagrams.
- Structurizr on-prem or static exports for canonical C4 views.
- Self-hosted Swagger UI/Redoc for API documentation.

## Folder Layout

```text
architecture-workspace/
  README.md
  SYSTEM_MAP_GUIDE.md
  CURRENT_SYSTEM_MAP.md
  diagrams/
    current-system-context.mmd
    current-container-view.mmd
    current-key-flows.mmd
  inventory/
    domains.md
    integrations.md
    data-stores.md
    endpoints-to-map.md
  openapi/
    padlhub-api/v1/openapi.yaml
  structurizr/
    workspace.dsl
  adr/
    0001-isolated-architecture-workspace.md
```

## First Milestone

Create a truthful current-state map:

1. User-facing entrypoints.
2. Runtime services and integrations.
3. Data stores and ownership.
4. Critical flows.
5. Pain points and migration seams.

After that, define the first stable `/api/v1` contract.
