"use client";

// Topbar theme switcher (SVG icons only) + shared logic reused by the
// Settings appearance card.
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, Coffee, Monitor, Moon, Palette, Sparkles, Sun } from "lucide-react";
import { THEME_OPTIONS, useMounted } from "./theme-provider";

/** Theme-aware icon for a theme value (always an SVG component). */
export function ThemeIcon({ theme, className }: { theme: string; className?: string }) {
  const cls = className ?? "h-4 w-4";
  switch (theme) {
    case "light":
      return <Sun className={cls} />;
    case "dark":
      return <Moon className={cls} />;
    case "midnight":
      return <Sparkles className={cls} />;
    case "sepia":
      return <Coffee className={cls} />;
    default:
      return <Monitor className={cls} />;
  }
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full" aria-label="Change theme">
          {/* Render a neutral icon until mounted to avoid hydration mismatch */}
          {!mounted && <Palette className="h-[18px] w-[18px]" />}
          {mounted && <ThemeIcon theme={theme ?? "system"} className="h-[18px] w-[18px]" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THEME_OPTIONS.map((opt) => (
          <DropdownMenuItem key={opt.value} onClick={() => setTheme(opt.value)} className="gap-2.5">
            <ThemeIcon theme={opt.value} className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              {opt.label}
              <span className="block text-[11px] text-muted-foreground">{opt.hint}</span>
            </span>
            {mounted && theme === opt.value && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
