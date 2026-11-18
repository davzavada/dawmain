/**
 * Byte sizes as people read them in Czech: "12,4 MB", "1,2 GB", "850 kB"
 * (binary units — a quota of 100 MB is 100 × 1024² bytes — and a decimal
 * comma; a whole number drops its ",0"). Pure, no imports: shared by the
 * server's quota messages and the client (app/_zdroje/format.ts).
 */
export function formatBytes(bytes: number): string {
  const b = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const one = (n: number) => {
    const r = Math.round(n * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace(".", ",");
  };
  if (b >= 1024 ** 3) return `${one(b / 1024 ** 3)} GB`;
  // 1023,96 MB would round to "1024 MB": show it as GB.
  if (b >= 1024 ** 2) return Math.round((b / 1024 ** 2) * 10) / 10 >= 1024 ? `${one(b / 1024 ** 3)} GB` : `${one(b / 1024 ** 2)} MB`;
  if (b >= 1024) return Math.round(b / 1024) >= 1024 ? "1 MB" : `${Math.round(b / 1024)} kB`;
  return `${Math.round(b)} B`;
}

/**
 * "z" or "ze" before a number as it is read in the genitive ("ze 100" = ze
 * sta, "z 50" = z padesáti, "ze 2" = ze dvou). Only the integer part counts. Pure.
 */
export function zBefore(numeral: string): "z" | "ze" {
  const n = Number(/^\d+/.exec(numeral.replace(/\s/g, ""))?.[0] ?? "0");
  const ze = (d: number) => d === 2 || d === 3 || d === 4 || d === 6 || d === 7;
  if (n >= 1000) {
    const thousands = Math.floor(n / 1000);
    return thousands === 1 ? "z" : zBefore(String(thousands));
  }
  if (n >= 100) return Math.floor(n / 100) === 1 || ze(Math.floor(n / 100)) ? "ze" : "z";
  if (n >= 20) return ze(Math.floor(n / 10)) ? "ze" : "z";
  if (n >= 10) return [12, 13, 14, 16, 17].includes(n) ? "ze" : "z";
  return ze(n) ? "ze" : "z";
}
