"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthScreen } from "@/components/pufflet/auth-screen";
import { DriveApp } from "@/components/pufflet/drive-app";
import { PuffletIcon, PuffletWordmark } from "@/components/pufflet/logo";

interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  mustChangePassword?: boolean;
}

export default function Page() {
  const [state, setState] = useState<"loading" | "anon" | "authed">("loading");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [defaultUserActive, setDefaultUserActive] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);

  const loadState = async () => {
    try {
      const res = await fetch("/api/auth/state", { cache: "no-store" });
      const body = await res.json();
      setNeedsSetup(Boolean(body.needsSetup));
      setDefaultUserActive(Boolean(body.defaultUserActive));
      setUser(body.user ?? null);
      setState(body.user ? "authed" : "anon");
    } catch {
      setState("anon");
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/state", { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        setNeedsSetup(Boolean(body.needsSetup));
        setDefaultUserActive(Boolean(body.defaultUserActive));
        setUser(body.user ?? null);
        setState(body.user ? "authed" : "anon");
      })
      .catch(() => {
        if (!cancelled) setState("anon");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="min-h-screen grid place-items-center bg-gradient-to-b from-[#f4f7ff] to-white">
        <div className="flex flex-col items-center gap-4">
          <PuffletIcon className="w-28 animate-pulse" />
          <PuffletWordmark className="text-2xl" />
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (state === "anon" || !user) {
    return (
      <AuthScreen
        needsSetup={needsSetup}
        defaultUserActive={defaultUserActive}
        onDone={() => void loadState()}
      />
    );
  }

  return <DriveApp user={user} onSignOut={() => void loadState()} />;
}
