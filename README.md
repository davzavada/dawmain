# Academic CRM

A simple, single-user CRM for managing academic relationships. Track scholars,
their affiliations and publications, record how you know them (met at a
conference, colleague, supervisor, …) and explore the whole network as an
interactive graph — with ORCID import to fill in profiles.

## Features

- **People** — searchable, taggable contact list; the detail panel shows
  affiliations (with time ranges), publications, typed relations and notes.
- **Network** — interactive graph (Cytoscape). Relation types are
  color-coded, directed types (supervisor, reviewer) get arrows, and dashed
  edges show co-authorships derived automatically from shared publications.
  Double-click a person to focus their neighborhood and expand hop by hop.
- **Publications** — ordered author lists that keep the name as printed;
  authors who aren't contacts yet land in a **suggestions inbox** where one
  click promotes them to a contact (or links them to an existing one).
- **ORCID import** — add a person from their ORCID iD, or complete an
  existing profile: employments/educations become affiliations, works become
  publications (deduplicated by DOI/title on re-import). Uses the public
  ORCID API, no key needed.
- **Institutions** — created automatically from affiliation and ORCID
  imports, manageable on their own tab.

Single user, no auth, one SQLite file. Schema carries OpenAlex / Semantic
Scholar ID columns so richer enrichment can be added later without
migrations.

## Stack

npm workspaces: `shared/` (zod schemas + types used by both sides),
`server/` (Fastify + built-in `node:sqlite`, run with tsx — no build step,
no native modules), `web/` (React + Vite + Tailwind + TanStack Query +
Cytoscape). The server serves the built SPA in production.

## Development

Requires Node ≥ 22.13 (for the built-in `node:sqlite`).

```bash
npm install
npm run dev        # server on :3000 + Vite on :5173 (open this one)
npm run seed       # sample data, only into an empty database
npm run typecheck  # strict tsc across all workspaces
```

The dev database lives in `./data/crm.sqlite` (gitignored). Migrations are
plain SQL files in `server/migrations/`, applied automatically at startup —
adding `002_*.sql` and restarting is the whole story.

## Run with Docker

```bash
docker compose up -d   # UI on http://localhost:3000, data in ./data/
```

Backup = copy `data/crm.sqlite` (or the whole `data/` folder).

## Home Assistant add-on

This repository is also a Home Assistant add-on repository:

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories** and add
   `https://github.com/davzavada/dawmain`.
2. Install **Academic CRM** and start it — it appears in the sidebar via
   ingress (no port setup, protected by your HA login). Data lives in the
   add-on's `/data` volume and is part of HA backups.

Releases: bump `version` in `academic-crm/config.yaml`, tag the commit
`v<version>` and push — `.github/workflows/publish.yml` builds the
multi-arch image (amd64 + aarch64) and pushes it to
`ghcr.io/davzavada/academic-crm`. **One-time setup:** after the first
publish, set the GHCR package's visibility to *Public* (GitHub → Packages →
academic-crm → Package settings) so Home Assistant instances can pull it.

## Extension points (deliberately out of v1)

OpenAlex / Semantic Scholar enrichment (ID + `source` columns are already in
the schema; `server/src/enrichment/` sets the pattern) · citation graph ·
BibTeX/RIS import/export · person merge UI · diacritics-insensitive search ·
tests/CI beyond strict TypeScript.
