// The two withdrawal-approval paths, on testnet. With the ledger on AUTO_SETTLE=1 (default):
//   ROUND_MS=30000 npm start
//   node demo/check-withdraw.ts
//
// 1. Own money: 20 in the vault, 5 promised, 15 withdrawn -> INSTANT, no batch.
// 2. Money not yet in: vault 0, 10 coming from C, 10 withdrawn -> waits for the
//    regular batch, no EXTRA batch is sent for the withdrawal.
import { newAgent, track, ledgerState, withdrawApproved, chain, fmt, U, pay, hubCfg, LEDGER } from "./testnet.ts";
import * as P from "rennpay/payload";
import { networkInterfaces } from "node:os";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("ERROR:", m);
    process.exit(1);
  }
};
const [a, m, b, c, d] = await Promise.all([
  newAgent("A", 20n * U),
  newAgent("M", 0n, { join: false }),
  newAgent("B", 0n),
  newAgent("C", 10n * U),
  newAgent("D", 5n * U),
]);
await track([a, m, b, c, d].map((x) => x.address), { [a.address]: "A", [m.address]: "M", [b.address]: "B", [c.address]: "C" });

console.log("\n1) own money");
must((await pay(a, m.address, 5n * U)).status === "accepted", "A->M 5");
let b0 = (await ledgerState()).stats.batches;
let t = Date.now();
const w1 = await withdrawApproved(a, 15n * U);
must(w1.status === "approved", JSON.stringify(w1));
const b1 = (await ledgerState()).stats.batches;
console.log(`   path: ${w1.path}, batches ${b0} -> ${b1}, ${Math.round((Date.now() - t) / 1000)} s`);
console.log(`   withdrawal: https://stellar.expert/explorer/testnet/tx/${w1.hash}`);
must(w1.path === "direct", "should be instant");
console.log(`   A wallet ${fmt(await chain.tokenBalance(a.address))}, in the vault ${fmt(await chain.balanceOf(a.address))} (for M's 5)`);

console.log("\n2) money not yet in");
must((await pay(c, b.address, 10n * U)).status === "accepted", "C->B 10");
const st = await ledgerState();
const bv = st.participants.find((p: any) => p.address === b.address);
console.log(`   B spendable ${fmt(bv.spendable)}, on chain ${fmt(bv.locked)}`);
b0 = st.stats.batches;
t = Date.now();
const w2 = await withdrawApproved(b, 10n * U);
must(w2.status === "approved", JSON.stringify(w2));
const after = await ledgerState();
console.log(`   path: ${w2.path}, batches ${b0} -> ${after.stats.batches}, ${Math.round((Date.now() - t) / 1000)} s`);
console.log(`   withdrawal: https://stellar.expert/explorer/testnet/tx/${w2.hash}`);
must(w2.path === "after_batch", "should wait for a batch");
// Every batch during the wait must be one of the timer's regular batches:
// more than the timer could send in the elapsed time = the withdrawal triggered an extra batch.
const elapsed = Date.now() - t;
const maxRegular = Math.floor(elapsed / 30_000) + 1;
must(after.stats.batches - b0 <= maxRegular, `extra batch: ${after.stats.batches - b0} > ${maxRegular}`);
console.log(`   ${after.stats.batches - b0} batch(es), all regular (at most ${maxRegular} in that time)`);
console.log(`   B wallet ${fmt(await chain.tokenBalance(b.address))}`);

console.log("\n3) is M's 5 still payable (what is left in A's vault balance)");
for (let i = 0; i < 25 && (await chain.paidBetween(a.address, m.address)) === 0n; i++) await new Promise((r) => setTimeout(r, 2000));
must((await chain.paidBetween(a.address, m.address)) === 5n * U, "A->M should settle");
console.log(`   A->M 5 settled, M on chain ${fmt(await chain.balanceOf(m.address))}, nothing skipped`);
console.log("\n4) withdrawal request security and operator endpoints");
{
  const nonce = await chain.withdrawNonceOf(d.address);
  // request signed with someone else's key
  const forged = P.signHex(P.keyFromSeed("22".repeat(32)), P.withdrawRequestHash(hubCfg, d.address, U, nonce));
  const r1 = await fetch(`${LEDGER}/withdraw`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ who: d.address, amount: U.toString(), nonce: nonce.toString(), sig: forged }) }).then((r) => r.json());
  console.log(`   someone else's signature: ${r1.status} ${r1.reason}`);
  must(r1.status === "refused" && r1.reason === "bad_signature", "a forged request should be refused");
  // valid request, then the same request again
  const good = P.signHex(d.agent.key, P.withdrawRequestHash(hubCfg, d.address, U, nonce));
  const body = JSON.stringify({ who: d.address, amount: U.toString(), nonce: nonce.toString(), sig: good });
  const r2 = await fetch(`${LEDGER}/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.json());
  const r3 = await fetch(`${LEDGER}/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.json());
  console.log(`   valid request: ${r2.status}, same request again: ${r3.status} ${r3.reason}`);
  must(r2.status === "approved" && r3.status === "refused" && r3.reason === "duplicate_request", "a repeat should be refused");
  // operator endpoints: from the machine's own network address (as if from outside)
  const ip = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (ip) {
    const port = new URL(LEDGER).port;
    const st = await fetch(`http://${ip}:${port}/state`).then((r) => r.status).catch(() => "no connection");
    const sup = await fetch(`http://${ip}:${port}/supported`).then((r) => r.status).catch(() => "no connection");
    console.log(`   ${ip}: /state -> ${st}, /supported -> ${sup}`);
    must(st === 403 && sup === 200, "operator endpoints closed to the outside, facilitator open");
  } else console.log("   no local network address, outside-access test skipped");
}

console.log("\nWITHDRAWAL CHECK PASSED");
process.exit(0);
