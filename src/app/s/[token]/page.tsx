// Public share page (/s/<token>) — server component, no login required.
// Renders a minimal download card for a valid share link; image/video/pdf
// get an inline preview. Invalid, revoked, or expired links show a friendly
// "link unavailable" state without leaking whether the token ever existed.
import type { Metadata } from "next";
import { PuffletIcon, PuffletWordmark } from "@/components/pufflet/logo";
import { formatBytes, fileKind } from "@/lib/format";
import { resolveShareLink, ShareError, isPublicInlineSafe } from "@/lib/share";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared file — Pufflet",
  robots: { index: false, follow: false },
};

const KIND_EMOJI: Record<string, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  pdf: "📄",
  archive: "🗜️",
  doc: "📝",
  sheet: "📊",
  slides: "📽️",
  code: "💻",
  text: "📃",
  other: "📦",
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
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-[#f4f7ff] to-white">
      <header className="px-4 py-3 flex items-center gap-2">
        <PuffletIcon className="h-9 w-9" />
        <PuffletWordmark className="text-xl" />
        <span className="ml-auto text-xs text-muted-foreground bg-white/70 border rounded-full px-3 py-1">
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
          <div className="rounded-3xl border bg-white/90 shadow-sm px-10 py-12 max-w-md w-full text-center">
            <div className="text-5xl mb-4">☁️</div>
            <h1 className="font-brand text-2xl font-bold text-[#283070] mb-2">Link unavailable</h1>
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
  const emoji = KIND_EMOJI[kind] ?? KIND_EMOJI.other;
  const inline = previewable ? "&inline=1" : "";
  const downloadPath = `/api/share/${token}/download`;

  return (
    <div className="rounded-3xl border bg-white/90 shadow-sm px-8 py-10 max-w-lg w-full text-center">
      {previewable && (kind === "image" || kind === "video" || kind === "pdf") ? (
        kind === "image" ? (
          <img
            src={`${downloadPath}?inline=1`}
            alt={name}
            className="mx-auto mb-6 max-h-72 rounded-2xl border object-contain"
          />
        ) : (
          <div className="mx-auto mb-6 max-h-72 rounded-2xl border bg-muted/50 grid place-items-center overflow-hidden">
            {kind === "video" ? (
              <video src={`${downloadPath}?inline=1`} controls className="max-h-72 w-full" preload="metadata" />
            ) : (
              <object data={`${downloadPath}?inline=1`} type={mimeType} className="w-full h-72">
                <div className="grid place-items-center h-72 text-muted-foreground text-sm">PDF preview</div>
              </object>
            )}
          </div>
        )
      ) : (
        <div className="text-6xl mb-4">{emoji}</div>
      )}

      <h1 className="font-semibold text-lg text-[#283070] break-words">{name}</h1>
      <p className="text-sm text-muted-foreground mt-1 mb-6">
        {formatBytes(size)} · {mimeType !== "application/octet-stream" ? mimeType : "file"}
      </p>

      <a
        href={`${downloadPath}${inline}`}
        className="inline-flex items-center gap-2 rounded-full pufflet-gradient text-white font-medium px-6 py-2.5 shadow hover:opacity-95 transition-opacity"
        download={name}
      >
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Download
      </a>
      <p className="text-[11px] text-muted-foreground mt-4">No account needed — the link is the key.</p>
    </div>
  );
}
