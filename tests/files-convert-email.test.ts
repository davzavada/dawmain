// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { convertEmail, decodeCharset, decodeHeader, emailToHtml, parseEmail } from "@/src/files/convert/email";
import { convertFile, detectKind } from "@/src/files/convert/index";
import { DEFAULT_CONVERT_OPTIONS } from "@/src/files/convert/types";
import { parseDmd } from "@/src/files/dmd/parse";

/**
 * E-mail (.eml) → DMD (src/files/convert/email.ts): headers in every
 * encoding mail clients write, the MIME tree, the body from the plain or
 * the HTML part, attachments listed by name and never converted.
 */

const enc = new TextEncoder();
const crlf = (lines: string[]) => lines.join("\r\n");
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** multipart/mixed: (multipart/alternative: plain QP + html base64) + a PDF attachment + an inline logo. */
const MIXED = crlf([
  "Received: from mail.example.cz by mx.firma.cz; Thu, 12 Mar 2026 14:05:11 +0100",
  "From: =?UTF-8?B?" + b64("Jana Nováková") + "?= <jana@firma.cz>",
  "To: =?utf-8?Q?Petr_Dvo=C5=99=C3=A1k?= <petr@ak.cz>,",
  " kancelar@ak.cz",
  "Cc: asistentka@ak.cz",
  "Subject: =?UTF-8?Q?Smlouva_o_d=C3=ADlo_=E2=80=93?=",
  " =?UTF-8?Q?_p=C5=99ipom=C3=ADnky?=",
  "Date: Thu, 12 Mar 2026 14:05:09 +0100",
  "Message-ID: <tajne-id-123@firma.cz>",
  "X-Mailer: Tajný klient 9",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="XX"',
  "",
  "preambule, kterou nikdo nečte",
  "--XX",
  'Content-Type: multipart/alternative; boundary="YY"',
  "",
  "--YY",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Dobr=C3=BD den,",
  "",
  "pos=C3=ADl=C3=A1m p=C5=99ipom=C3=ADnky k =C4=8Dl. 5 smlouvy; lh=C5=AFta je =",
  "do p=C3=A1tku.",
  "> p=C5=AFvodn=C3=AD zpr=C3=A1va",
  "",
  "S pozdravem",
  "Jana",
  "--YY",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64("<html><body><p>HTML verze, která se nepoužije</p></body></html>"),
  "--YY--",
  "--XX",
  'Content-Type: application/pdf; name="=?UTF-8?B?' + b64("Smlouva o dílo.pdf") + '?="',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="=?UTF-8?B?' + b64("Smlouva o dílo.pdf") + '?="',
  "",
  b64("%PDF-1.7 tajný obsah přílohy"),
  "--XX",
  'Content-Type: image/png; name="logo.png"',
  "Content-Disposition: inline",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--XX--",
  "",
]);

/** A single-part HTML message in windows-1250 with raw 8-bit bytes in the header. */
function cp1250Html(): Uint8Array {
  const head = "From: advokat@ak.cz\r\nSubject: ";
  const subject = [0x56, 0xfd, 0x7a, 0x76, 0x61]; // "Výzva" in windows-1250
  const rest =
    '\r\nDate: Mon, 02 Feb 2026 08:00:00 +0100\r\nContent-Type: text/html; charset="windows-1250"\r\n\r\n' +
    "<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><table><tr><td><h2>Upomínka</h2>" +
    "<p>Dlužíte <b>12 000 Kč</b>.</p></td></tr></table><img src=cid:x><ul><li>první</li></ul></body></html>";
  // Encode `rest` as windows-1250 by hand: only the Czech letters used here.
  const map: Record<string, number> = { í: 0xed, ž: 0x9e, č: 0xe8 };
  const body = [...rest].map((c) => map[c] ?? c.charCodeAt(0));
  return new Uint8Array([...enc.encode(head), ...subject, ...body]);
}

describe("headers", () => {
  it("encoded words (B and Q, split over folded lines), and raw 8-bit bytes", () => {
    expect(decodeHeader("=?UTF-8?Q?Smlouva_o_d=C3=ADlo_=E2=80=93?= =?UTF-8?Q?_p=C5=99ipom=C3=ADnky?=")).toBe("Smlouva o dílo – připomínky");
    expect(decodeHeader("=?ISO-8859-2?B?" + Buffer.from([0xae, 0x6c, 0x75, 0xbb]).toString("base64") + "?= <a@b.cz>")).toBe("Žluť <a@b.cz>");
    expect(decodeHeader("Plain subject")).toBe("Plain subject");
    expect(decodeHeader("=?x-neznama?Q?ahoj?=")).toBe("ahoj");
  });

  it("an unknown charset reads as UTF-8, invalid UTF-8 as windows-1250", () => {
    expect(decodeCharset(enc.encode("žluť"), "x-neznama")).toBe("žluť");
    expect(decodeCharset(new Uint8Array([0x9e, 0x6c, 0x75, 0x9d]), null)).toBe("žluť");
  });
});

describe("parseEmail", () => {
  it("walks the MIME tree: the plain body, the attachment by name — no routing headers, no inline picture", () => {
    const mail = parseEmail(enc.encode(MIXED));
    expect(mail).toMatchObject({
      subject: "Smlouva o dílo – připomínky",
      from: "Jana Nováková <jana@firma.cz>",
      to: "Petr Dvořák <petr@ak.cz>, kancelar@ak.cz",
      cc: "asistentka@ak.cz",
      date: "Thu, 12 Mar 2026 14:05:09 +0100",
      attachments: ["Smlouva o dílo.pdf"],
    });
    expect(mail.text).toContain("posílám připomínky k čl. 5 smlouvy; lhůta je do pátku.");
    expect(mail.html).toContain("HTML verze");
  });

  it("a malformed or truncated message never throws", () => {
    expect(parseEmail(enc.encode("není to zpráva"))).toMatchObject({ subject: "", from: "", text: "", attachments: [] });
    expect(parseEmail(enc.encode(MIXED.slice(0, 900))).subject).toBe("Smlouva o dílo – připomínky");
    const nested = 'Subject: x\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n' + '--B\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n'.repeat(40);
    expect(parseEmail(enc.encode(nested)).subject).toBe("x");
  });
});

describe("convertEmail", () => {
  it("the subject is the heading; sender, recipients, date and attachment names follow; then the plain body", () => {
    const r = convertEmail(buffer(enc.encode(MIXED)));
    expect(r).toMatchObject({ kind: "eml", converter: "eml@1", labelSource: "none", physicalPages: null });
    const lines = r.dmd.split("\n").filter(Boolean);
    expect(lines.slice(0, 6)).toEqual([
      "# Smlouva o dílo – připomínky",
      "Od: Jana Nováková <jana@firma.cz>",
      "Komu: Petr Dvořák <petr@ak.cz>, kancelar@ak.cz",
      "Kopie: asistentka@ak.cz",
      "Datum: 12. 3. 2026 14:05",
      "Přílohy (nepřevedené): Smlouva o dílo.pdf",
    ]);
    expect(r.dmd).toContain("Dobrý den,");
    expect(r.dmd).toContain("posílám připomínky k čl. 5 smlouvy; lhůta je do pátku.");
    expect(r.dmd).toContain("původní zpráva");
    expect(r.dmd).toContain("S pozdravem");
    // Nothing of the attachment, the routing or the unused HTML part.
    for (const gone of ["tajný obsah", "tajne-id", "Tajný klient", "mx.firma.cz", "HTML verze", "preambule", "logo.png"]) expect(r.dmd).not.toContain(gone);
    expect(r.warnings.join(" ")).toContain("Přílohy se nepřevádějí (1)");
    // The server's parser reads it: one section, named by the subject.
    expect(parseDmd(r.dmd).sections.map((s) => s.heading)).toEqual(["Smlouva o dílo – připomínky"]);
  });

  it("an HTML-only message: its text and structure, without scripts, styles, pictures or layout tables", () => {
    const r = convertEmail(buffer(cp1250Html()));
    expect(r.dmd).toContain("# Výzva");
    expect(r.dmd).toContain("## Upomínka");
    expect(r.dmd).toContain("Dlužíte 12 000 Kč.");
    expect(r.dmd).toContain("- první");
    for (const gone of ["alert", "color:red", "cid:", "|"]) expect(r.dmd).not.toContain(gone);
  });

  it("markup typed into a plain message stays text", () => {
    const mail = "From: a@b.cz\r\nSubject: <b>pozor</b> & spol.\r\n\r\n<script>alert(1)</script>\r\n# není nadpis\r\n";
    const html = emailToHtml(parseEmail(enc.encode(mail)), (h) => h);
    expect(html).toContain("<h1>&lt;b&gt;pozor&lt;/b&gt; &amp; spol.</h1>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;<br># není nadpis");
    const r = convertEmail(buffer(enc.encode(mail)));
    expect(parseDmd(r.dmd).sections).toHaveLength(1);
  });

  it("a message without a body keeps its head; a file that is no message is refused", () => {
    const r = convertEmail(buffer(enc.encode("From: a@b.cz\r\nSubject: Jen hlavička\r\n\r\n")));
    expect(r.dmd).toContain("# Jen hlavička");
    expect(r.warnings.join(" ")).toContain("nemá žádný text");
    expect(() => convertEmail(buffer(enc.encode("jen nějaký text bez hlaviček")))).toThrow(/nevypadá jako e-mailová zpráva/);
  });
});

describe("detection and dispatch", () => {
  it(".eml is an e-mail; an Outlook .msg is refused with what to do instead", () => {
    expect(detectKind(enc.encode(MIXED), "Zpráva.EML")).toBe("eml");
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(() => detectKind(ole, "zprava.msg")).toThrow(/Uložte ji jako \.eml/);
    expect(() => detectKind(enc.encode("x"), "zprava.msg")).toThrow(/Outlooku/);
  });

  it("convertFile reads an .eml and reports the original's name, size and hash", async () => {
    const bytes = enc.encode(MIXED);
    const r = await convertFile(new File([bytes], "Smlouva – připomínky.eml"), DEFAULT_CONVERT_OPTIONS);
    expect(r).toMatchObject({ kind: "eml", fileName: "Smlouva – připomínky.eml", bytes: bytes.length });
    expect(r.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
