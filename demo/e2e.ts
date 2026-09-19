// Step D4 acceptance: 3 agents on testnet, circular payments, one batch,
// nothing skipped, vault token balance unchanged. Then an approved withdrawal.
//
// First run the ledger:  AUTO_SETTLE=0 npm start
// Then:                  node demo/e2e.ts

import { newAgent, track, settleNow, ledgerState, withdrawApproved, chain, dep, fmt, U, pay } from "./testnet.ts";

const say = (s: string) => console.log(`\n=== ${s} ===`);
const str = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const must = (c: boolean, msg: string) => {
  if (!c) {
    console.error("ERROR:", msg);
    process.exit(1);
  }
};

say("1. Three agents: A has 20 in the vault, B and C have nothing");
const [a, b, c] = await Promise.all([newAgent("A", 20n * U), newAgent("B", 0n), newAgent("C", 0n)]);
await track([a.address, b.address, c.address]);
for (const x of [a, b, c]) console.log(x.name, x.address);

say("2. Alternating payments: A->B 1, B->C 0.9, C->A 0.8, 20 rounds (NOTHING ON CHAIN)");
const hubBefore = await chain.tokenBalance(dep.hub);
let ok = 0;
for (let i = 0; i < 20; i++) {
  for (const [p, q, amt] of [[a, b, U], [b, c, (9n * U) / 10n], [c, a, (8n * U) / 10n]] as const) {
    const r = await pay(p, q.address, amt);
    must(r.status === "accepted", `round ${i} ${p.name}->${q.name}: ${str(r)}`);
    ok++;
  }
}
console.log(`${ok} payments accepted, on-chain transactions: 0`);

say("3. Bounced cheque: B's spendable balance is not enough");
const st = await ledgerState();
const bView = st.participants.find((p: any) => p.address === b.address);
console.log(`B spendable: ${fmt(bView.spendable)}`);
const refused = await pay(b, c.address, BigInt(bView.spendable) + 1n);
must(refused.status === "refused", "an unbacked voucher was accepted");
console.log(`refusal reason: ${(refused as any).reason}`);

say("4. One batch");
await settleNow();
const after = await ledgerState();
must(after.unsettled === 0, "nothing should stay unsettled");
const hubAfter = await chain.tokenBalance(dep.hub);
console.log(`batch tx: https://stellar.expert/explorer/testnet/tx/${after.stats.lastBatchTx}`);
console.log(`vault token balance: ${fmt(hubBefore)} -> ${fmt(hubAfter)}`);
must(hubBefore === hubAfter, "tokens moved");
for (const x of [a, b, c]) console.log(`${x.name} on chain: ${fmt(await chain.balanceOf(x.address))}`);
must((await chain.balanceOf(a.address)) === 20n * U - 20n * U + 16n * U, "A = 20 - 20 + 16");
must((await chain.balanceOf(b.address)) === 2n * U, "B = 20 - 18");
must((await chain.balanceOf(c.address)) === 2n * U, "C = 18 - 16");

say("5. A withdraws 10: ledger approval, INSTANT");
const w = await withdrawApproved(a, 10n * U);
must(w.status === "approved", str(w));
console.log(`withdrawal tx: https://stellar.expert/explorer/testnet/tx/${w.hash}`);
console.log(`A in wallet: ${fmt(await chain.tokenBalance(a.address))}   A in vault: ${fmt(await chain.balanceOf(a.address))}`);

say("DONE");

process.exit(0);
