"use client";

import { createElement, Fragment, type ReactNode } from "react";

/**
 * The fallback view of a Word file in the document viewer (./doc-viewer.tsx)
 * when docx-preview cannot lay it out: mammoth's flowing HTML turned into
 * React elements from a whitelist of tags.
 */

/** Tags of mammoth's HTML that the preview draws; anything else keeps only its text. */
const TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "sup", "sub", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "blockquote", "br", "a", "img"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "svg", "math", "template"]);

/**
 * Mammoth's HTML turned into React elements from a whitelist: formatting
 * tags only, links only to http(s)/mailto, images only as data: URLs of
 * raster types, no other attribute. No HTML string ever reaches the DOM
 * (no raw HTML injection anywhere in the Vlastní soubory UI).
 */
export function docHtmlToReact(html: string): ReactNode[] {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstElementChild;
  let key = 0;
  const walk = (node: Node): ReactNode => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return null;
    const children = [...el.childNodes].map(walk);
    if (!TAGS.has(tag)) return createElement(Fragment, { key: key++ }, ...children);
    const props: Record<string, unknown> = { key: key++ };
    if (tag === "a") {
      const href = el.getAttribute("href")?.trim() ?? "";
      if (/^(https?:|mailto:)/i.test(href)) Object.assign(props, { href, target: "_blank", rel: "noopener noreferrer nofollow" });
    } else if (tag === "img") {
      const src = el.getAttribute("src")?.trim() ?? "";
      if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) return null;
      Object.assign(props, { src, alt: "" });
      return createElement("img", props);
    } else if (tag === "td" || tag === "th") {
      const colSpan = Number(el.getAttribute("colspan"));
      const rowSpan = Number(el.getAttribute("rowspan"));
      if (colSpan > 1 && colSpan < 100) props.colSpan = colSpan;
      if (rowSpan > 1 && rowSpan < 1000) props.rowSpan = rowSpan;
    }
    if (tag === "br") return createElement("br", props);
    return createElement(tag, props, ...children);
  };
  return root ? [...root.childNodes].map(walk) : [];
}

