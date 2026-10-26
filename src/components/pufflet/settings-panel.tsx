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
import { useTheme } from "next-themes";
import { THEME_OPTIONS, useMounted } from "./theme-provider";
import { ThemeIcon } from "./theme-toggle";
import { RcloneCard } from "./rclone-card";
import { DavCard } from "./dav-card";
import { toast } from "sonner";
import {
  BadgeCheck,
  CloudCheck,
  CloudOff,
  Copy,
  DatabaseBackup,
  ExternalLink,
  History,
  KeyRound,
  Link2,
  Palette,
  Plus,
  Server,
  ShieldAlert,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
    mode?: "local" | "hosted";
    username?: string;
    chatIdMasked?: string;
    error?: string;
  };
}

interface BackupStatus {
  enabled: boolean;
  telegramConfigured: boolean;
  intervalMs: number;
  pendingChanges: boolean;
  lastBackupAt: string | null;
  lastBackupSize: number;
  lastError: string | null;
  checkpoints?: number;
  lastCheckpointAt?: string | null;
}

interface BackupHistory {
  pinned: { found: boolean; messageId?: string; fileName?: string; fileSize?: number };
  checkpoints: { messageId: string; fileId: string; at: string; size: number; files: number; users: number }[];
  hotMessageKnown: boolean;
}

interface ShareRow {
  id: string;
  urlPath: string;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  downloads: number;
  lastDownloadAt: string | null;
  file: { id: string; name: string; size: number; mimeType: string; trashedAt: string | null };
}

interface Props {
  user: { id: string; email: string; name: string | null; mustChangePassword?: boolean };
}

const SCOPES = ["read", "write", "delete", "admin"];

export function SettingsPanel({ user }: Props) {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [history, setHistory] = useState<BackupHistory | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ source: "pinned" | "checkpoint"; messageId?: string; label: string } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>(["read"]);
  const [expiry, setExpiry] = useState("never");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // change-password form state
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [k, s, b, h] = await Promise.all([
        apiCall<{ keys: KeyRow[] }>("/api/keys"),
        apiCall<StatsResponse>("/api/stats"),
        apiCall<BackupStatus>("/api/backup"),
        apiCall<BackupHistory>("/api/backup/history").catch(() => null),
      ]);
      setKeys(k.keys);
      setStats(s);
      setBackup(b);
      setHistory(h);
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

  async function backupNow() {
    setBackupBusy(true);
    try {
      await apiCall("/api/backup/flush", { method: "POST" });
      toast.success("Snapshot saved to your Telegram storage chat");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Backup failed");
      await load();
    } finally {
      setBackupBusy(false);
    }
  }

  async function restoreNow() {
    if (!restoreTarget) return;
    setRestoreBusy(true);
    try {
      const res = await apiCall<{ exportedAt: string; counts: { files: number; users: number } }>("/api/backup/restore", {
        method: "POST",
        body: JSON.stringify({ source: restoreTarget.source, messageId: restoreTarget.messageId }),
      });
      toast.success(`Restored ${res.counts.files} file(s) from the ${res.exportedAt.slice(0, 10)} snapshot`);
      setRestoreTarget(null);
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed");
      await load();
    } finally {
      setRestoreBusy(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPw.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPw !== confirmPw) {
      toast.error("New passwords do not match");
      return;
    }
    setPwBusy(true);
    try {
      await apiCall("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      toast.success("Password updated — other sessions were signed out");
      // Reload so the app re-reads auth state (clears the temporary-password banner).
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change password");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Appearance / theme picker */}
      <AppearanceCard />

      {/* rclone storage integration */}
      <RcloneCard />

      {/* Pufflet itself as an rclone/WebDAV remote */}
      <DavCard />

      {/* Account / password */}
      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
              <BadgeCheck className="h-5 w-5" /> Account
            </CardTitle>
            <CardDescription>
              {user.email}
              {user.name ? ` · ${user.name}` : ""} · owner account
            </CardDescription>
          </div>
          {user.mustChangePassword && (
            <Badge className="bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-100 shrink-0">
              <ShieldAlert className="h-3 w-3 mr-1" /> temporary password
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="grid sm:grid-cols-3 gap-3 items-end">
            <div className="space-y-2">
              <Label htmlFor="pw-current">Current password</Label>
              <Input
                id="pw-current"
                type="password"
                required
                autoComplete="current-password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pw-new">New password</Label>
              <Input
                id="pw-new"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pw-confirm">Confirm new password</Label>
              <Input
                id="pw-confirm"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              disabled={pwBusy || !currentPw || !newPw || !confirmPw}
              className="pufflet-gradient text-white border-0 rounded-xl sm:col-span-3 w-fit"
            >
              {pwBusy ? "Updating…" : "Update password"}
            </Button>
            <p className="sm:col-span-3 text-xs text-muted-foreground">
              Updating your password signs out every other device and clears the temporary-password
              flag. The default seeded account (pufflet@pufflet.com / pufflet) should do this right
              after first sign-in.
            </p>
          </form>
        </CardContent>
      </Card>

      {/* Storage overview */}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="font-brand text-brand-heading">Storage overview</CardTitle>
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
              <p className="text-2xl font-brand font-bold text-brand-heading">{s.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </div>
          ))}
          {stats && (
            <p className="col-span-2 sm:col-span-4 text-xs text-muted-foreground">
              Upload limit {stats.limits.maxUploadMb} MB · download limit {stats.limits.maxDownloadMb} MB per file
              {stats.telegram.mode === "local"
                ? " (Local Bot API server)"
                : " (hosted Telegram Bot API). Run the bundled Local Bot API server — `docker compose up -d` — to raise both to 2000 MB."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Telegram status */}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
            {stats?.telegram.ok ? (
              <CloudCheck className="h-5 w-5 text-emerald-500" />
            ) : (
              <CloudOff className="h-5 w-5 text-amber-500" />
            )}
            Telegram storage
            {stats?.telegram.configured && (
              <Badge
                variant="secondary"
                className={
                  stats.telegram.mode === "local"
                    ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                    : ""
                }
              >
                <Server className="h-3 w-3 mr-1" />
                {stats.telegram.mode === "local" ? "Local Bot API · up to 2000 MB" : "Hosted Bot API · 50 MB"}
              </Badge>
            )}
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

      {/* Data safety / state backup */}
      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
              <DatabaseBackup className="h-5 w-5" /> Data safety
              {backup?.enabled && backup.telegramConfigured ? (
                <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-200 hover:bg-emerald-100">
                  auto-backup on
                </Badge>
              ) : (
                <Badge variant="secondary">auto-backup off</Badge>
              )}
              {backup?.pendingChanges && backup.enabled && backup.telegramConfigured && (
                <Badge className="bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-100">
                  unsaved changes
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Pufflet snapshots its file index (users, folders, file records, API keys) into one pinned
              document inside your Telegram storage chat and keeps it up to date
              {backup ? ` every ${Math.round(backup.intervalMs / 1000)}s when there are changes` : ""}.
              A fresh server finds that snapshot and restores automatically — this is what lets free
              ephemeral hosts (Hugging Face Spaces, Render, Koyeb) survive restarts.
            </CardDescription>
          </div>
          <Button
            onClick={backupNow}
            disabled={backupBusy || !backup?.enabled || !backup?.telegramConfigured}
            className="pufflet-gradient text-white border-0 rounded-xl shrink-0"
            size="sm"
          >
            <DatabaseBackup className="h-4 w-4" /> {backupBusy ? "Backing up…" : "Back up now"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-muted/60 p-4">
              <p className="text-xs text-muted-foreground">Last snapshot</p>
              <p className="font-medium text-sm mt-1">
                {backup?.lastBackupAt ? formatDate(backup.lastBackupAt) : "never"}
              </p>
            </div>
            <div className="rounded-xl bg-muted/60 p-4">
              <p className="text-xs text-muted-foreground">Snapshot size</p>
              <p className="font-medium text-sm mt-1">
                {backup?.lastBackupSize ? formatBytes(backup.lastBackupSize) : "—"}
              </p>
            </div>
          </div>

          {/* Previous good backups (cold checkpoints) */}
          {(history?.pinned.found || (history?.checkpoints.length ?? 0) > 0) && (
            <div className="rounded-xl border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" /> Previous backups
                </p>
                <span className="text-xs text-muted-foreground">
                  {history?.pinned.found ? "pinned snapshot" : "no pinned snapshot"}
                  {history?.checkpoints.length ? ` + ${history.checkpoints.length} checkpoint(s)` : ""}
                </span>
              </div>
              <div className="space-y-1.5">
                {history?.pinned.found && (
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium truncate">Current snapshot (pinned)</p>
                      <p className="text-xs text-muted-foreground">
                        {history.pinned.fileSize ? formatBytes(history.pinned.fileSize) : "size unknown"} · restored on boot when the database is empty
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 rounded-lg"
                      disabled={restoreBusy}
                      onClick={() => setRestoreTarget({ source: "pinned", label: "the current pinned snapshot" })}
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Restore
                    </Button>
                  </div>
                )}
                {history?.checkpoints.map((cp) => (
                  <div key={cp.messageId} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">Checkpoint · {formatDate(cp.at)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(cp.size)} · {cp.files} file(s) · {cp.users} user(s)
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 rounded-lg"
                      disabled={restoreBusy}
                      onClick={() => setRestoreTarget({ source: "checkpoint", messageId: cp.messageId, label: `the checkpoint from ${formatDate(cp.at)}` })}
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Restore
                    </Button>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                A checkpoint is taken every 12 hours so a previous good copy survives a bad snapshot update.
                Restoring overwrites the CURRENT index with the chosen backup.
              </p>
            </div>
          )}

          {backup?.lastError && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {backup.lastError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Do not delete or unpin the <code className="font-mono">pufflet-state-backup.json</code> message in
            your storage chat — it is your index backup. The snapshot contains password/API-key hashes, so
            keep the chat private (it already holds all your files).
          </p>
        </CardContent>
      </Card>

      {/* API keys */}
      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
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

      {/* Sharing overview — every active public link in one place */}
      <SharingCard />

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

      {/* Restore confirmation — restore is deliberate and destructive */}
      <AlertDialog open={!!restoreTarget} onOpenChange={(v) => !v && setRestoreTarget(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore from backup?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the CURRENT index (users, folders, files, API keys, share links) with{" "}
              {restoreTarget?.label ?? "the selected backup"}. Anything changed since that snapshot is
              lost. The file bytes in your Telegram channel are never touched — files not present in the
              backup become unindexed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoreBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={restoreBusy}
              onClick={(e) => {
                e.preventDefault();
                void restoreNow();
              }}
            >
              {restoreBusy ? "Restoring…" : "Restore backup"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Sharing overview: every active public link across ALL files, with one-click
 *  copy/revoke. The owner-only counterpart of the per-file Share dialog — this
 *  is where "which of my files are shared?" gets answered. */
function SharingCard() {
  const [links, setLinks] = useState<ShareRow[] | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadLinks = useCallback(() => {
    apiCall<{ links: ShareRow[] }>("/api/shares")
      .then((res) => setLinks(res.links))
      .catch(() => setLinks([]));
  }, []);

  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  async function copy(row: ShareRow) {
    const url = `${window.location.origin}${row.urlPath}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.info(url);
    }
  }

  async function revoke(row: ShareRow) {
    try {
      await apiCall(`/api/files/${row.file.id}/share?linkId=${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      toast.success(`Link for “${row.file.name}” revoked`);
      await loadLinks();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed");
    }
  }

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
          <Link2 className="h-5 w-5" /> Sharing
        </CardTitle>
        <CardDescription>
          Every active public link across your files. Anyone with a link can download that file
          without an account — revoke access here at any time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {links === null ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Nothing is shared right now. Use the Share action on any file to create a link.
          </p>
        ) : (
          <div className="space-y-2">
            {links.map((row) => (
              <div key={row.id} className="rounded-xl border px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium truncate text-sm">
                    {row.file.name}
                    {row.file.trashedAt && (
                      <Badge variant="secondary" className="ml-2">
                        file in trash
                      </Badge>
                    )}
                    {row.expired && (
                      <Badge variant="destructive" className="ml-2">
                        expired
                      </Badge>
                    )}
                  </p>
                  <span className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => copy(row)} aria-label="Copy link">
                      {copiedId === row.id ? <BadgeCheck className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                    <a
                      href={row.urlPath}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-grid place-items-center h-7 w-7 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                      aria-label="Open public page"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => revoke(row)}
                      aria-label="Revoke link"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground font-mono truncate">{row.urlPath}</p>
                <p className="text-[11px] text-muted-foreground">
                  {row.downloads} download{row.downloads === 1 ? "" : "s"} · created {formatDate(row.createdAt)}
                  {row.expiresAt ? ` · ${row.expired ? "expired" : "expires"} ${formatDate(row.expiresAt)}` : " · no expiry"}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Theme picker card: 5 themes as visual swatch cards; preference is saved
 *  instantly (localStorage via next-themes) and applied app-wide. */
function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
          <Palette className="h-5 w-5" /> Appearance
        </CardTitle>
        <CardDescription>
          Pick how Pufflet looks. The choice is saved on this device; System follows your OS light/dark
          setting automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {THEME_OPTIONS.map((opt) => {
            const active = mounted && theme === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setTheme(opt.value)}
                className={`rounded-xl border-2 p-2 text-center transition-all hover:-translate-y-0.5 hover:shadow-md ${
                  active ? "border-primary shadow-sm" : "border-transparent bg-muted/40"
                }`}
                aria-pressed={active}
              >
                <ThemeSwatch value={opt.value} />
                <span className="mt-2 flex items-center justify-center gap-1.5 text-xs font-medium">
                  <ThemeIcon theme={opt.value} className="h-3.5 w-3.5" />
                  {opt.label}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/** Miniature preview of a theme (background + brand gradient + text chips). */
function ThemeSwatch({ value }: { value: string }) {
  const palettes: Record<string, { bg: string; fg: string; from: string; to: string }> = {
    light: { bg: "#f7f8fd", fg: "#2b2f55", from: "#6c9ef9", to: "#9f7df3" },
    dark: { bg: "#171a2b", fg: "#eef0fa", from: "#5f93f7", to: "#a98df5" },
    system: { bg: "linear-gradient(120deg,#f7f8fd 49.5%,#171a2b 50.5%)", fg: "#4b5178", from: "#6c9ef9", to: "#9f7df3" },
    midnight: { bg: "#0b0b12", fg: "#e9e7f7", from: "#8f7df3", to: "#c084fc" },
    sepia: { bg: "#f5efe2", fg: "#4a3f30", from: "#e0954f", to: "#c26d5a" },
  };
  const p = palettes[value] ?? palettes.light;
  return (
    <span
      className="block h-14 w-full rounded-lg border border-black/10 relative overflow-hidden"
      style={{ background: p.bg }}
      aria-hidden
    >
      <span className="absolute left-1.5 top-1.5 h-2 w-8 rounded-full" style={{ backgroundImage: `linear-gradient(135deg, ${p.from}, ${p.to})` }} />
      <span className="absolute left-1.5 bottom-1.5 flex gap-1">
        <span className="h-3 w-3 rounded-sm" style={{ background: p.fg, opacity: 0.85 }} />
        <span className="h-3 w-5 rounded-sm" style={{ background: p.fg, opacity: 0.4 }} />
      </span>
    </span>
  );
}
