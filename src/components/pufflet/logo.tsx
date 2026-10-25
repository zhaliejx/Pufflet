// Pufflet cloud logo as an inline React SVG component (vector, no rasters).
// The standalone files public/logo.svg (full lockup) and public/logo-icon.svg
// are generated from scripts/gen_logo.py.

export function PuffletIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="20 30 600 440" role="img" aria-label="Pufflet" className={className}>
      <defs>
        <linearGradient id="pfiCloud" gradientUnits="userSpaceOnUse" x1="150" y1="90" x2="520" y2="440">
          <stop offset="0" stopColor="#FDFDFF" />
          <stop offset="0.38" stopColor="#D9E3FF" />
          <stop offset="0.72" stopColor="#9DBCFB" />
          <stop offset="1" stopColor="#6C9EF9" />
        </linearGradient>
        <radialGradient id="pfiPurple" gradientUnits="userSpaceOnUse" cx="195" cy="358" r="205">
          <stop offset="0" stopColor="#9F7DF3" stopOpacity="0.9" />
          <stop offset="0.55" stopColor="#9F7DF3" stopOpacity="0.24" />
          <stop offset="1" stopColor="#9F7DF3" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="pfiSheen" gradientUnits="userSpaceOnUse" cx="322" cy="148" r="170">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.9" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="pfiShadow">
          <stop offset="0" stopColor="#283070" stopOpacity="0.22" />
          <stop offset="0.55" stopColor="#283070" stopOpacity="0.1" />
          <stop offset="1" stopColor="#283070" stopOpacity="0" />
        </radialGradient>
        <clipPath id="pfiClip">
          <circle cx="212" cy="322" r="106" />
          <circle cx="330" cy="242" r="141" />
          <circle cx="452" cy="318" r="112" />
          <rect x="166" y="322" width="292" height="108" rx="54" />
        </clipPath>
      </defs>

      <ellipse cx="330" cy="457" rx="185" ry="26" fill="url(#pfiShadow)" />

      <g fill="url(#pfiCloud)">
        <circle cx="212" cy="322" r="106" />
        <circle cx="330" cy="242" r="141" />
        <circle cx="452" cy="318" r="112" />
        <rect x="166" y="322" width="292" height="108" rx="54" />
      </g>
      <g fill="url(#pfiPurple)" clipPath="url(#pfiClip)">
        <circle cx="195" cy="358" r="205" />
      </g>
      <g clipPath="url(#pfiClip)">
        <ellipse cx="322" cy="148" rx="122" ry="78" fill="url(#pfiSheen)" />
      </g>

      {/* face */}
      <g fill="#283070">
        <circle cx="301" cy="297" r="23" />
        <circle cx="391" cy="293" r="23" />
      </g>
      <g fill="#FFFFFF">
        <circle cx="309" cy="289" r="8" />
        <circle cx="399" cy="285" r="8" />
      </g>
      <path d="M316 336 Q351 366 388 332" fill="none" stroke="#283070" strokeWidth="15" strokeLinecap="round" />

      {/* sparkles */}
      <g strokeLinecap="round" fill="none">
        <path d="M522 96 L546 56" stroke="#38A9FF" strokeWidth="22" />
        <path d="M576 165 L614 156" stroke="#8B5CF6" strokeWidth="20" />
        <path d="M560 224 L597 216" stroke="#38A9FF" strokeWidth="15" />
        <path d="M104 224 L78 182" stroke="#8B5CF6" strokeWidth="20" />
        <path d="M96 272 L57 264" stroke="#38A9FF" strokeWidth="15" />
      </g>
    </svg>
  );
}

export function PuffletWordmark({ className }: { className?: string }) {
  return (
    <span className={`font-brand font-bold tracking-tight text-brand-heading ${className ?? ""}`}>
      Pufflet
    </span>
  );
}
