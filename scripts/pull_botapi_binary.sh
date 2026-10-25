#!/bin/bash
# Pull the real telegram-bot-api binary out of the aiogram Docker image
# (registry API, no docker needed) plus the musl loader/libs it needs,
# so we can run it on this glibc sandbox and reproduce the Render failure.
set -e
SIM=/home/z/my-project/.botapi-sim
rm -rf "$SIM" && mkdir -p "$SIM/rootfs"
cd "$SIM"

# ---- 1. auth token + manifest (amd64) --------------------------------------
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:aiogram/telegram-bot-api:pull" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
ACCEPT='Accept: application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'
curl -s -H "Authorization: Bearer $TOKEN" -H "$ACCEPT" \
  https://registry-1.docker.io/v2/aiogram/telegram-bot-api/manifests/latest -o index.json
node -e '
const m=JSON.parse(require("fs").readFileSync("index.json"));
if(m.manifests){const pick=m.manifests.find(x=>x.platform&&x.platform.architecture==="amd64"&&(!x.platform.os||x.platform.os==="linux"));
if(!pick){console.error(JSON.stringify(m.manifests.map(x=>x.platform),null,1));process.exit(1)}
console.log(pick.digest)}' > amd64.digest
echo "amd64 manifest: $(cat amd64.digest)"
curl -s -H "Authorization: Bearer $TOKEN" -H "$ACCEPT" \
  "https://registry-1.docker.io/v2/aiogram/telegram-bot-api/manifests/$(cat amd64.digest)" -o manifest.json
node -e '
const m=JSON.parse(require("fs").readFileSync("manifest.json"));
console.error("config:",m.config.digest,"layers:",m.layers.length);
for(const l of m.layers) console.log(l.digest);
' > layers.txt
head -1 layers.txt 1>&2

# ---- 2. download + extract all layers --------------------------------------
mkdir -p layers
n=0
while read -r dg; do
  [ -z "$dg" ] && continue
  n=$((n+1))
  echo "layer $n: $dg"
  curl -sL -H "Authorization: Bearer $TOKEN" "https://registry-1.docker.io/v2/aiogram/telegram-bot-api/blobs/$dg" -o "layers/l$n.tgz"
  tar -xzf "layers/l$n.tgz" -C rootfs 2>/dev/null || echo "  (layer $n: some entries skipped)"
done < layers.txt

ls -la rootfs/usr/local/bin/ 2>/dev/null || true
cp -v rootfs/usr/local/bin/telegram-bot-api ./telegram-bot-api 2>/dev/null || { echo "BINARY NOT FOUND"; exit 1; }
file telegram-bot-api || true

# ---- 3. musl loader + libs from Alpine CDN ---------------------------------
# (match the image: alpine 3.22-ish; use v3.22 x86_64 packages)
APK=https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64
mkdir -p alpine-libs rootfs-libs
for pkg in musl libstdc++ libgcc; do
  name=$(curl -s "$APK/" | grep -o "${pkg}-[0-9][^\"']*\.apk" | grep -v "dev\|doc\|lang\|static" | head -1)
  echo "apk: $name"
  curl -sL "$APK/$name" -o "$name.apk"
  tar -xzf "$name.apk" -C rootfs-libs 2>/dev/null || true
done
mkdir -p muslroot/lib
cp rootfs-libs/lib/ld-musl-x86_64.so.1 muslroot/lib/ 2>/dev/null || cp rootfs-libs/lib/libc.musl-x86_64.so.1 muslroot/lib/ld-musl-x86_64.so.1
cp rootfs-libs/lib/libstdc++.so.6* muslroot/lib/ 2>/dev/null || true
cp rootfs-libs/lib/libgcc_s.so.1* muslroot/lib/ 2>/dev/null || true
ls -la muslroot/lib/

echo "SETUP DONE"
