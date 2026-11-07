#!/bin/zsh
set -euo pipefail
cd -- "${0:A:h}"
exec /usr/bin/caffeinate -dimsu node run.js --mode final --wait-until 12:00 --yes
