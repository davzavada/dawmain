#!/usr/bin/env python3
"""
Generate the small .docx fixtures for tests/files-convert-docx.test.ts.

The files are written by hand from WordprocessingML (zipfile only, no
python-docx), so every feature the converter must handle is present on
purpose and nothing else sneaks in:

  vzor-smlouva.docx   a commented template (vzor): Title style, articles
                      auto-numbered through numbering.xml ("Čl. %1", upper
                      Roman, linked to the "heading 1" style — Czech Word's
                      "Nadpis 1"), numbered odstavce, a bullet list, template
                      placeholders ([●], ____, ……, FORMTEXT en spaces),
                      checkbox content controls, a manual bold "Článek V"
                      + title line, a signature table, a footnote with a
                      drafting note, a Word comment (must be dropped) and
                      text that imitates DMD markup (must be escaped).
  clanek-poznamky.docx  an article with footnotes and endnotes: footnote ids
                      that are not 1..n (relabelling), a two-paragraph
                      footnote, a footnote in a heading and in a table cell,
                      two endnotes (i, ii), custom styles literally named
                      "Nadpis 1" / "Nadpis 2" (not linked to the built-in
                      headings) and a built-in "heading 2".

Run from the repo root:  python3 scripts/make-docx-fixtures.py
The output is deterministic (fixed zip timestamps), so re-running it
produces byte-identical files.
"""

from __future__ import annotations

import os
import zipfile
from xml.sax.saxutils import escape

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "files", "docx")

W_NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
)
XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
FIXED_DATE = (2026, 9, 27, 12, 0, 0)

# ─────────────────────────────────────────────────────────── run / paragraph helpers


def t(text: str) -> str:
    """A w:t that keeps leading/trailing spaces."""
    return f'<w:t xml:space="preserve">{escape(text)}</w:t>'


def run(text: str, *, bold: bool = False, italic: bool = False, sup: bool = False) -> str:
    props = ""
    if bold or italic or sup:
        props = "<w:rPr>"
        if bold:
            props += "<w:b/>"
        if italic:
            props += "<w:i/>"
        if sup:
            props += '<w:vertAlign w:val="superscript"/>'
        props += "</w:rPr>"
    return f"<w:r>{props}{t(text)}</w:r>"


def footnote_ref(note_id: int) -> str:
    return (
        '<w:r><w:rPr><w:rStyle w:val="Znakapoznpodarou"/></w:rPr>'
        f'<w:footnoteReference w:id="{note_id}"/></w:r>'
    )


def endnote_ref(note_id: int) -> str:
    return (
        '<w:r><w:rPr><w:rStyle w:val="Odkaznavysvtlivky"/></w:rPr>'
        f'<w:endnoteReference w:id="{note_id}"/></w:r>'
    )


def para(*runs: str, style: str | None = None, num: tuple[int, int] | None = None, center: bool = False) -> str:
    props = ""
    if style or num or center:
        props = "<w:pPr>"
        if style:
            props += f'<w:pStyle w:val="{style}"/>'
        if num:
            props += f'<w:numPr><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>'
        if center:
            props += '<w:jc w:val="center"/>'
        props += "</w:pPr>"
    return f"<w:p>{props}{''.join(runs)}</w:p>"


def checkbox(checked: bool) -> str:
    """A Word 2010 checkbox content control (w14:checkbox) showing ☒ / ☐."""
    glyph = "☒" if checked else "☐"
    return (
        "<w:sdt><w:sdtPr>"
        f'<w14:checkbox><w14:checked w14:val="{1 if checked else 0}"/></w14:checkbox>'
        "</w:sdtPr><w:sdtContent>"
        f"<w:r>{t(glyph)}</w:r>"
        "</w:sdtContent></w:sdt>"
    )


def formtext(default: str) -> str:
    """A legacy FORMTEXT field whose shown result is `default` (Word uses 5 × U+2002)."""
    return (
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        f"<w:r>{t(default)}</w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    )


def comment_range(comment_id: int, *runs: str) -> str:
    return (
        f'<w:commentRangeStart w:id="{comment_id}"/>'
        + "".join(runs)
        + f'<w:commentRangeEnd w:id="{comment_id}"/>'
        + f'<w:r><w:commentReference w:id="{comment_id}"/></w:r>'
    )


def cell(*paragraphs: str, span: int = 1) -> str:
    grid = f'<w:tcPr><w:gridSpan w:val="{span}"/></w:tcPr>' if span > 1 else ""
    return f"<w:tc>{grid}{''.join(paragraphs)}</w:tc>"


def table(*rows: list[str]) -> str:
    body = "".join(f"<w:tr>{''.join(cells)}</w:tr>" for cells in rows)
    return f"<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>{body}</w:tbl>"


def document(*blocks: str) -> str:
    return f"{XML_DECL}<w:document {W_NS}><w:body>{''.join(blocks)}<w:sectPr/></w:body></w:document>"


def notes(kind: str, bodies: dict[int, list[str]]) -> str:
    """footnotes.xml / endnotes.xml with Word's separator notes (-1, 0) first."""
    tag = f"w:{kind}"
    ref = "w:footnoteRef" if kind == "footnote" else "w:endnoteRef"
    style = "Textpoznpodarou" if kind == "footnote" else "Textvysvtlivek"
    out = [
        f'<{tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></{tag}>',
        f'<{tag} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></{tag}>',
    ]
    for note_id, paragraphs in bodies.items():
        ps = []
        for i, text in enumerate(paragraphs):
            mark = f'<w:r><w:rPr><w:rStyle w:val="Znakapoznpodarou"/></w:rPr><{ref}/></w:r>' if i == 0 else ""
            lead = " " if i == 0 else ""
            ps.append(f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr>{mark}{run(lead + text)}</w:p>')
        out.append(f'<{tag} w:id="{note_id}">{"".join(ps)}</{tag}>')
    root = f"w:{kind}s"
    return f"{XML_DECL}<{root} {W_NS}>{''.join(out)}</{root}>"


# ─────────────────────────────────────────────────────────── shared parts


def styles(extra: str = "") -> str:
    """Normal, Title, the built-in headings as Czech Word writes them (styleId
    "Nadpis1", name "heading 1"), note styles, plus `extra`."""
    base = [
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normln"><w:name w:val="Normal"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="Nzev"><w:name w:val="Title"/><w:basedOn w:val="Normln"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="Nadpis1"><w:name w:val="heading 1"/><w:basedOn w:val="Normln"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="Nadpis2"><w:name w:val="heading 2"/><w:basedOn w:val="Normln"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="Textpoznpodarou"><w:name w:val="footnote text"/></w:style>',
        '<w:style w:type="character" w:styleId="Znakapoznpodarou"><w:name w:val="footnote reference"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="Textvysvtlivek"><w:name w:val="endnote text"/></w:style>',
        '<w:style w:type="character" w:styleId="Odkaznavysvtlivky"><w:name w:val="endnote reference"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="Odstavecseseznamem"><w:name w:val="List Paragraph"/></w:style>',
    ]
    return f"{XML_DECL}<w:styles {W_NS}>{''.join(base)}{extra}</w:styles>"


def content_types(parts: list[str]) -> str:
    overrides = {
        "document": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "styles": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
        "numbering": "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
        "footnotes": "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
        "endnotes": "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
        "comments": "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    }
    items = "".join(f'<Override PartName="/word/{p}.xml" ContentType="{overrides[p]}"/>' for p in parts)
    return (
        f"{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f"{items}</Types>"
    )


ROOT_RELS = (
    f"{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    "</Relationships>"
)


def document_rels(parts: list[str]) -> str:
    kinds = {
        "styles": "styles",
        "numbering": "numbering",
        "footnotes": "footnotes",
        "endnotes": "endnotes",
        "comments": "comments",
    }
    rels = "".join(
        f'<Relationship Id="rId{i + 1}" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kinds[p]}" Target="{p}.xml"/>'
        for i, p in enumerate(parts)
    )
    return f"{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{rels}</Relationships>"


def write_docx(name: str, parts: dict[str, str]) -> None:
    """parts: {"document": xml, "styles": xml, ...} (word/<key>.xml)."""
    word_parts = [p for p in parts if p != "document"]
    path = os.path.join(OUT_DIR, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:

        def add(arcname: str, data: str) -> None:
            info = zipfile.ZipInfo(arcname, FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data.encode("utf-8"))

        add("[Content_Types].xml", content_types(list(parts)))
        add("_rels/.rels", ROOT_RELS)
        add("word/_rels/document.xml.rels", document_rels(word_parts))
        for key, xml in parts.items():
            add(f"word/{key}.xml", xml)
    print(f"wrote {os.path.relpath(path)}")


# ─────────────────────────────────────────────────────────── vzor-smlouva.docx

VZOR_NUMBERING = (
    f"{XML_DECL}<w:numbering {W_NS}>"
    # Articles: "Čl. I", "Čl. II" … linked to the heading 1 style; odstavce "1.", "2." at level 1.
    '<w:abstractNum w:abstractNumId="0">'
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:pStyle w:val="Nadpis1"/>'
    '<w:lvlText w:val="Čl. %1"/><w:lvlJc w:val="center"/></w:lvl>'
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/>'
    '<w:lvlText w:val="%2."/><w:lvlJc w:val="left"/></w:lvl>'
    "</w:abstractNum>"
    # Bullets.
    '<w:abstractNum w:abstractNumId="1">'
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl>'
    "</w:abstractNum>"
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
    "</w:numbering>"
)

VZOR_COMMENTS = (
    f"{XML_DECL}<w:comments {W_NS}>"
    '<w:comment w:id="0" w:author="Mgr. Petra Dvořáková" w:date="2026-09-01T10:00:00Z" w:initials="PD">'
    "<w:p>" + run("INTERNÍ KOMENTÁŘ: cenu vždy konzultovat s klientem.") + "</w:p>"
    "</w:comment></w:comments>"
)

VZOR_FOOTNOTES = notes(
    "footnote",
    {
        1: ["Poznámka k vzoru: u spotřebitele doplňte poučení podle § 1820 občanského zákoníku."],
    },
)


def vzor_document() -> str:
    heading = lambda text: para(run(text), style="Nadpis1")  # noqa: E731 — auto-numbered "Čl. N"
    odst = lambda *runs: para(*runs, num=(1, 1))  # noqa: E731 — auto-numbered "1.", "2."
    return document(
        para(run("SMLOUVA O DÍLO"), style="Nzev"),
        para(
            run("uzavřená podle § 2586 a násl. zákona č. 89/2012 Sb., občanský zákoník"),
            footnote_ref(1),
        ),
        heading("Smluvní strany"),
        odst(run("Objednatel: [●], IČO: [●], se sídlem __________")),
        odst(run("Zhotovitel: "), formtext(" " * 5), run(", IČO: [●]")),
        heading("Předmět smlouvy"),
        odst(comment_range(0, run("Zhotovitel se zavazuje provést dílo: ……………………"))),
        odst(run("Místo plnění: ..........")),
        heading("Cena díla"),
        para(checkbox(True), run(" cena včetně DPH")),
        para(checkbox(False), run(" cena bez DPH")),
        para(run("Přílohy:")),
        para(run("Příloha č. 1 – Rozpočet"), style="Odstavecseseznamem", num=(2, 0)),
        para(run("Příloha č. 2 – Harmonogram"), style="Odstavecseseznamem", num=(2, 0)),
        para(run("Článek V", bold=True), center=True),
        para(run("Závěrečná ustanovení", bold=True), center=True),
        para(run("Pozor: text [s. 5] a [^3] a [m. č. 2] není značka.")),
        para(run("# 1 není nadpis")),
        para(run("> není citace")),
        para(run("| není tabulka |")),
        table(
            [cell(para(run("V [●] dne [●]"))), cell(para(run("V [●] dne [●]")))],
            [cell(para(run("………………………"), run(" Objednatel"))), cell(para(run("__________ Zhotovitel")))],
        ),
    )


# ─────────────────────────────────────────────────────────── clanek-poznamky.docx

CLANEK_STYLES_EXTRA = (
    # Custom styles literally named "Nadpis 1" / "Nadpis 2" — not the built-in headings.
    '<w:style w:type="paragraph" w:customStyle="1" w:styleId="MujNadpis1"><w:name w:val="Nadpis 1"/></w:style>'
    '<w:style w:type="paragraph" w:customStyle="1" w:styleId="MujNadpis2"><w:name w:val="Nadpis 2"/></w:style>'
    '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Autor"><w:name w:val="Autor článku"/></w:style>'
)

CLANEK_FOOTNOTES = notes(
    "footnote",
    {
        2: ["Srov. rozsudek NS ze dne 12. 3. 2019, sp. zn. 25 Cdo 1234/2019."],
        5: [
            "MELZER, F. In: PETROV, J. a kol. Občanský zákoník. Komentář. 2. vyd. Praha: C. H. Beck, 2019.",
            "Shodně též nález ÚS sp. zn. II. ÚS 1234/20.",
        ],
        7: ["Poznámka v nadpisu."],
        9: ["Viz rozhodnutí NSS 4 As 12/2019-45."],
        11: ["Viz text [s. 12] a [^9]: tamtéž."],
    },
)

CLANEK_ENDNOTES = notes(
    "endnote",
    {
        2: ["Vysvětlivka první."],
        3: ["Vysvětlivka druhá."],
    },
)


def clanek_document() -> str:
    return document(
        para(run("Odpovědnost za škodu v judikatuře"), style="Nzev"),
        para(run("JUDr. Jan Novák, Ph.D."), style="Autor"),
        para(run("1. Úvod"), style="MujNadpis1"),
        para(
            run("Nejvyšší soud dovodil odpovědnost"),
            footnote_ref(2),
            run(" i tehdy, je-li škoda způsobena jinak"),
            endnote_ref(2),
            run(", a to s odkazem na doktrínu."),
            footnote_ref(5),
        ),
        para(run("2. Judikatura"), footnote_ref(7), style="MujNadpis2"),
        table(
            [cell(para(run("Soud"))), cell(para(run("Sp. zn."))), cell(para(run("Závěr")))],
            [cell(para(run("NSS"))), cell(para(run("4 As 12/2019"), footnote_ref(9))), cell(para(run("zamítnuto")))],
            [cell(para(run("Shrnutí přes dva sloupce")), span=2), cell(para(run("—")))],
        ),
        para(run("Druhá vysvětlivka"), endnote_ref(3), run(" a text za ní.")),
        para(run("3. Závěr"), style="Nadpis2"),
        para(run("Závěrem lze shrnout"), footnote_ref(11), run(".")),
    )


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    write_docx(
        "vzor-smlouva.docx",
        {
            "document": vzor_document(),
            "styles": styles(),
            "numbering": VZOR_NUMBERING,
            "footnotes": VZOR_FOOTNOTES,
            "comments": VZOR_COMMENTS,
        },
    )
    write_docx(
        "clanek-poznamky.docx",
        {
            "document": clanek_document(),
            "styles": styles(CLANEK_STYLES_EXTRA),
            "footnotes": CLANEK_FOOTNOTES,
            "endnotes": CLANEK_ENDNOTES,
        },
    )


if __name__ == "__main__":
    main()
