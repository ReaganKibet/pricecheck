#!/usr/bin/env bash
# Deploy all edge functions. Run from the repo root after `supabase link`.
# Functions check the x-api-key header themselves, so JWT checks are off.
set -euo pipefail
for fn in match-items compare-basket get-offers ingest-prices lists; do
  supabase functions deploy "$fn" --no-verify-jwt
done
echo "Done. Base URL: https://<project-ref>.supabase.co/functions/v1"
