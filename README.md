# Thomann Order Exporter

Export your complete order history from [thomann.de](https://www.thomann.de) to JSON (and optionally CSV).

Since Thomann doesn't offer an API, this tool opens a browser window, logs into your account, and reads through your order pages automatically.

## Prerequisites

- [Bun](https://bun.sh) (JavaScript runtime)
- Google Chrome

## Setup

1. Install dependencies:

   ```sh
   bun install
   ```

2. Create your credentials file by copying the example:

   ```sh
   cp credentials.ts.example credentials.ts
   ```

3. Open `credentials.ts` and fill in your Thomann email and password. This file stays on your computer and is never uploaded anywhere.

## Exporting orders

Run the exporter:

```sh
./thomann-orders.ts
```

A Chrome window will open, log into your Thomann account, and start collecting your orders. When it's done, you'll find a timestamped JSON file like `orders-20260331195030.json` in the project folder.

### Options

| Option | What it does |
|---|---|
| `--full` | Re-export all orders from scratch, ignoring any previous export |
| `--slow` | Add random pauses between pages to avoid overloading the Thomann website |
| `--limit 10` | Only export the first 10 new orders (useful for testing) |

You can combine options:

```sh
./thomann-orders.ts --slow --limit 5
```

Without `--full`, the exporter works **incrementally**: it finds the most recent export file and only fetches orders that aren't in it yet.

## Converting to CSV

If you need your orders in a spreadsheet, convert the JSON file to CSV:

```sh
./to-csv.sh orders-20260331195030.json > orders.csv
```

This requires [jq](https://jqlang.github.io/jq/) to be installed. The CSV has one row per ordered item, with columns for order number, date, status, prices, product name, and links.

## What gets exported

For each order:
- Order number, date, total, status (e.g. "Offen", "Abgeschlossen")
- Link to the order page and invoice PDF (if available)

For each item within an order:
- Product name, article number, quantity, unit price, line total
- Links to the product page and product image

## Analyzing your orders

There's a Jupyter notebook (`analysis.ipynb`) that visualizes your order history. It automatically picks up the most recent `orders-*.json` export file.

### One-time setup

```sh
uv venv .venv
source .venv/bin/activate
uv pip install pandas matplotlib jupyter ipykernel nbstripout
nbstripout --install
```

`nbstripout --install` registers a git filter that strips notebook outputs on commit. This prevents your personal order data — which appears in cell outputs — from being committed, and as a side benefit keeps notebook diffs clean.

### Running the notebook

Activate the venv and launch Jupyter:

```sh
source .venv/bin/activate
jupyter notebook analysis.ipynb
```

If you use [direnv](https://direnv.net/), the venv activates automatically on `cd` into the project (run `direnv allow` once to trust the included `.envrc`).

The notebook includes:
- Yearly summary table (total spent, number of orders, average order value)
- Spending trend bar chart
- Cumulative spending over time
- Monthly spending heatmap (seasonal patterns)
- Top 10 most expensive items per year

## Limitations

- Only works with the German Thomann website (`thomann.de/de/`). Price parsing assumes German number formatting (dot as thousands separator, comma as decimal separator).
