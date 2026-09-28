/**
 * The repo has no @types/react-dom (the app never imports react-dom itself),
 * but tests render pages to static markup. Only what they use is declared.
 */
declare module "react-dom/server" {
  import type { ReactNode } from "react";

  export function renderToStaticMarkup(node: ReactNode): string;
  export function renderToString(node: ReactNode): string;
}
