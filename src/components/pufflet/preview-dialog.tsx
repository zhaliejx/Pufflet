"use client";

// Preview dialog — inline viewers for every supported family:
//   image / video / audio / pdf / text+code  -> native viewers
//   everything else (docs, sheets, slides, archives, unknown) -> clean info
//   screen with metadata + download.
// Streams come from the session download endpoint with ?inline=1 (transparent
// vault decryption server-side), so no extra auth plumbing is needed.
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, formatDate, fileKind } from "@/lib/format";
import type { FileRow } from "./store";
import { apiCall } from "./store";
import { toast } from "sonner";
import {
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  TriangleAlert,
} from "lucide-react";

const KIND_LABEL: Record<string, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF document",
  archive: "Archive",
  doc: "Document",
  sheet: "Spreadsheet",
  slides: "Presentation",
  code: "Code",
  text: "Text",
  other: "File",
};

const KIND_ICON = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  archive: FileArchive,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: FileText,
  code: FileCode,
  text: FileText,
  other: File,
} as const;

/** Kinds rendered by a native in-dialog viewer (everything else -> info card). */
const VIEWABLE = new Set(["image", "video", "audio", "pdf", "text", "code"]);
const TEXT_PREVIEW_CAP = 1024 * 1024; // 1 MB of text/code is plenty for a peek

export function PreviewDialog({ file, onClose }: { file: FileRow | null; onClose: () => void }) {
  // Controlled open so the exit animation plays before the row is cleared.
  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && onClose()}>
      {file && <PreviewBody file={file} onClose={onClose} />}
    </Dialog>
  );
}

function PreviewBody({ file, onClose }: { file: FileRow; onClose: () => void }) {
  const kind = fileKind(file.name, file.mimeType);
  const canView = VIEWABLE.has(kind);
  const Icon = KIND_ICON[kind as keyof typeof KIND_ICON] ?? File;

  async function shareNow() {
    try {
      const res = await apiCall<{ url?: string }>(`/api/files/${file.id}/share`, { method: "POST" });
      const url = res.url ?? `${window.location.origin}/s/`;
      await navigator.clipboard.writeText(url).then(
        () => toast.success("Share link copied to clipboard"),
        () => toast.error(url, { description: "Copy this share link" }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create a share link");
    }
  }

  return (
    <DialogContent className="h-[92dvh] sm:h-[88vh] w-[100vw] sm:w-auto sm:max-w-4xl p-0 overflow-hidden flex flex-col rounded-none sm:rounded-2xl gap-0">
      <div className="sr-only">
        <DialogTitle>Preview of {file.name}</DialogTitle>
      </div>

      {/* header */}
      <div className="flex items-center gap-3 border-b px-4 py-3 shrink-0 bg-card">
        <span className="grid place-items-center h-9 w-9 rounded-xl bg-muted shrink-0">
          <Icon className="h-5 w-5 icon-file" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate leading-tight">{file.name}</p>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
            <Badge variant="secondary" className="h-4.5 px-1.5 text-[10px] leading-none">
              {KIND_LABEL[kind] ?? "File"}
            </Badge>
            {formatBytes(file.size)} · {formatDate(file.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={shareNow} aria-label="Share file">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => window.open(`/api/files/${file.id}/download`, "_blank")} aria-label="Download file">
            <Download className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close preview">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </Button>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-hidden preview-surface">
        {canView ? (
          <KindViewer file={file} kind={kind} />
        ) : (
          <UnsupportedInfo file={file} kind={kind} />
        )}
      </div>
    </DialogContent>
  );
}

/* ---------------------------------------------------------------- viewers */

function KindViewer({ file, kind }: { file: FileRow; kind: string }) {
  const src = `/api/files/${file.id}/download?inline=1`;
  switch (kind) {
    case "image":
      return <ImageViewer src={src} alt={file.name} />;
    case "video":
      return (
        <div className="h-full w-full grid place-items-center p-4">
          <video src={src} controls preload="metadata" className="max-h-full max-w-full rounded-xl shadow-lg bg-black" />
        </div>
      );
    case "audio":
      return <AudioViewer src={src} name={file.name} />;
    case "pdf":
      return (
        <div className="relative h-full w-full">
          <iframe src={src} title={file.name} className="h-full w-full bg-white" />
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-background/90 border px-3 py-1.5 text-xs shadow hover:bg-accent transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open in new tab
          </a>
        </div>
      );
    default:
      return <TextViewer file={file} src={src} code={kind === "code"} />;
  }
}

function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  return (
    <div className="relative h-full w-full grid place-items-center p-4">
      {state === "loading" && <Loader2 className="h-8 w-8 animate-spin text-muted-foreground absolute" />}
      {state === "error" ? (
        <PreviewError message="This image could not be loaded. It may be too large or in an unsupported format — try downloading it." />
      ) : (
        <img
          src={src}
          alt={alt}
          onLoad={() => setState("ok")}
          onError={() => setState("error")}
          className={`max-h-full max-w-full object-contain rounded-xl shadow-lg transition-opacity ${state === "ok" ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </div>
  );
}

function AudioViewer({ src, name }: { src: string; name: string }) {
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "AUDIO";
  return (
    <div className="h-full w-full grid place-items-center p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card shadow-sm p-6 text-center space-y-5 animate-fade-up">
        <span className="mx-auto grid place-items-center h-16 w-16 rounded-2xl pufflet-gradient text-white">
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
          </svg>
        </span>
        <div>
          <p className="font-medium truncate">{name}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{ext} audio</p>
        </div>
        <audio src={src} controls className="w-full" preload="metadata" />
      </div>
    </div>
  );
}

function TextViewer({ file, src, code }: { file: FileRow; src: string; code: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const truncated = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    setText(null);
    truncated.current = false;
    try {
      if (file.size > TEXT_PREVIEW_CAP * 4) {
        throw new Error("File is too large to preview as text (over 4 MB).");
      }
      const res = await fetch(src);
      if (!res.ok) throw new Error(`Could not load the file (${res.status}).`);
      const full = await res.text();
      if (full.length > TEXT_PREVIEW_CAP) {
        truncated.current = true;
        setText(full.slice(0, TEXT_PREVIEW_CAP));
      } else {
        setText(full);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load preview");
    }
  }, [file.size, src]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <PreviewError message={error} />;
  if (text === null) {
    return (
      <div className="h-full max-w-3xl mx-auto p-6 space-y-2 overflow-hidden">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${88 - ((i * 13) % 40)}%` }} />
        ))}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto thin-scroll">
      {truncated.current && (
        <p className="sticky top-0 z-10 bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 border-b px-4 py-1.5 text-xs flex items-center gap-2">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> Preview truncated to the first 1 MB — download for the full file.
        </p>
      )}
      <pre className="p-4 text-xs leading-5 font-mono whitespace-pre-wrap break-words min-h-full">{text}</pre>
      {code && <span className="sr-only">Code file preview</span>}
    </div>
  );
}

/* --------------------------------------------------------- unsupported */

function UnsupportedInfo({ file, kind }: { file: FileRow; kind: string }) {
  const Icon = KIND_ICON[kind as keyof typeof KIND_ICON] ?? File;
  const formatHint: Record<string, string> = {
    doc: "Word and other text documents can't be rendered in the browser. Download the file to open it in your editor.",
    sheet: "Spreadsheets can't be rendered in the browser. Download the file to open it in your spreadsheet app.",
    slides: "Presentations can't be rendered in the browser. Download the file to open it in your slides app.",
    archive: "Archives can't be inspected in the browser. Download the file to extract it locally.",
    other: "This format has no in-browser viewer. Download the file to open it with the right app.",
  };
  return (
    <div className="h-full w-full grid place-items-center p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card shadow-sm p-8 text-center space-y-4 animate-fade-up">
        <span className="mx-auto grid place-items-center h-16 w-16 rounded-2xl bg-muted">
          <Icon className="h-8 w-8 icon-file" />
        </span>
        <div>
          <p className="font-medium break-words">{file.name}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {KIND_LABEL[kind] ?? "File"} · {formatBytes(file.size)}
            {file.mimeType && file.mimeType !== "application/octet-stream" ? ` · ${file.mimeType}` : ""}
          </p>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{formatHint[kind] ?? formatHint.other}</p>
        <Button className="pufflet-gradient text-white border-0 rounded-full" onClick={() => window.open(`/api/files/${file.id}/download`, "_blank")}>
          <Download className="h-4 w-4" /> Download file
        </Button>
      </div>
    </div>
  );
}

function PreviewError({ message }: { message: string }) {
  return (
    <div className="h-full w-full grid place-items-center p-6">
      <div className="text-center space-y-3 max-w-sm">
        <span className="mx-auto grid place-items-center h-14 w-14 rounded-full bg-destructive/10">
          <TriangleAlert className="h-6 w-6 text-destructive" />
        </span>
        <p className="text-sm text-muted-foreground leading-relaxed">{message}</p>
      </div>
    </div>
  );
}
