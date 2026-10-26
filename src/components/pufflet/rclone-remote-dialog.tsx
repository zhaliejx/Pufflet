"use client";

// Add / edit an rclone remote. Field sets come from RCLONE_TYPES (shared with
// the server's validator), so the dialog can only offer what the backend will
// accept. Secrets render as password inputs; on EDIT an empty secret field
// means "keep the stored value" (the server merges).

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, HardDrive } from "lucide-react";
import { toast } from "sonner";
import { apiCall } from "./store";
import { RCLONE_TYPES, rcloneTypeDef } from "@/lib/rclone";

export interface RemoteView {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  config: Record<string, string | null>;
  hasSecrets: boolean;
}

export function RcloneRemoteDialog({
  open,
  onClose,
  editing,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: RemoteView | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("s3");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = useMemo(() => rcloneTypeDef(type), [type]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    if (editing) {
      setName(editing.name);
      setType(editing.type);
      const prefilled: Record<string, string> = {};
      for (const field of rcloneTypeDef(editing.type)?.fields ?? []) {
        const v = editing.config[field.key] ?? "";
        // masked secrets ("••••••") must not round-trip as a value — start empty
        prefilled[field.key] = field.secret && v ? "" : v;
      }
      setValues(prefilled);
    } else {
      setName("");
      setType("s3");
      setValues({});
    }
  }, [open, editing]);

  function switchType(next: string) {
    setType(next);
    setValues({});
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const config: Record<string, string> = {};
      for (const field of def?.fields ?? []) {
        const value = (values[field.key] ?? "").trim();
        if (value) config[field.key] = value;
      }
      if (editing) {
        await apiCall(`/api/rclone/remotes/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim(), type, config }),
        });
        toast.success(`Remote “${name.trim()}” updated`);
      } else {
        await apiCall("/api/rclone/remotes", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), type, config }),
        });
        toast.success(`Remote “${name.trim()}” saved — run Test to verify the credentials`);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the remote");
    } finally {
      setBusy(false);
    }
  }

  const nameOk = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name.trim());
  const requiredOk = (def?.fields ?? [])
    .filter((f) => f.required)
    .every((f) => (values[f.key] ?? "").trim().length > 0 || (editing && (editing.config[f.key] ?? "").length > 0));

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg rounded-2xl max-h-[85vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" /> {editing ? "Edit rclone remote" : "Add rclone remote"}
          </DialogTitle>
          <DialogDescription>
            Credentials are encrypted on the server and never shown again.{" "}
            {editing ? "Leave a secret blank to keep the stored value." : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rclone-remote-name">Remote name</Label>
            <Input
              id="rclone-remote-name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="my-s3"
              autoComplete="off"
              autoFocus={!editing}
            />
            <p className="text-xs text-muted-foreground">
              lowercase letters, digits, hyphens — used as the rclone remote id ({`<name>`}:path).
            </p>
          </div>

          <div className="space-y-2">
            <Label>Backend</Label>
            <Select value={type} onValueChange={switchType} disabled={busy}>
              <SelectTrigger aria-label="Backend type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RCLONE_TYPES.map((t) => (
                  <SelectItem key={t.type} value={t.type}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {def ? <p className="text-xs text-muted-foreground leading-snug">{def.hint}</p> : null}
          </div>

          {(def?.fields ?? []).map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`rc-${field.key}`}>
                {field.label}
                {field.required ? <span className="text-destructive"> *</span> : null}
              </Label>
              <Input
                id={`rc-${field.key}`}
                type={field.secret ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                placeholder={field.secret && editing ? "unchanged" : field.placeholder}
                autoComplete={field.secret ? "new-password" : "off"}
              />
            </div>
          ))}

          {error ? (
            <p role="alert" className="text-sm text-destructive leading-snug">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy || !nameOk || !requiredOk}
            className="pufflet-gradient text-white border-0"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {editing ? "Save changes" : "Add remote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
