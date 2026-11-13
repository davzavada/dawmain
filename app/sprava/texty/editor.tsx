"use client";

import { useState, useTransition } from "react";
import { Inline, Markdown } from "@/src/content/markdown";
import { TEXT_FIELDS, normalizeText, type TextField, type TextKey, type TextOverrides } from "@/src/content/texts";
import { saveTextAction } from "./actions";

/**
 * The interactive part of the text editor: the fields on the left, the
 * chosen one on the right with its text, a live preview and the two
 * actions. The preview renders through the same Markdown component as the
 * site, so what it shows is what the page will show. A draft lives only in
 * this tab until it is saved.
 */

const GROUPS = [...new Set(TEXT_FIELDS.map((field) => field.group))];

const HELP: Record<TextField["kind"], string> = {
  plain: "Jeden řádek prostého textu, bez formátování.",
  block: "Prázdný řádek odděluje odstavce. **tučně**, *kurzíva*, [text odkazu](https://adresa).",
  document:
    "Prázdný řádek odděluje odstavce. „## Nadpis“ začíná oddíl, „- “ položku seznamu. **tučně**, *kurzíva*, [text odkazu](https://adresa nebo /soukromi).",
};

function Preview({ field, text }: { field: TextField; text: string }) {
  if (field.kind === "plain") {
    return (
      <p>
        <Inline text={text} />
      </p>
    );
  }
  if (field.kind === "block") return <Markdown source={text} />;
  return (
    <div className="legal">
      <Markdown source={text} sections />
    </div>
  );
}

export function TextEditor({ overrides: initial, available }: { overrides: TextOverrides; available: boolean }) {
  const [overrides, setOverrides] = useState<TextOverrides>(initial);
  const [selected, setSelected] = useState<TextKey>(TEXT_FIELDS[0].key);
  const [drafts, setDrafts] = useState<Partial<Record<TextKey, string>>>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  const field = TEXT_FIELDS.find((f) => f.key === selected) as TextField & { key: TextKey };
  const stored = overrides[field.key] ?? field.default;
  const text = drafts[field.key] ?? stored;
  const clean = normalizeText(field, text);
  const dirty = clean !== stored;
  const edited = field.key in overrides;
  const tooLong = clean.length > field.maxChars;

  function choose(key: TextKey) {
    setSelected(key);
    setMessage(null);
  }

  function run(value: string | null, done: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await saveTextAction(field.key, value);
      if (!result.ok) {
        setMessage({ text: result.error, error: true });
        return;
      }
      setOverrides(result.overrides);
      setDrafts(({ [field.key]: _saved, ...rest }) => rest);
      setMessage({ text: done, error: false });
    });
  }

  return (
    <div className="adm-grid adm-texts">
      <nav className="adm-panel" aria-label="Pole">
        {GROUPS.map((group) => (
          <div key={group} className="adm-text-group">
            <h2>{group}</h2>
            <ul>
              {TEXT_FIELDS.filter((f) => f.group === group).map((f) => (
                <li key={f.key}>
                  <button type="button" className="adm-text-item" aria-current={f.key === selected ? "true" : undefined} onClick={() => choose(f.key)}>
                    <span>{f.label}</span>
                    {f.key in drafts ? <span className="adm-text-flag">neuloženo</span> : f.key in overrides ? <span className="adm-text-flag">upraveno</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <section className="adm-panel adm-text-edit" aria-label={field.label}>
        <div className="adm-panel-head">
          <h2>{field.label}</h2>
          <span className="adm-count">{edited ? "upraveno" : "výchozí znění"}</span>
        </div>
        <div className="adm-text-body">
          <p className="muted small">{field.hint}</p>
          <textarea
            className="adm-textarea"
            value={text}
            rows={field.kind === "plain" ? 2 : field.kind === "block" ? 8 : 22}
            spellCheck
            lang="cs"
            disabled={!available || pending}
            aria-label={field.label}
            onChange={(e) => {
              setDrafts((all) => ({ ...all, [field.key]: e.target.value }));
              setMessage(null);
            }}
          />
          <p className="muted small">
            {HELP[field.kind]}{" "}
            <span className={tooLong ? "adm-text-over" : undefined}>
              {clean.length} / {field.maxChars} znaků
            </span>
          </p>
          <div className="adm-text-actions">
            <button type="button" className="zd-btn zd-btn-primary" disabled={!available || pending || !dirty || !clean || tooLong} onClick={() => run(text, "Uloženo. Na webu se to projeví při příští návštěvě stránky.")}>
              {pending ? "Ukládám…" : "Uložit"}
            </button>
            <button type="button" className="zd-btn zd-btn-quiet" disabled={pending || !(field.key in drafts)} onClick={() => setDrafts(({ [field.key]: _dropped, ...rest }) => rest)}>
              Zahodit úpravy
            </button>
            <button
              type="button"
              className="zd-btn zd-btn-quiet"
              disabled={!available || pending || !edited}
              onClick={() => {
                if (window.confirm(`Vrátit „${field.label}“ na výchozí znění? Uložený text se smaže.`)) run(null, "Vráceno na výchozí znění.");
              }}
            >
              Vrátit výchozí
            </button>
            {message ? (
              <span className={message.error ? "zd-error" : "muted small"} role="status">
                {message.text}
              </span>
            ) : null}
          </div>
          <h3 className="adm-text-preview-head">Náhled</h3>
          <div className="adm-text-preview">
            <Preview field={field} text={clean} />
          </div>
        </div>
      </section>
    </div>
  );
}
