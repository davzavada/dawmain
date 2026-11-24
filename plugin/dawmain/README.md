# Dawmain

Dawmain is a free, non-commercial research tool for Czech and EU law. It
connects Claude to the official databases and searches them live: e-Sbírka
(Czech statutes), the Chamber of Deputies' bills with their explanatory
reports, the Supreme Court, the Supreme Administrative Court, the
Constitutional Court (NALUS), the general courts, the Court of Justice of the
EU (InfoCuria), EUR-Lex, and the UKAŽ catalogue of Charles University for
legal literature. Every result carries a public link to the official source,
so the answer can be checked and cited.

The plugin adds two things:

- the **Dawmain connector** (remote MCP server at
  `https://dawmain.davidzavada.cz/api/mcp`); on first use you sign in with an
  e-mail address, and
- the **dawmain-reserse** skill, which makes Claude fetch the current research
  manual from the server (`dawmain_guide`) before it searches, and write a memo
  that cites every authority in the text.

Users with the free Pro mode can also search their own uploaded documents and
their Zotero library.

Website: https://dawmain.davidzavada.cz ·
Terms: https://dawmain.davidzavada.cz/podminky ·
Privacy: https://dawmain.davidzavada.cz/soukromi

## Install

In Claude (claude.ai, the desktop app or Cowork), add Dawmain from the
directory, or add the connector in one click from https://dawmain.davidzavada.cz.

In Claude Code:

```
/plugin install dawmain --marketplace davzavada/dawmain
```
