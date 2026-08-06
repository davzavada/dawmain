# Academic CRM

Personal CRM for managing academic relationships: track scholars, their
affiliations and publications, record how you know them (met at a conference,
colleague, supervisor…), and explore the whole network as an interactive graph.

- **People** — searchable contact list with tags, affiliations, publications
  and typed relations per person.
- **Network** — interactive graph; relation types are color-coded, derived
  co-authorship edges are dashed, double-click focuses a person's
  neighborhood.
- **Publications** — record works with ordered authors; co-author names you
  haven't added yet appear as suggestions to promote into contacts.
- **ORCID** — add a person from their ORCID iD or complete an existing
  profile (affiliations and publications import with dedup).

All data lives in a single SQLite file in the add-on's `/data` volume — it is
included in Home Assistant backups automatically.
