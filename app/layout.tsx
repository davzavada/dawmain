import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "dawmain MCP server",
  description: "Remote Model Context Protocol server over Streamable HTTP.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: "3rem 1.5rem",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          lineHeight: 1.6,
          color: "#111827",
          background: "#ffffff",
        }}
      >
        <main style={{ maxWidth: "44rem", margin: "0 auto" }}>{children}</main>
      </body>
    </html>
  );
}
