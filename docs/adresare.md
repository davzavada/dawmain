# Dawmain v adresářích Claude a ChatGPT

Jeden zdroj, dvě podání. Obojí stojí na stejném MCP serveru
(`https://dawmain.davidzavada.cz/api/mcp`), stejném logu a stejném skillu.

| Co | Kde v repu |
| --- | --- |
| Plugin pro Claude (konektor + skill) | `plugin/dawmain/` |
| Marketplace pro Claude Code | `.claude-plugin/marketplace.json` |
| Manifesty pro ChatGPT | `plugin/openai/plugin.json`, `plugin/openai/mcp.json` |
| ZIP pro ChatGPT | `DEMO_RECORDING_URL=… scripts/build-openai-plugin.sh` → `dist/dawmain-openai-plugin.zip` |
| Ověření domény pro OpenAI | `app/.well-known/openai-apps-challenge/route.ts` (env `OPENAI_APPS_CHALLENGE`) |

Skill v pluginu je jen rozcestník: plný rešeršní návod zůstává na serveru
(`dawmain_guide`), takže se nerozchází. Při změně verze zvedni `version`
v `plugin/dawmain/.claude-plugin/plugin.json` i `plugin/openai/plugin.json`.

Kontrola před podáním:

```
claude plugin validate ./plugin/dawmain --strict
claude plugin validate . --strict
```

## Claude

Podává se na <https://claude.ai/directory/manage> (jen placený plán).
Doporučené jsou dvě položky ze stejného účtu, které se pak propojí:

1. **MCP connector**: adresa výše, anotace nástrojů se načtou samy (test
   `tests/tool-annotations.test.ts` hlídá, že je má každý nástroj). Výpis:
   název Dawmain, jednořádkový popis, popis, kategorie (Research / Legal),
   dokumentace `https://github.com/davzavada/dawmain#readme`, zásady
   `https://dawmain.davidzavada.cz/soukromi`, podpora e-mailem, ikona
   `plugin/dawmain/logo.png`, slug `dawmain`. Autentizace OAuth 2.0 (Clerk,
   DCR). Před odesláním je třeba potvrdit, že každý nástroj běžel
   (v Claude jako vlastní konektor).
2. **Plugin bundle**: repozitář `davzavada/dawmain`, cesta `plugin/dawmain`,
   větev `main`; nové verze přes GitHub push webhook.

Po schválení má konektor trvalou adresu
`https://claude.ai/directory/connectors/dawmain` (slug potvrdí portál) a ta
patří na web místo dnešního odkazu „Přidat vlastní konektor“. Claude Code:
`/plugin install dawmain --marketplace davzavada/dawmain`.

Odpovědi k „Data handling“: osobní údaje jen e-mail účtu (Clerk) a u Pro
nahrané texty a připojení Zotera; dotazy jdou jen do veřejných oficiálních
databází uvedených v popisu; doba uchování podle zásad; není určeno osobám
pod 18 let.

## ChatGPT

Podává se na <https://platform.openai.com/plugins> → Upload plugin (ZIP).
Předem:

- **Ověření identity** v platform.openai.com/settings/organization/general
  (individual verification, publikuje se pod jménem). Projekt nesmí mít
  EU data residency.
- **Demo video**: `public/demo/dawmain-chatgpt-demo.mp4`, na webu
  `https://dawmain.davidzavada.cz/demo/dawmain-chatgpt-demo.mp4` (ChatGPT s Dawmainem:
  judikatura NS k § 2927 o. z. a znění § 52 zákoníku práce). Adresa jde do
  `DEMO_RECORDING_URL` při stavbě ZIPu.
- **Testovací účet** bez MFA, kódů a magic linků (Clerk: e-mail + heslo),
  vyplňuje se jen v portálu v „Review details“, nikdy ne do ZIPu.
- **Ověření domény**: token z portálu („Connect MCP server“) nastavit jako
  `OPENAI_APPS_CHALLENGE` na serveru; ověř
  `curl https://dawmain.davidzavada.cz/.well-known/openai-apps-challenge`.
- Pět pozitivních a tři negativní testovací dotazy jsou v
  `plugin/openai/plugin.json`; všechny pozitivní musí s testovacím účtem projít.

V hledání ChatGPT se plugin objeví až po zveřejnění (a v přehledu adresáře
jen když ho OpenAI vybere). Přímý odkaz na stránku pluginu ukáže portál po
zveřejnění; ten patří na web do sekce `#chatgpt`.
