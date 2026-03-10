#!/bin/bash
#
# Sets up a daily cron job to scrape UAE grocery prices.
# Run once:  bash scripts/setup-cron.sh
#
# Defaults to 8:00 AM UAE time (UTC+4 → 04:00 UTC).
# Change CRON_HOUR/CRON_MIN below to adjust.

CRON_HOUR=8
CRON_MIN=0
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
SCRIPT="$PROJECT_DIR/scripts/run-scrape.sh"

# Create logs directory
mkdir -p "$LOG_DIR"

# Make the runner script executable
chmod +x "$SCRIPT"

# Build the cron expression
# Runs daily at the specified hour (server local time)
CRON_LINE="$CRON_MIN $CRON_HOUR * * * $SCRIPT >> $LOG_DIR/scrape.log 2>&1"

# Check if cron job already exists
EXISTING=$(crontab -l 2>/dev/null | grep -F "run-scrape.sh" || true)

if [ -n "$EXISTING" ]; then
  echo "Cron job already exists:"
  echo "  $EXISTING"
  echo ""
  read -p "Replace it? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Keeping existing cron job."
    exit 0
  fi
  # Remove old entry
  crontab -l 2>/dev/null | grep -vF "run-scrape.sh" | crontab -
fi

# Add the new cron job
(crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -

echo "✅ Cron job installed!"
echo "   Schedule: Daily at $CRON_HOUR:$(printf '%02d' $CRON_MIN) (server local time)"
echo "   Command:  $SCRIPT"
echo "   Log file: $LOG_DIR/scrape.log"
echo ""
echo "Verify with: crontab -l"
echo "View logs:   tail -f $LOG_DIR/scrape.log"
