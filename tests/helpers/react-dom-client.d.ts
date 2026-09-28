/**
 * The part of react-dom/client the DOM tests use (the repo has no
 * @types/react-dom; Next bundles its own). Types only.
 */
declare module "react-dom/client" {
  import type { ReactNode } from "react";

  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }

  export function createRoot(container: Element | DocumentFragment): Root;
}
