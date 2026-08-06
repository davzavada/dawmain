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

- **People** is the contact list, with a last-contact column and sorting by
  "recently contacted" / "longest silent". The right-hand panel shows
  everything about the selected person: the interaction timeline, tags,
  affiliations (institutions are created automatically by name),
  publications and color-coded relations. Duplicates can be merged from the
  Edit dialog.
- **Interactions**: log every touchpoint (meeting, conference, email, call)
  with a date and note from the person's panel — this is what drives the
  last-contact column.
- **Publications** doubles as your reading list: ★ star papers you like,
  click the status chip to cycle to-read → read, filter by shelf, and keep a
  personal note per paper. Author names that are not contacts yet appear in
  the amber **Suggested people** inbox — promote them to contacts, link them
  to an existing person, or dismiss them (undoable).
- **Add from ORCID** fetches a public ORCID profile and lets you pick which
  fields, affiliations and publications to import. People with an ORCID iD on
  file get a **Complete from ORCID** button to re-sync later — already
  imported publications are recognized and skipped.
- **Export** (top right) downloads the entire database as JSON.

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
