// Step D3 acceptance: a restarted ledger produces the same spendable balances.
// With the ledger running: node demo/restart-check.ts before   (payments, no settlement)
// Restart the ledger, then: node demo/restart-check.ts after
import { writeFileSync, readFileSync } from "node:fs";
import { newAgent, track, ledgerState, U, pay } from "./testnet.ts";

const snap = (st: any) =>
  Object.fromEntries(st.participants.map((p: any) => [p.address, { spendable: p.spendable, locked: p.locked }]));

if (process.argv[2] === "before") {
  const [a, b] = await Promise.all([newAgent("A", 10n * U), newAgent("B", 0n)]);
  await track([a.address, b.address]);
  await pay(a, b.address, 3n * U);
  await pay(b, a.address, U);
  const st = await ledgerState();
  writeFileSync("restart-snap.json", JSON.stringify({ unsettled: st.unsettled, seq: st.seq, p: snap(st) }));
  console.log("unsettled:", st.unsettled, "seq:", st.seq);
} else {
  const before = JSON.parse(readFileSync("restart-snap.json", "utf8"));
  const st = await ledgerState();
  const now = { unsettled: st.unsettled, seq: st.seq, p: snap(st) };
  for (const [addr, v] of Object.entries(before.p) as any) {
    const n = now.p[addr];
    const same = n && n.spendable === v.spendable && n.locked === v.locked;
    console.log(same ? "SAME " : "DIFFERENT", addr.slice(0, 8), v, n);
    if (!same) process.exitCode = 1;
  }
  console.log("unsettled:", before.unsettled, "->", now.unsettled, " seq:", before.seq, "->", now.seq);
  if (before.unsettled !== now.unsettled || before.seq !== now.seq) process.exitCode = 1;
}

process.exit(0);
