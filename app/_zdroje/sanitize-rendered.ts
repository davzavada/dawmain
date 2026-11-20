/** A URL that can run or load anything but an inline image or a plain web/mail link. */
const UNSAFE_URL = /^\s*(?!data:image\/(?:png|jpe?g|gif|bmp|webp|tiff?|x-emf|x-wmf);|https?:|mailto:|#)[a-z][a-z0-9+.-]*:/i;

/**
 * What docx-preview rendered from an uploaded (untrusted) Word file, made
 * inert before anyone looks at it: no element that runs or embeds anything,
 * no event-handler attribute, no URL but an inline image, a web link or an
 * anchor, and in its stylesheets no @import and no url() that leaves the
 * document. The site's CSP (next.config.ts: script-src-attr 'none',
 * object-src 'none') is the second lock on the same door. 
 */
export function sanitizeRendered(body: Element, styles?: Element | null): void {
  body
    .querySelectorAll("script, iframe, frame, object, embed, link, meta, base, form, foreignObject, animate, set, use, audio, video, source, portal")
    .forEach((n) => n.remove());
  for (const node of [body, ...Array.from(body.querySelectorAll("*"))]) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction") node.removeAttribute(attr.name);
      else if ((name === "href" || name === "src" || name === "xlink:href" || name === "action" || name === "poster") && UNSAFE_URL.test(attr.value)) node.removeAttribute(attr.name);
      else if (name === "style" && /url\s*\(\s*['"]?\s*(?!data:image\/)|expression\s*\(|@import/i.test(attr.value)) node.removeAttribute(attr.name);
    }
  }
  for (const holder of [body, styles]) {
    holder?.querySelectorAll("style").forEach((style) => {
      const text = style.textContent ?? "";
      const safe = text.replace(/@import[^;]*;?/gi, "").replace(/url\s*\(\s*['"]?\s*(?!data:(?:image|font|application\/(?:x-font|font))[^)]*)[^)]*\)/gi, "none");
      if (safe !== text) style.textContent = safe;
    });
  }
}
