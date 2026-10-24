#!/usr/bin/env python3
"""Generate Pufflet SVG logo: hand-crafted cloud icon + Baloo2-ExtraBold wordmark as paths."""
from fontTools import ttLib
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

FONT = "/home/z/my-project/scripts/Baloo2.ttf"
TEXT = "Pufflet"

# ---------- 1. Wordmark outlines ----------
ft = ttLib.TTFont(FONT)
instantiateVariableFont(ft, {"wght": 800}, inplace=True)
glyphset = ft.getGlyphSet()
cmap = ft.getBestCmap()
upm = ft["head"].unitsPerEm
hmtx = ft["hmtx"]

# kerning via GPOS is complex; Baloo2 pair kerning is subtle -> acceptable without
x = 0
paths = []
for ch in TEXT:
    gname = cmap[ord(ch)]
    glyph = glyphset[gname]
    pen = SVGPathPen(glyphset)
    tpen = TransformPen(pen, Transform(1, 0, 0, 1, x, 0))
    glyph.draw(tpen)
    d = pen.getCommands()
    if d:
        paths.append(d)
    x += hmtx[gname][0]
total_units = x
print("advance units:", total_units, "upm:", upm)

FONT_SIZE = 132  # px
scale = FONT_SIZE / upm
word_w = total_units * scale
print("word width px:", round(word_w, 1))

NAVY = "#283070"

# ---------- 2. Icon (640x480 space) ----------
CLOUD_SHAPES = '''<circle cx="212" cy="322" r="106"/>
    <circle cx="330" cy="242" r="141"/>
    <circle cx="452" cy="318" r="112"/>
    <rect x="166" y="322" width="292" height="108" rx="54"/>'''

icon = f'''
  <defs>
    <linearGradient id="pgCloud" gradientUnits="userSpaceOnUse" x1="150" y1="90" x2="520" y2="440">
      <stop offset="0" stop-color="#FDFDFF"/>
      <stop offset="0.38" stop-color="#D9E3FF"/>
      <stop offset="0.72" stop-color="#9DBCFB"/>
      <stop offset="1" stop-color="#6C9EF9"/>
    </linearGradient>
    <radialGradient id="pgPurple" gradientUnits="userSpaceOnUse" cx="195" cy="358" r="205">
      <stop offset="0" stop-color="#9F7DF3" stop-opacity="0.9"/>
      <stop offset="0.55" stop-color="#9F7DF3" stop-opacity="0.24"/>
      <stop offset="1" stop-color="#9F7DF3" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="pgSheen" gradientUnits="userSpaceOnUse" cx="322" cy="148" r="170">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="pgShadow">
      <stop offset="0" stop-color="#283070" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#283070" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#283070" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="pgClip">{CLOUD_SHAPES}</clipPath>
  </defs>

  <!-- ground shadow (radial falloff, no filter for renderer compatibility) -->
  <ellipse cx="330" cy="457" rx="185" ry="26" fill="url(#pgShadow)"/>

  <!-- cloud body: overlapping puffs share a userSpace gradient so they read as one shape -->
  <g fill="url(#pgCloud)">
    {CLOUD_SHAPES}
  </g>
  <!-- purple tint on the left lobe, clipped to silhouette -->
  <g fill="url(#pgPurple)" clip-path="url(#pgClip)">
    <circle cx="190" cy="350" r="225"/>
  </g>
  <!-- glossy sheen on top puff, clipped to silhouette -->
  <g clip-path="url(#pgClip)">
    <ellipse cx="322" cy="148" rx="122" ry="78" fill="url(#pgSheen)"/>
  </g>

  <!-- face -->
  <g fill="{NAVY}">
    <circle cx="301" cy="297" r="23"/>
    <circle cx="391" cy="293" r="23"/>
  </g>
  <g fill="#FFFFFF">
    <circle cx="309" cy="289" r="8"/>
    <circle cx="399" cy="285" r="8"/>
  </g>
  <path d="M316 336 Q351 366 388 332" fill="none" stroke="{NAVY}" stroke-width="15" stroke-linecap="round"/>

  <!-- sparkles -->
  <g stroke-linecap="round" fill="none">
    <path d="M522 96 L546 56"  stroke="#38A9FF" stroke-width="22"/>
    <path d="M576 165 L614 156" stroke="#8B5CF6" stroke-width="20"/>
    <path d="M560 224 L597 216" stroke="#38A9FF" stroke-width="15"/>
    <path d="M104 224 L78 182" stroke="#8B5CF6" stroke-width="20"/>
    <path d="M96 272 L57 264" stroke="#38A9FF" stroke-width="15"/>
  </g>
'''

# icon-only svg
icon_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" role="img" aria-label="Pufflet cloud logo">{icon}
</svg>
'''

# ---------- 3. Full lockup (icon + wordmark) ----------
# canvas 960x680, icon centered top, wordmark centered below
icon_tx = (960 - 640 * 1.08) / 2  # scale icon 1.08x
icon_ty = 8
wm_x = (960 - word_w) / 2
wm_baseline_y = 608  # baseline in canvas px; glyphs drawn with y-down (font y-up -> flip)

# fontTools glyphs are y-up; flip vertically around baseline
word_paths = ""
xoff = 0
for ch in TEXT:
    gname = cmap[ord(ch)]
    glyph = glyphset[gname]
    pen = SVGPathPen(glyphset)
    # transform: scale(flip y), then translate into canvas position
    t = Transform(scale, 0, 0, -scale, wm_x + xoff * scale, wm_baseline_y)
    tpen = TransformPen(pen, t)
    glyph.draw(tpen)
    d = pen.getCommands()
    if d:
        word_paths += f'<path transform="translate(0,0)" d="{d}"/>\n    '
    xoff += hmtx[gname][0]
# note: paths already carry absolute coords from TransformPen

lockup_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 680" role="img" aria-label="Pufflet logo">
  <g transform="translate({icon_tx:.1f},{icon_ty:.1f}) scale(1.08)">
{icon}
  </g>
  <g fill="{NAVY}">
    {word_paths}
  </g>
</svg>
'''

# ---------- 4. Icon-only for app header (tight crop) ----------
header_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 30 600 440" role="img" aria-label="Pufflet">{icon}
</svg>
'''

with open("/home/z/my-project/public/logo.svg", "w") as f:
    f.write(lockup_svg)
with open("/home/z/my-project/public/logo-icon.svg", "w") as f:
    f.write(icon_svg)
with open("/home/z/my-project/src/app/icon.svg", "w") as f:
    f.write(header_svg)
print("written: public/logo.svg, public/logo-icon.svg, src/app/icon.svg")
