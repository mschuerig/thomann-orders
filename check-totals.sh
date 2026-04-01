#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <orders.json>" >&2
  exit 1
fi

jq -r '
  .orders[] |
  . as $o |
  ($o.items | map(.lineTotalNum) | add // 0) as $itemSum |
  select(($o.totalSumNum - $itemSum) | fabs > 0.005) |
  "\($o.orderNumber): total=\($o.totalSumNum), items sum=\($itemSum)"
' "$1"
