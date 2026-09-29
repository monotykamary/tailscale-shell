#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
zsh -n ts
sh -n install.sh
for wrapper in ts.d/*; do sh -n "$wrapper"; done
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning install.sh ts.d/* tests/run.sh
fi
python3 -m unittest discover -s tests -v
