// Starts all four agents in one process and lets them trade until stopped.
//
//   node run.ts                 default: a round every 30 s per agent
//   ROUND_MS=60000 node run.ts  slower (each round costs two Claude calls)
//
// Needs the Renn ledger running on :8787 and the Stellar CLI identity
// `deployer` (the test token's admin) for the first deposit.

import { LlmAgent } from "./agent.ts";
import { PERSONAS } from "./personas.ts";
import { LEDGER, U, fmt } from "./identity.ts";

const ROUND_MS = Number(process.env.ROUND_MS ?? 30_000);
const DEPOSIT = BigInt(process.env.DEPOSIT ?? 20) * U;

const alive = await fetch(`${LEDGER}/supported`).then((r) => r.ok).catch(() => false);
if (!alive) {
  console.error(`No ledger at ${LEDGER}. Start it first: cd ../Proje && AUTO_SETTLE=1 ROUND_MS=60000 npm start`);
  process.exit(1);
}

console.log(`Four Claude agents, ledger ${LEDGER}, a round every ~${ROUND_MS / 1000} s each.\n`);

const agents = PERSONAS.map((p) => new LlmAgent(p));
for (const a of agents) await a.start(DEPOSIT);

// Name them on the operator's dashboard.
await fetch(`${LEDGER}/track`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    addresses: agents.map((a) => a.address),
    labels: Object.fromEntries(agents.map((a) => [a.address, a.persona.name])),
  }),
}).catch(() => {});

console.log(`\nDashboard: ${LEDGER}\n`);
for (const a of agents) a.loop(ROUND_MS);

// Balance line every minute. A read can fail on a lagging RPC node, and that
// must never take the agents down with it.
setInterval(() => {
  void (async () => {
    const rows = await Promise.all(
      agents.map(async (a) => {
        const inVault = await a.chain.balanceOf(a.address).then(fmt, () => "?");
        return `${a.persona.name} ${inVault} (earned ${fmt(a.earned)}, spent ${fmt(a.spent)})`;
      }),
    );
    console.log(`\n  ${rows.join("  |  ")}\n`);
  })().catch((e) => console.warn(`  [balances] ${String(e).slice(0, 80)}`));
}, 60_000);

// Keep trading through transient RPC and network errors.
process.on("unhandledRejection", (e) => console.warn(`  [warn] ${String(e).slice(0, 120)}`));
process.on("uncaughtException", (e) => console.warn(`  [warn] ${String(e).slice(0, 120)}`));

const bye = () => {
  for (const a of agents) a.halt();
  console.log("\nstopping. Balances stay in the vault; restart keeps the same addresses.");
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
