# dawmain-mcp-server

Vzdálený [MCP](https://modelcontextprotocol.io) server přes Streamable HTTP,
postavený na Next.js + [`mcp-handler`](https://www.npmjs.com/package/mcp-handler)
a připravený k nasazení na Vercel.

Server je **bezstavový** — žádné session, žádný Redis. To je právě to, co mu
dovolí běžet na serverless funkci, která škáluje na nulu.

Jeden handler obsluhuje obě generace protokolu:

| Revize | Jak se s ní mluví |
| --- | --- |
| `2026-07-28` | bez handshaku; každý request nese `_meta` obálku a hlavičky `Mcp-Method` / `Mcp-Name`, které musí souhlasit s tělem |
| `2025-06-18` | klasický `initialize` handshake, obsloužený bezstavově |

## Struktura

```
app/api/mcp/route.ts   HTTP route + volitelná bearer autentizace
app/page.tsx           landing page, která ukáže URL endpointu a config snippety
src/mcp/server.ts      sestavení MCP serveru
src/mcp/config.ts      identita serveru a autentizace
src/mcp/tools/         jeden soubor = jeden nástroj
scripts/smoke.mjs      end-to-end test proti běžícímu endpointu
```

## Lokální vývoj

```bash
npm install
npm run dev            # http://localhost:3000, endpoint na /api/mcp
npm run smoke          # v druhém terminálu
```

`npm run smoke` promluví s endpointem přímo po drátě (bez klientské SDK), takže
když spadne, chyba je v serveru a ne v testovacím harnessu. Proti nasazenému
prostředí:

```bash
MCP_URL=https://<deployment>.vercel.app/api/mcp npm run smoke
```

Další kontroly: `npm run typecheck`, `npm run build`.

## Nástroje

| Nástroj | Co dělá |
| --- | --- |
| `dawmain_ping` | ověří, že server žije, a řekne, které nasazení odpovědělo (verze, čas, Vercel prostředí, region, commit) |
| `dawmain_echo` | vrátí zadaný text, volitelně transformovaný — **placeholder**, smaž ho, jakmile server dělá něco užitečného |

### Přidání nástroje

1. Vytvoř `src/mcp/tools/<jmeno>.ts`, který exportuje `register<Jmeno>(server)`.
2. Zaregistruj ho v poli `registrars` v `src/mcp/tools/index.ts`.

Kostra nástroje, který volá cizí API:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

const inputSchema = z.object({
  query: z.string().min(1).describe("Co hledat. Například: 'náhrada škody'"),
  limit: z.number().int().min(1).max(50).default(20).describe("Počet výsledků."),
});

export function registerSearch(server: McpServer): void {
  server.registerTool(
    "dawmain_search",
    {
      title: "Search",
      description: "Jedna věta, která přesně vymezí, co nástroj dělá.",
      inputSchema,
      outputSchema: z.object({ items: z.array(z.string()), hasMore: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
        headers: { authorization: `Bearer ${process.env.EXAMPLE_API_KEY}` },
      });

      if (!response.ok) {
        // Chybová hláška je pro model návod, co udělat jinak — ne jen stack trace.
        return {
          isError: true,
          content: [{ type: "text", text: `Search failed with HTTP ${response.status}. Zkrať dotaz nebo sniž limit a zkus to znovu.` }],
        };
      }

      const output = await response.json();
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
    },
  );
}
```

Pár pravidel, která se vyplatí držet: názvy nástrojů s prefixem služby a v
snake_case, popisy, které přesně odpovídají chování, `annotations` u každého
nástroje, stránkování u čehokoli, co vrací seznam, a chybové hlášky, ze kterých
model pozná, co má udělat jinak.

## Nasazení na Vercel

Vercel si Next.js detekuje sám, takže není potřeba žádný `vercel.json`.

**Přes Git integraci (doporučeno).** Ve Vercelu *Add New… → Project* → naimportuj
`davzavada/dawmain` → Deploy. Od té chvíle každý push do větve nasadí novou
verzi; produkční doména míří na výchozí větev, ostatní větve dostanou preview
URL.

**Přes CLI**, když chceš nasazovat z lokálu:

```bash
npx vercel link
npx vercel --prod
```

**Region.** Ve *Project Settings → Functions* vyber region blízko sobě
(`fra1`, Frankfurt) — u serveru, kterému model posílá desítky requestů za
konverzaci, je latence znát.

Po nasazení otevři kořen domény v prohlížeči: landing page ukáže URL endpointu
a hotové config snippety. Samotný `/api/mcp` v prohlížeči vrátí `405`, protože
odpovídá jen na MCP JSON-RPC — to je správné chování, ne chyba.

## Připojení klienta

```bash
claude mcp add --transport http dawmain https://<deployment>.vercel.app/api/mcp
```

Nebo v JSON configu klienta:

```json
{
  "mcpServers": {
    "dawmain": {
      "type": "http",
      "url": "https://<deployment>.vercel.app/api/mcp"
    }
  }
}
```

Klient, který umí jen stdio, se připojí přes
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "dawmain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<deployment>.vercel.app/api/mcp"]
    }
  }
}
```

## Autentizace

Bez konfigurace je endpoint **veřejný**. Jakmile nastavíš proměnnou prostředí
`MCP_BEARER_TOKEN` (ve Vercelu *Project Settings → Environment Variables*),
každý request musí nést `Authorization: Bearer <token>`; bez něj dostane `401`.

Sdílené heslo je schválně to nejjednodušší řešení. Na skutečné OAuth 2.1 —
metadata chráněného zdroje podle RFC 9728 a klienty podle CIMD — jsou v
`mcp-handler` připravené `withMcpAuth` a `protectedResourceHandler`; nahraď jimi
kontrolu v `app/api/mcp/route.ts`.

Než server zveřejníš, zvaž, co přes něj jde ven: veřejný MCP endpoint je
veřejné API se vším všudy.
