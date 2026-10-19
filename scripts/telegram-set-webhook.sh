#!/usr/bin/env bash
# Set Telegram webhook to your Supabase Edge Function.
# Usage:
#   export TELEGRAM_BOT_TOKEN="..."
#   export TELEGRAM_WEBHOOK_SECRET="..."   # same value as Supabase secret
#   export SUPABASE_PROJECT_REF="mlrhoqapzmmjvtevclkf"
#   ./scripts/telegram-set-webhook.sh

set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_WEBHOOK_SECRET:?Set TELEGRAM_WEBHOOK_SECRET}"
PROJECT_REF="${SUPABASE_PROJECT_REF:-mlrhoqapzmmjvtevclkf}"

WEBHOOK_URL="https://${PROJECT_REF}.supabase.co/functions/v1/telegram-bot"

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${WEBHOOK_URL}" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d "allowed_updates=[\"message\"]" | python3 -m json.tool

echo "Webhook URL: ${WEBHOOK_URL}"
