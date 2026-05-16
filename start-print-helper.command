#!/bin/sh
cd "$(dirname "$0")" || exit 1
echo "Starting Ozon local print helper..."
node scripts/local-print-helper.mjs
