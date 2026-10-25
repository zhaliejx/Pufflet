// Public share page (/s/<token>) — server component, no login required.
// Renders a download card for a valid share link. image/video/audio/pdf and
// text-ish files get an inline preview; everything else shows a clean info
// screen with the kind icon (SVG only — no emojis) + download. Invalid,
// revoked, or expired links show a friendly "link unavailable" state without
// leaking whether the token ever existed.
import type { Metadata } from "next";
import { PuffletIcon, PuffletWordmark } from "@/components/pufflet/logo";
import { formatBytes, fileKind } from "@/lib/format";
import { resolveShareLink, ShareError, isPublicInlineSafe } from "@/lib/share";
import {
  CloudOff,
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared file — Pufflet",
  robots: { index: false, follow: false },
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
  other: FileIcon,
} as const;

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

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let share: Awaited<ReturnType<typeof resolveShareLink>> | null = null;
  try {
    share = await resolveShareLink(token);
  } catch (err) {
    if (!(err instanceof ShareError)) throw err;
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-muted/70 to-background">
      <header className="px-4 py-3 flex items-center gap-2">
        <PuffletIcon className="h-9 w-9" />
        <PuffletWordmark className="text-xl" />
        <span className="ml-auto text-xs text-muted-foreground bg-card/80 border rounded-full px-3 py-1">
          public share
        </span>
      </header>

      <main className="flex-1 grid place-items-center px-4 pb-16">
        {share ? (
          <ShareCard
            token={token}
            name={share.file.name}
            size={share.file.size}
            mimeType={share.file.mimeType}
            previewable={isPublicInlineSafe(share.file.mimeType)}
          />
        ) : (
          <div className="rounded-3xl border bg-card/90 shadow-sm px-10 py-12 max-w-md w-full text-center">
            <span className="mx-auto mb-4 grid place-items-center h-16 w-16 rounded-2xl bg-muted">
              <CloudOff className="h-8 w-8 text-muted-foreground" />
            </span>
            <h1 className="font-brand text-2xl font-bold text-brand-heading mb-2">Link unavailable</h1>
            <p className="text-sm text-muted-foreground">
              This share link doesn&apos;t exist, was revoked by its owner, or has expired. Ask the sender for a
              fresh link.
            </p>
          </div>
        )}
      </main>

      <footer className="pb-6 text-center text-xs text-muted-foreground">
        Shared via Pufflet — files are stored encrypted and served over your own deployment.
      </footer>
    </div>
  );
}

function ShareCard({
  token,
  name,
  size,
  mimeType,
  previewable,
}: {
  token: string;
  name: string;
  size: number;
  mimeType: string;
  previewable: boolean;
}) {
  const kind = fileKind(name, mimeType);
  const Icon = KIND_ICON[kind as keyof typeof KIND_ICON] ?? FileIcon;
  const downloadPath = `/api/share/${token}/download`;
  // Public inline safety is decided server-side (isPublicInlineSafe); text-ish
  // kinds additionally render inside a sandboxed iframe below.
  const inline = previewable ? "&inline=1" : "";
  const hasMediaPreview = previewable && ["image", "video", "pdf"].includes(kind);
  const hasFramePreview = previewable && ["text", "code"].includes(kind);
  const hasAudioPreview = previewable && kind === "audio";

  return (
    <div className="rounded-3xl border bg-card/90 shadow-sm px-6 sm:px-8 py-8 max-w-lg w-full text-center">
      {hasMediaPreview && kind === "image" ? (
        <img
          src={`${downloadPath}?inline=1`}
          alt={name}
          className="mx-auto mb-6 max-h-72 rounded-2xl border object-contain bg-muted/40"
        />
      ) : hasMediaPreview && kind === "video" ? (
        <div className="mx-auto mb-6 max-h-72 rounded-2xl border bg-muted/50 grid place-items-center overflow-hidden">
          <video src={`${downloadPath}?inline=1`} controls className="max-h-72 w-full" preload="metadata" />
        </div>
      ) : hasMediaPreview ? (
        <div className="mx-auto mb-6 rounded-2xl border bg-white overflow-hidden">
          <object data={`${downloadPath}?inline=1`} type={mimeType} className="w-full h-72">
            <div className="grid place-items-center h-72 text-muted-foreground text-sm bg-muted/40">
              <span className="flex flex-col items-center gap-2">
                <FileText className="h-8 w-8" />
                PDF preview unavailable — download instead
              </span>
            </div>
          </object>
        </div>
      ) : hasAudioPreview ? (
        <div className="mx-auto mb-6 rounded-2xl border bg-muted/40 p-6">
          <span className="mx-auto mb-4 grid place-items-center h-14 w-14 rounded-2xl pufflet-gradient text-white">
            <FileAudio className="h-7 w-7" />
          </span>
          <audio src={`${downloadPath}?inline=1`} controls className="w-full" preload="metadata" />
        </div>
      ) : hasFramePreview ? (
        <div className="mx-auto mb-6 rounded-2xl border overflow-hidden bg-white">
          <iframe
            src={`${downloadPath}?inline=1`}
            title={name}
            sandbox=""
            className="w-full h-72 bg-white"
          />
        </div>
      ) : (
        <div className="mx-auto mb-4 grid place-items-center h-20 w-20 rounded-2xl bg-muted">
          <Icon className="h-10 w-10 icon-file" />
        </div>
      )}

      <h1 className="font-semibold text-lg text-brand-heading break-words">{name}</h1>
      <p className="text-sm text-muted-foreground mt-1 mb-6">
        {KIND_LABEL[kind] ?? "File"} · {formatBytes(size)}
        {mimeType !== "application/octet-stream" ? ` · ${mimeType}` : ""}
      </p>

      <a
        href={`${downloadPath}${inline}`}
        className="inline-flex items-center gap-2 rounded-full pufflet-gradient text-white font-medium px-6 py-2.5 shadow hover:opacity-95 transition-opacity"
        download={name}
      >
        <Download className="h-[18px] w-[18px]" />
        Download
      </a>
      <p className="text-[11px] text-muted-foreground mt-4">No account needed — the link is the key.</p>
    </div>
  );
}
