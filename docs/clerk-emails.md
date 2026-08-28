# E-maily z Clerku

Texty transakčních e-mailů, které Clerk posílá uživatelům (registrace,
přihlášení, změny účtu). Šablony se editují v Clerk dashboardu
(**Customization → Emails**), tenhle soubor je zdroj pravdy — když se text
změní tam, patří změna i sem, ať zůstanou všechny e-maily konzistentní.

Upravuje se **jen text**. Rozvržení šablony, `{{> app_logo}}`, tlačítka a
patičku Clerk vykresluje sám; do HTML není důvod sahat.

## Pravidla, ať to drží pohromadě

1. **Česky, vykání, bez vykřičníků.** Stejný tón jako web: věcně, krátce,
   žádný marketing a žádné „Vítejte v naší platformě".
2. **`{{app.name}}` se nikdy neskloňuje.** Proměnná vrátí „Dawmain" v prvním
   pádě, takže buď stojí samostatně („Registrace do služby {{app.name}}"),
   nebo se pád nese na obecném podstatném jménu před ní (*služba*, *server*,
   *aplikace*). Nikdy ne „do {{app.name}}u".
3. **Čas zkratkou: `{{ttl_minutes}} min.`** Číslo v proměnné neznáme dopředu,
   a „2 minuty" vs. „10 minut" by se rozešlo. Zkratka platí pro obojí.
4. **Jeden e-mail = jedna akce.** Nadpis říká, co se stane; tlačítko je stejné
   sloveso v infinitivu (Dokončit registraci → nadpis „Dokončete registraci").
5. **Stejná patička všude.** Blok „Nežádali jste o to?" má ve všech šablonách
   identické znění, mění se jen podstatné jméno akce (registrace / přihlášení /
   změna hesla).
6. **Předmět bez názvu aplikace**, bez emoji, do ~40 znaků. Odesílatele
   uživatel vidí, opakovat ho v předmětu je zbytečné.
7. **Proměnné se opisují přesně** — `{{app.name}}`, `{{ttl_minutes}}`,
   `{{otp_code}}`, `{{requested_from}}`, `{{requested_at}}`,
   `{{current_year}}`. Překlep v proměnné se v náhledu neprojeví, teprve
   v odeslaném e-mailu.

## Sdílené bloky

Patička (poslední odstavec těla, tučný nadpis + text):

> **Nežádali jste o to?**
> Odkaz byl vyžádán z {{requested_from}} ({{requested_at}}). Pokud jste to
> nebyli vy, stačí tenhle e-mail ignorovat.

U šablon s kódem místo odkazu se první slovo mění na „Kód byl vyžádán z…".

Copyright (Clerk vkládá sám, ponechat):

> © {{current_year}} {{app.name}}

Náhradní odkaz pod tlačítkem:

> Pokud tlačítko nefunguje, klikněte sem.

## Šablony

### Sign-up link — „Váš odkaz pro registraci"

| Pole | Text |
| --- | --- |
| Předmět | Váš odkaz pro registraci |
| Nadpis | Dokončete registraci |
| Odstavec | Kliknutím na tlačítko níže dokončíte registraci do služby {{app.name}}. Odkaz platí {{ttl_minutes}} min. |
| Tlačítko | Dokončit registraci |
| Pod tlačítkem | Pokud tlačítko nefunguje, klikněte sem. |
| Patička | **Nežádali jste o registraci?** Odkaz byl vyžádán z {{requested_from}} ({{requested_at}}). Pokud jste to nebyli vy, stačí tenhle e-mail ignorovat. |

### Verification code (sign-up) — „Ověřovací kód"

Používá se, když registrace běží na kód místo odkazu.

| Pole | Text |
| --- | --- |
| Předmět | Ověřovací kód |
| Nadpis | Ověřte svůj e-mail |
| Odstavec | Registraci do služby {{app.name}} dokončíte zadáním tohohle kódu. Platí {{ttl_minutes}} min. |
| Kód | {{otp_code}} |
| Patička | **Nežádali jste o registraci?** Kód byl vyžádán z {{requested_from}} ({{requested_at}}). Pokud jste to nebyli vy, stačí tenhle e-mail ignorovat. |

### Sign-in link — „Váš odkaz pro přihlášení"

Sourozenec registračního e-mailu; drží se stejné struktury.

| Pole | Text |
| --- | --- |
| Předmět | Váš odkaz pro přihlášení |
| Nadpis | Přihlášení do služby {{app.name}} |
| Odstavec | Kliknutím na tlačítko níže se přihlásíte. Odkaz platí {{ttl_minutes}} min. |
| Tlačítko | Přihlásit se |
| Pod tlačítkem | Pokud tlačítko nefunguje, klikněte sem. |
| Patička | **Nežádali jste o přihlášení?** Odkaz byl vyžádán z {{requested_from}} ({{requested_at}}). Pokud jste to nebyli vy, stačí tenhle e-mail ignorovat. |
