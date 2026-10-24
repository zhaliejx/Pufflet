"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Cloud } from "lucide-react";

interface Props {
  needsSetup: boolean;
  onDone: () => void;
}

export function AuthScreen({ needsSetup, onDone }: Props) {
  const [mode, setMode] = useState<"login" | "setup">(needsSetup ? "setup" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(mode === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "setup" ? { email, password, name } : { email, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Something went wrong");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-4 bg-gradient-to-b from-[#f4f7ff] to-white">
      <div className="flex flex-col items-center gap-3 select-none">
        <img src="/logo-icon.svg" alt="Pufflet cloud mascot" className="w-40 h-auto drop-shadow-sm" />
        <h1 className="font-brand text-5xl font-bold text-[#283070] tracking-tight">Pufflet</h1>
        <p className="text-muted-foreground -mt-2">Your personal cloud, with a friendly face.</p>
      </div>

      <Card className="w-full max-w-sm rounded-2xl border-border/70 shadow-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl font-brand text-[#283070]">
            {mode === "setup" ? "Create your owner account" : "Welcome back"}
          </CardTitle>
          <CardDescription>
            {mode === "setup"
              ? "First run: this account will own this Pufflet."
              : "Sign in to your Pufflet drive."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {mode === "setup" && (
              <div className="space-y-2">
                <Label htmlFor="name">Display name</Label>
                <Input
                  id="name"
                  placeholder="Alex"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                placeholder={mode === "setup" ? "At least 8 characters" : "••••••••"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "setup" ? "new-password" : "current-password"}
              />
            </div>
            <Button type="submit" disabled={busy} className="w-full rounded-xl pufflet-gradient text-white border-0 h-11">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === "setup" ? "Create account" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Cloud className="h-3.5 w-3.5" />
        Files are stored privately in your own Telegram channel — the bot token never leaves the server.
      </p>
    </div>
  );
}
