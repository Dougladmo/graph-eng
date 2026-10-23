#!/usr/bin/env bash
# Cria um repositório de benchmark a partir do esqueleto: setup.sh <destino>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$1"
[ -e "$dest" ] && { echo "destino já existe: $dest" >&2; exit 1; }
mkdir -p "$dest"
cp -R "$here/workspace/." "$dest/"
cd "$dest"
mv gitignore.txt .gitignore
find . -name '*.txt' -type f | while read -r f; do mv "$f" "${f%.txt}"; done
npm install --no-audit --no-fund --loglevel=error
git init -q
git add -A
git -c user.name=benchmark -c user.email=benchmark@local commit -qm "esqueleto do benchmark minecraft"
echo "pronto: $dest"
