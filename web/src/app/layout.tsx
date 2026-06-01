import type { Metadata } from "next";
import "./globals.css";
import Toaster from "@/components/toaster";

export const metadata: Metadata = {
  title: "Inference Studio",
  description: "Run open-source AI models locally with a polished web interface",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <div style={{ flex: 1 }}>{children}</div>
        <Toaster />
      </body>
    </html>
  );
}
