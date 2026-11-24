# Dawmain – podklady pro Connectors Directory

Koncept textů pro formulář na https://claude.ai/directory/manage → Submit new → MCP connector.
Limity polí podle https://claude.com/docs/connectors/building/submission.

## Connection

- Server URL: `https://dawmain.davidzavada.cz/api/mcp`
- URL: universal (všichni uživatelé stejná adresa)

## Listing

- **Server name** (≤ 100): Dawmain
- **One-liner** (≤ 200): Czech and EU legal research: live search in official legislation, case law, legislative history and doctrine, with a public source link for every hit.
- **Description** (≤ 2 000):

  Dawmain connects Claude to the official Czech and EU legal databases and answers from them live, so every statute, decision and record Claude relies on comes with a public URL to cite.

  Sources:
  - Czech legislation (e-Sbírka): acts and the text of any § in the version in force on a given date.
  - Czech case law: Nejvyšší soud, Nejvyšší správní soud, Ústavní soud, the regional administrative courts and the general courts (justice.cz), searchable together or one court at a time with each court's own filters.
  - Czech legislative history (Poslanecká sněmovna, psp.cz): parliamentary prints, explanatory memoranda, amendments and the stages of the legislative process.
  - EU law: EUR-Lex acts and their legislative history; judgments and opinions of the Court of Justice of the EU, in Czech.
  - Legal doctrine: catalogue records from UKAŽ (Charles University).
  - A citator: which later decisions cite a given Czech decision, to check it is still good law.
  - Slovak law on request: Slov-Lex legislation and court decisions, eLegislatíva legislative processes.

  With a personal sign-in and a Pro plan, users can also search their own uploaded books, commentaries and templates and their Zotero library, and save new items to Zotero.

  Claude gets a built-in research manual on first use: how to phrase Czech queries, read decisions in full, and cite court, date, docket number, paragraph and URL. All tools are read-only except zotero_save, which only adds a new item when the user asks.

- **Categories** (1–5): Legal, Research, Government / Public data (vyber z nabídky v portálu)
- **Documentation URL**: https://dawmain.davidzavada.cz
- **Privacy policy URL**: https://dawmain.davidzavada.cz/soukromi
- **Terms**: https://dawmain.davidzavada.cz/podminky
- **Support contact**: veřejný kontakt ze stránky /soukromi
- **Icon**: `app/apple-icon.png` (180×180 PNG) nebo `app/icon.svg`
- **URL slug**: `dawmain` (po zveřejnění nejde změnit)

## Use cases

- Primary use cases:
  1. „Najdi judikaturu Nejvyššího soudu k § 2201 občanského zákoníku z posledních pěti let“ – searches NS/NSS/ÚS, reads the decisions and cites them with links.
  2. „Jak zněl § 2235 o. z. k 1. 1. 2020 a co k němu říká důvodová zpráva?“ – historical version from e-Sbírka plus the explanatory memorandum from psp.cz.
  3. „Co říká SDEU k pojmu spotřebitel ve směrnici 93/13?“ – CJEU judgments in Czech and the EUR-Lex act.
  4. „Najdi v mých komentářích výklad § 1724“ – the user's own uploaded documents (Pro).
- Before connecting: nothing for public sources (free account via OAuth sign-in). Own documents and Zotero need a Pro plan and a personal sign-in; Zotero is connected on the Dawmain website.
- Reads / writes: reads; one write tool (zotero_save, create-only).

## Company

- Podává se z organizace Asendy v claude.ai, ale všechny údaje jsou osobní:
- Company name: David Závada (fyzická osoba)
- Website: https://dawmain.davidzavada.cz
- Primary contact: David Závada, veřejný kontakt z /soukromi

## Authentication

- Requirement: Always required (endpoint vrací 401 s `resource_metadata`)
- Method: OAuth sign-in, Dynamic Client Registration (Clerk, `https://clerk.davidzavada.cz`)
- Ověřeno: PKCE `S256`, `registration_endpoint`, `none` v `token_endpoint_auth_methods_supported`
- Callback, který musí Clerk povolit: `https://claude.ai/api/mcp/auth_callback` (konektor už v claude.ai běží, takže je povolený)

## Data handling

- API: vlastní server; dotazuje se veřejných oficiálních databází (e-Sbírka, soudy, psp.cz, EUR-Lex, CURIA, UKAŽ) a se souhlasem uživatele jeho Zotera.
- Personal health data: ne. Sponsored content: ne.

## Test & launch

- Všechny nástroje vyzkoušené jako custom connector v claude.ai.
- Testovací účet pro recenzenty (Verified review): připravit zvlášť, přihlašovací údaje se do portálu nezadávají.

## Tools

43 nástrojů (portál je načetl živě), všechny s `title`, `annotations.title` a anotacemi; vše `readOnlyHint: true`
kromě `zotero_save` (`readOnlyHint: false`, `destructiveHint: false`, jen vytváří).
