# Academic CRM

## Installation

1. In Home Assistant go to **Settings → Add-ons → Add-on Store**.
2. Open the **⋮** menu (top right) → **Repositories** and add
   `https://github.com/davzavada/dawmain`.
3. Install **Academic CRM** from the new section and start it.
4. Open it from the sidebar (ingress) — no port configuration needed.

Optionally map port `3000` in the add-on's Network settings if you also want
to reach the UI directly (e.g. `http://homeassistant.local:3000`) without
Home Assistant authentication in front of it.

## Usage

- **People** is the contact list. The right-hand panel shows everything about
  the selected person: tags, affiliations (institutions are created
  automatically by name), publications and relations.
- **Add from ORCID** fetches a public ORCID profile and lets you pick which
  fields, affiliations and publications to import. People with an ORCID iD on
  file get a **Complete from ORCID** button to re-sync later — already
  imported publications are recognized and skipped.
- **Publications**: when you record a publication, author names that are not
  contacts yet appear in the amber **Suggested people** inbox — promote them
  to contacts, link them to an existing person, or dismiss them.
- **Network** shows everyone as a graph. Solid colored edges are the
  relations you recorded (arrows mark directed types like supervisor);
  dashed gray edges are co-authorships derived from shared publications.
  Double-click a person to focus their neighborhood, then expand hop by hop.

## Data & backups

Everything is stored in a single SQLite database at `/data/crm.sqlite`,
which Home Assistant includes in its backups. To take a manual copy, snapshot
the add-on or copy that file.

## Notes

- Single-user tool: ingress rides Home Assistant's authentication; the
  optional direct port has no authentication of its own, so only expose it on
  a trusted network.
- The add-on needs outbound internet access only for ORCID imports
  (`pub.orcid.org`); everything else is fully local.
