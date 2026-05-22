#!/bin/bash
# ship — one-keystroke deploy.
#
# Usage:
#   ./ship.sh "your commit message"
#   ./ship.sh                          # uses a generic message
#
# Does: clears any stale git lock, stages everything, commits, pushes to
# origin/main. Vercel auto-deploys on push.

set -e
cd "$(dirname "$0")"

# Clear stale lock if a previous git process crashed
[ -f .git/index.lock ] && rm -f .git/index.lock

# Default message if none given
MSG="${1:-chore: ship pending changes}"

git add -A
if git diff --cached --quiet ; then
  echo "nothing to commit. all clean."
  exit 0
fi

git commit -m "$MSG"
git push

echo ""
echo "✓ shipped. vercel rebuild typically lands in 60-90 seconds."
echo "  refresh /admin and check the build stamp (top of page) to confirm."
