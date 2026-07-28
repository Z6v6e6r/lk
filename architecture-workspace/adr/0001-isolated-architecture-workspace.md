# ADR 0001: Isolate Architecture Workspace

Date: 2026-07-04

## Status

Accepted

## Context

The current PadlHub LK repository contains production frontend bundles, Tilda
templates, Node-RED flows, repair scripts, generated artifacts, temporary
reports, Android/iOS wrappers, and historical operational files.

Architecture migration work needs a clean place for:

- current-state system maps;
- future-state API and backend boundaries;
- OpenAPI contracts;
- C4 diagrams;
- migration decisions.

Mixing this work into existing implementation docs would make review harder and
increase the risk of accidental production-related edits.

## Decision

Create `architecture-workspace/` as an isolated architecture project inside the
repository.

This folder can later be moved to a separate repository or published as a
documentation portal without carrying the current implementation noise.

## Consequences

Positive:

- Architecture artifacts are easy to review.
- No production code or Node-RED artifacts are touched.
- OpenAPI and diagrams can evolve independently.
- The folder can become a standalone project.

Tradeoffs:

- Some information will duplicate current docs initially.
- The workspace must be kept up to date manually until automation exists.

## Follow-up

- Add OpenAPI lint/bundle commands.
- Add a docs preview Docker Compose file.
- Decide whether team diagrams should use draw.io Docker, sBoard, or Structurizr on-prem.
