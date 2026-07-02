import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "shp0",
  description: "Multi-tenant SaaS ecommerce platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
