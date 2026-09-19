// Check 6: automatic batch mode. With the ledger running with AUTO_SETTLE=1
// (the default), it must send a batch every round (ROUND_MS) without anyone
// calling /settle.
//
//   ROUND_MS=30000 npm start
//   node demo/check-auto.ts

import { newAgent, track, ledgerState, chain, U, pay } from "./testnet.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const [a, b] = await Promise.all([newAgent("autoA", 10n * U), newAgent("autoB", 0n, { join: false })]);
await track([a.address, b.address], { [a.address]: "autoA", [b.address]: "autoB" });

const b0 = (await ledgerState()).stats.batches;
for (let i = 0; i < 5; i++) await pay(a, b.address, U);
console.log(`5 payments accepted, unsettled: ${(await ledgerState()).unsettled}. NOT calling /settle, waiting...`);

const t = Date.now();
for (;;) {
  await sleep(3000);
  const st = await ledgerState();
  const paid = await chain.paidBetween(a.address, b.address);
  if (st.stats.batches > b0 && paid === 5n * U) {
    console.log(`the ledger settled on its own (${Math.round((Date.now() - t) / 1000)} s): https://stellar.expert/explorer/testnet/tx/${st.stats.lastBatchTx}`);
    console.log("CHECK 6 PASSED");
    process.exit(0);
  }
  if (Date.now() - t > 75_000) {
    console.error(`ERROR: no batch within 75 s (batches ${st.stats.batches}, unsettled ${st.unsettled})`);
    process.exit(1);
  }
}
