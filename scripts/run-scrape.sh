#!/bin/bash
#
# Wrapper script for the daily scrape job.
# Called by cron — sets up the environment and runs the scraper.

# Resolve project directory (parent of scripts/)
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"

# Load nvm / node if installed via nvm (common on Ubuntu servers)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Alternatively, add node to PATH if installed globally
export PATH="/usr/local/bin:/usr/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH"

cd "$PROJECT_DIR" || exit 1

echo ""
echo "════════════════════════════════════════════"
echo "  UAE Price Tracker — Daily Scrape"
echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "════════════════════════════════════════════"

# Run the scraper
npx ts-node src/cron/run-scrape.ts 2>&1

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ Scrape completed successfully"
else
  echo "⚠️  Scrape finished with errors (exit code: $EXIT_CODE)"
fi

echo "────────────────────────────────────────────"
echo ""

# Keep only last 30 days of logs (rotate)
find "$LOG_DIR" -name "scrape-*.log" -mtime +30 -delete 2>/dev/null

exit $EXIT_CODE
