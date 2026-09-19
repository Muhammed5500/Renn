// Checks 7 + 8: exit notice and escape hatch, on testnet.
//
// 7. When a payer calls exit_start, the ledger settles its pending vouchers
//    on its own (no timer) and stops accepting that payer.
// 8. After exit_delay the payer withdraws its money WITHOUT the operator.
//
// With the ledger running with AUTO_SETTLE=0: node demo/check-exit.ts

import { newAgent, track, ledgerState, chain, dep, fmt, U, pay } from "./testnet.ts";
import { A } from "@golge-defter/sdk/chain";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("ERROR:", m);
    process.exit(1);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = async (a: string) => (await ledgerState()).participants.find((p: any) => p.address === a);

const [p, r] = await Promise.all([newAgent("P", 10n * U), newAgent("R", 0n, { join: false })]);
await track([p.address, r.address], { [p.address]: "exiting", [r.address]: "recipient" });

console.log("\n7) exit notice -> the ledger must settle on its own");
const first = await pay(p, r.address, 3n * U);
must(first.status === "accepted", "payment should be accepted");
const before = await ledgerState();
must(before.unsettled >= 1, "there should be an unsettled voucher");
const batches0 = before.stats.batches;
console.log(`   unsettled: ${before.unsettled}, batches: ${batches0}`);

const ex = await chain.invoke(p.kp, "exit_start", [A.addr(p.address)]);
console.log(`   exit_start: https://stellar.expert/explorer/testnet/tx/${ex.hash} (ledger ${ex.ledger})`);

let settled = false;
for (let i = 0; i < 20; i++) {
  await sleep(2000);
  const st = await ledgerState();
  if (st.stats.batches > batches0 && (await chain.paidBetween(p.address, r.address)) === 3n * U) {
    settled = true;
    console.log(`   settled within ${(i + 1) * 2} s: https://stellar.expert/explorer/testnet/tx/${st.stats.lastBatchTx}`);
    break;
  }
}
must(settled, "the ledger did not settle within 40 s of the exit notice");
const v = await view(p.address);
must(v.exiting, "the ledger should mark the payer as exiting");
const again = await pay(p, r.address, U);
must(again.status === "refused" && (again as any).reason === "exiting", `a new voucher should be refused: ${JSON.stringify(again)}`);
console.log(`   new voucher: REFUSED ${(again as any).reason}`);

console.log(`\n8) escape hatch: waiting ${dep.exit_delay} ledgers, then withdrawal without the operator`);
const early = await chain.invoke(p.kp, "withdraw", [A.addr(p.address)]).then(() => "passed", (e) => "refused");
must(early === "refused", "a withdrawal before the delay should be refused");
console.log("   early withdrawal: refused (correct)");
for (;;) {
  const now = await chain.latestLedger();
  const left = ex.ledger + dep.exit_delay - now;
  if (left <= 0) break;
  process.stdout.write(`   ~${left} ledgers left (~${left * 5} s)   \r`);
  await sleep(Math.min(left * 5000, 20000));
}
const w = await chain.invoke(p.kp, "withdraw", [A.addr(p.address)]);
console.log(`\n   withdrawal without the operator: https://stellar.expert/explorer/testnet/tx/${w.hash}`);
const wallet = await chain.tokenBalance(p.address);
must(wallet === 7n * U, `wallet should hold 7, holds ${fmt(wallet)}`);
console.log(`   wallet: ${fmt(wallet)} (10 - 3), in the vault: ${fmt(await chain.balanceOf(p.address))}`);
console.log("\nCHECKS 7 + 8 PASSED");
process.exit(0);
