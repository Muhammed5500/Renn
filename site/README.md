# site

The Renn landing page. Next.js 16 (App Router, Turbopack), Tailwind v4, no database and no API routes: every section is static and its content is the repository's own, so the page and the README cannot drift apart silently.

```bash
npm install
npm run dev     # http://localhost:3000
npm run build
```

This folder is **not** part of the root npm workspace (`sdk`, `operator`, `demo`), so it keeps its own `node_modules` and lockfile. Installing at the repository root does not pull Next.js in.

## Deploying

On Vercel, set **Root Directory** to `site`. The framework is detected automatically and no environment variables are needed.

## Where the content comes from

| On the page | Source in this repository |
|---|---|
| Fee and batch figures | [`LIMITS.md`](../LIMITS.md) |
| Vault, token and SPP pool addresses | [`deployments.json`](../deployments.json), [`spp/deployments.json`](../spp/deployments.json) |
| Demo transaction hashes | the demo table in [`README.md`](../README.md) |
| Spendable-balance rule, trust model | [`README.md`](../README.md), [`operator/src/core.ts`](../operator/src/core.ts) |
| Response shapes in "How it works" | [`operator/src/server.ts`](../operator/src/server.ts), [`sdk/src/x402.ts`](../sdk/src/x402.ts) |
| SDK examples | the "Use it" section of [`README.md`](../README.md) |
| Private entry | the "Private entry (SPP)" section of [`README.md`](../README.md) |

Every outward link and on-chain address lives in [`lib/links.ts`](lib/links.ts). When a deployment changes, that is the only file to edit.

## Structure

```
app/
  layout.tsx     fonts (Instrument Sans, Instrument Serif, JetBrains Mono) and metadata
  page.tsx       the section order
  globals.css    the design tokens, type scale and the page's animations
  icon.svg       favicon
components/landing/
  navigation.tsx           header
  hero-section.tsx         headline, install command, measured figures
  features-section.tsx     the spendable-balance rule and what it guarantees
  how-it-works-section.tsx how one payment clears, step by step, with the real payload shapes
  private-entry-section.tsx entering the vault through an SPP pool
  infrastructure-section.tsx measured limits and the demo scenes, each linked on chain
  developers-section.tsx   the SDK, five runnable examples
  footer-section.tsx       links
  animated-sphere.tsx      the hero's ASCII canvas
  animated-wave.tsx        the footer's canvas
lib/links.ts     every URL and address the page uses
```

The design started from a v0 template and was rebuilt around this project: seven of the original twelve sections were removed, the rest were rewritten, and the unused dependencies went with them (from sixty-odd packages down to nine).
