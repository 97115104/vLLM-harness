import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inference Studio",
  description: "Run open-source AI models locally with a polished web interface",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <div style={{ flex: 1 }}>{children}</div>
      </body>
    </html>
  );
}
