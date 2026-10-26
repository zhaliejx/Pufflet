"use client";

// Settings → "Pufflet as a remote" card: exposes this Pufflet instance as a
// WebDAV endpoint (/dav) so EXTERNAL rclone clients can mount Pufflet itself
// as a storage remote. Complements the rclone client card (which connects OUT
// to other remotes) — together they make Pufflet both a client and a target.

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Check, Copy, Server } from "lucide-react";
import { toast } from "sonner";

export function DavCard() {
  // The settings panel mounts client-side only (behind an authed UI tab), so
  // reading window directly in the lazy initializer is safe — no SSR pass.
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [copied, setCopied] = useState<"url" | "snippet" | null>(null);

  const davUrl = `${origin}/api/dav`;

  const snippet = useMemo(
    () =>
      [
        "# 1. Create an API key in Settings → API keys (scopes: read, write, delete)",
        `# 2. Point rclone at this server (paste YOUR key into <API-KEY>):`,
        `rclone config create pufflet webdav \\`,
        `  url ${davUrl} \\`,
        `  vendor other \\`,
        `  user pufflet \\`,
        `  pass "$(rclone obscure <API-KEY>)"`,
        `# 3. rclone lsd pufflet:   → browse your Pufflet storage`,
      ].join("\n"),
    [davUrl],
  );

  const copy = async (what: "url" | "snippet", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      toast.success(what === "url" ? "WebDAV URL copied" : "rclone setup snippet copied");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Copy failed — select the text manually");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4" aria-hidden />
          Pufflet as a remote (WebDAV)
        </CardTitle>
        <CardDescription>
          Other rclone installations — or any WebDAV client — can mount THIS Pufflet as a storage
          remote at <code className="rounded bg-muted px-1">/api/dav/</code>. Authentication uses an API
          key as the WebDAV password; its scopes decide what the client may do (listings and
          downloads need <b>read</b>, uploads need <b>write</b>, deletions and rclone sync cleanup
          need <b>delete</b>).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Input readOnly value={davUrl} aria-label="WebDAV URL" className="font-mono text-xs" />
          <Button variant="outline" size="sm" onClick={() => copy("url", davUrl)}>
            {copied === "url" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            Copy
          </Button>
        </div>
        <div className="relative">
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{snippet}</pre>
          <Button
            variant="outline"
            size="sm"
            className="absolute top-2 right-2"
            onClick={() => copy("snippet", snippet)}
          >
            {copied === "snippet" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            Copy
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Works both ways: mount another server&apos;s cloud storage into Pufflet with the rclone
          Storage card above, and let rclone on your laptop treat this Pufflet as just another
          remote. Self-hosters can turn this mount off entirely with
          <code className="mx-1 rounded bg-muted px-1">PUFFLET_DAV=false</code>.
        </p>
      </CardContent>
    </Card>
  );
}
