"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { formatBytes, formatDate } from "@/lib/format";
import { apiCall } from "./store";
import { toast } from "sonner";
import { CloudCheck, CloudOff, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface StatsResponse {
  files: number;
  bytes: number;
  folders: number;
  starred: number;
  trash: number;
  failedUploads: number;
  limits: { maxUploadMb: number; maxDownloadMb: number };
  telegram: {
    configured: boolean;
    ok: boolean;
    username?: string;
    chatIdMasked?: string;
    error?: string;
  };
}

const SCOPES = ["read", "write", "delete", "admin"];

export function SettingsPanel() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>(["read"]);
  const [expiry, setExpiry] = useState("never");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [k, s] = await Promise.all([
        apiCall<{ keys: KeyRow[] }>("/api/keys"),
        apiCall<StatsResponse>("/api/stats"),
      ]);
      setKeys(k.keys);
      setStats(s);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load settings");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createKey() {
    setBusy(true);
    try {
      const res = await apiCall<{ token: string }>("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name: newName, scopes: newScopes, expiresIn: expiry }),
      });
      setCreatedToken(res.token);
      setCreateOpen(false);
      setNewName("");
      setNewScopes(["read"]);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create key");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await apiCall(`/api/keys/${id}`, { method: "DELETE" });
      toast.success("Key revoked");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed");
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Storage overview */}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="font-brand text-[#283070]">Storage overview</CardTitle>
          <CardDescription>Live totals from your Pufflet metadata database.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Files", value: stats ? String(stats.files) : "…" },
            { label: "Stored", value: stats ? formatBytes(stats.bytes) : "…" },
            { label: "Folders", value: stats ? String(stats.folders) : "…" },
            { label: "In trash", value: stats ? String(stats.trash) : "…" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-muted/60 p-4 text-center">
              <p className="text-2xl font-brand font-bold text-[#283070]">{s.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </div>
          ))}
          {stats && (
            <p className="col-span-2 sm:col-span-4 text-xs text-muted-foreground">
              Upload limit {stats.limits.maxUploadMb} MB · download limit {stats.limits.maxDownloadMb} MB per file
              (hosted Telegram Bot API). Self-host the Local Bot API server to raise both to 2000 MB.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Telegram status */}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="font-brand text-[#283070] flex items-center gap-2">
            {stats?.telegram.ok ? (
              <CloudCheck className="h-5 w-5 text-emerald-500" />
            ) : (
              <CloudOff className="h-5 w-5 text-amber-500" />
            )}
            Telegram storage
          </CardTitle>
          <CardDescription>
            {stats?.telegram.configured
              ? stats.telegram.ok
                ? `Connected as @${stats.telegram.username}. Storage channel ${stats.telegram.chatIdMasked}.`
                : `Connection problem: ${stats.telegram.error ?? "unknown"}`
              : "Not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in your environment (.env) and restart."}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* API keys */}
      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="font-brand text-[#283070] flex items-center gap-2">
              <KeyRound className="h-5 w-5" /> API keys
            </CardTitle>
            <CardDescription>
              Tokens for the versioned REST API (<code className="text-xs">/api/v1</code>). Shown once, stored hashed.
            </CardDescription>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            className="pufflet-gradient text-white border-0 rounded-xl"
            size="sm"
          >
            <Plus className="h-4 w-4" /> New key
          </Button>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No API keys yet. Create one to use the REST API from scripts and apps.
            </p>
          ) : (
            <div className="space-y-2">
              {keys.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate flex items-center gap-2">
                      {k.name}
                      {k.revokedAt && <Badge variant="destructive">revoked</Badge>}
                      {!k.revokedAt && k.expiresAt && new Date(k.expiresAt) < new Date() && (
                        <Badge variant="secondary">expired</Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{k.prefix}•••</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {k.scopes} · created {formatDate(k.createdAt)}
                      {k.lastUsedAt ? ` · last used ${formatDate(k.lastUsedAt)}` : " · never used"}
                      {k.expiresAt ? ` · expires ${formatDate(k.expiresAt)}` : ""}
                    </p>
                  </div>
                  {!k.revokedAt && (
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => revoke(k.id)} aria-label={`Revoke ${k.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create key dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>Scopes limit what the token can do. You can revoke anytime.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                placeholder="my-backup-script"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="grid grid-cols-2 gap-2">
                {SCOPES.map((s) => (
                  <label
                    key={s}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={newScopes.includes(s)}
                      onCheckedChange={(v) =>
                        setNewScopes((prev) => (v ? [...prev, s] : prev.filter((x) => x !== s)))
                      }
                    />
                    <span className="font-mono text-xs">{s}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Expires</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Never</SelectItem>
                  <SelectItem value="7d">7 days</SelectItem>
                  <SelectItem value="30d">30 days</SelectItem>
                  <SelectItem value="90d">90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={createKey}
              disabled={busy || !newName.trim() || newScopes.length === 0}
              className="pufflet-gradient text-white border-0"
            >
              Create key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time token reveal */}
      <Dialog open={!!createdToken} onOpenChange={(v) => !v && setCreatedToken(null)}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Copy your token now</DialogTitle>
            <DialogDescription>
              This is the only time the full token is shown. Only a SHA-256 hash is stored server-side.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-muted px-3 py-2.5 text-xs font-mono break-all select-all">
              {createdToken}
            </code>
            <Button
              size="icon"
              variant="secondary"
              onClick={() => {
                navigator.clipboard.writeText(createdToken ?? "").then(
                  () => toast.success("Token copied"),
                  () => toast.error("Copy failed"),
                );
              }}
              aria-label="Copy token"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreatedToken(null)} className="pufflet-gradient text-white border-0">
              I saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
