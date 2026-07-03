import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shape Meet Admin",
  description: "Panel de usuarios, hosts y reuniones de Shape Meet"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
