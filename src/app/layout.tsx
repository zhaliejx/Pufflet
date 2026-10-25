import type { Metadata } from "next";
import { Baloo_2, Nunito } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/pufflet/theme-provider";

const baloo = Baloo_2({
  variable: "--font-brand",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
});

const nunito = Nunito({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pufflet — Your personal cloud",
  description:
    "Pufflet is a personal cloud storage app with a friendly face: upload, organize, and download your files from anywhere. Telegram-backed storage, PostgreSQL-style metadata, secure API tokens.",
  icons: {
    icon: "/icon.svg",
  },
  openGraph: {
    title: "Pufflet — Your personal cloud",
    description: "Upload, organize, and download your files from anywhere.",
    siteName: "Pufflet",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${baloo.variable} ${nunito.variable} antialiased bg-background text-foreground`}>
        <ThemeProvider>
          {children}
          <Toaster richColors position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
