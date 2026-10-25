"use client";

// Theme system: Light / Dark / System + two extra Pufflet themes (Midnight,
// Sepia). Preference persists in localStorage via next-themes; "system"
// follows the OS and updates live. Every theme is a complete CSS variable
// set in globals.css, so any of them can be selected independently.
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useSyncExternalStore, type ReactNode } from "react";

export const THEME_OPTIONS = [
  { value: "light", label: "Light", hint: "Crisp daylight" },
  { value: "dark", label: "Dark", hint: "Deep navy" },
  { value: "system", label: "System", hint: "Match your OS" },
  { value: "midnight", label: "Midnight", hint: "OLED black + violet" },
  { value: "sepia", label: "Sepia", hint: "Warm paper" },
] as const;

export type ThemeValue = (typeof THEME_OPTIONS)[number]["value"];

const emptySubscribe = () => () => {};

/** Hydration-safe mounted flag: false during SSR/first paint, true after.
 *  Avoids the setState-in-effect cascade lint rule entirely. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      themes={THEME_OPTIONS.map((t) => t.value)}
    >
      {children}
    </NextThemesProvider>
  );
}
