// Batch triggers, on testnet. Run the ledger with small thresholds:
//
//   ROUND_MS=600000 MAX_PAIRS=4 MAX_UNSETTLED=80000000 MAX_RECIPIENT_UNSETTLED=50000000 npm start
//   node demo/check-triggers.ts
//
// (time is 10 min so the time trigger stays out of this check)
//   a) capacity:         small payments on 4 distinct pairs -> "capacity"
//   b) recipient value:  6 to one recipient (> 5)           -> "recipient"
//   c) total value:      4.5 each to two recipients (total 9 > 8, < 5 per recipient) -> "total"
//   d) below threshold:  no batch
import { Keypair } from "@stellar/stellar-sdk";
import { newAgent, track, ledgerState, pay, U } from "./testnet.ts";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("ERROR:", m);
    process.exit(1);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = () => Keypair.random().publicKey();

async function expectBatch(before: number, reason: string) {
  for (let i = 0; i < 20; i++) {
    const st = await ledgerState();
    if (st.stats.batches > before && st.unsettled === 0) {
      console.log(`   batch sent, reason: ${st.stats.lastBatchReason}  https://stellar.expert/explorer/testnet/tx/${st.stats.lastBatchTx}`);
      must(st.stats.lastBatchReason === reason, `reason should be ${reason}`);
      return;
    }
    await sleep(2000);
  }
  must(false, `no ${reason} batch within 40 s`);
}

const a = await newAgent("trigger", 20n * U);
await track([a.address], { [a.address]: "trigger" });

console.log("a) capacity: 4 distinct pairs, 0.01 each");
let b0 = (await ledgerState()).stats.batches;
for (let i = 0; i < 4; i++) must((await pay(a, fresh(), U / 100n)).status === "accepted", "payment");
await expectBatch(b0, "capacity");

console.log("b) recipient value: 6 to one recipient");
b0 = (await ledgerState()).stats.batches;
must((await pay(a, fresh(), 6n * U)).status === "accepted", "payment");
await expectBatch(b0, "recipient");

console.log("d) below threshold: 4.5 to one recipient, no batch expected");
b0 = (await ledgerState()).stats.batches;
must((await pay(a, fresh(), (45n * U) / 10n)).status === "accepted", "payment");
await sleep(8000);
const mid = await ledgerState();
console.log(`   after 8 s batches ${b0} -> ${mid.stats.batches}, unsettled ${mid.unsettled}`);
must(mid.stats.batches === b0 && mid.unsettled === 1, "no batch below the thresholds");

console.log("c) total value: 4.5 to a second recipient (total 9 > 8)");
must((await pay(a, fresh(), (45n * U) / 10n)).status === "accepted", "payment");
await expectBatch(b0, "total");

console.log("\nTRIGGER CHECK PASSED");
process.exit(0);
