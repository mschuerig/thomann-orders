#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <orders.json>" >&2
  exit 1
fi

jq -r '
  ["orderNumber","orderType","date","status","totalSum","itemName","articleNumber","count","unitPrice","lineTotal","productUrl","imageUrl","orderUrl","invoiceUrl"],
  (.orders[] | . as $o | .items[] |
    [$o.orderNumber, $o.orderType, $o.dateIso, $o.status, $o.totalSumNum,
     .name, .articleNumber, .count, .unitPriceNum, .lineTotalNum,
     .productUrl, .imageUrl, $o.orderUrl, ($o.invoiceUrl // "")]
  ) | @csv
' "$1"
