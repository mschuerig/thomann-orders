# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Thomann order scraper — a Bun + Puppeteer script that logs into thomann.de, handles cookie consent, and navigates to the order list. Currently a single-file script (`thomann-orders.ts`) in early development.

## Commands

- **Install dependencies:** `bun install`
- **Run:** `./thomann-orders.ts` (or `bun run thomann-orders.ts`)
- **Type-check:** `bun run tsc --noEmit` (no build step; `noEmit` is set in tsconfig)

## Key Details

- Runtime is **Bun** (not Node). Use Bun APIs and `bun` CLI.
- Puppeteer launches a visible Chrome window (`headless: false`, `devtools: true`).
- Credentials live in `credentials.ts` (CJS `module.exports` format). Copy `credentials.ts.example` to get started. **Do not commit `credentials.ts`** — it contains real login data. (Note: the .gitignore negation `!/credentials.ts` does not currently protect it; it should be added to ignored files.)
- TypeScript is configured in strict bundler mode with `verbatimModuleSyntax`. The project mixes ESM imports with a CJS `require('./credentials')` call.
