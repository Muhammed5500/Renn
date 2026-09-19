// Kontrol 7 + 8: cikis ilani ve kacis yolu, testnet'te.
//
// 7. Odeyen exit_start cagirinca defter (zamanlayici olmadan) bekleyen
//    fislerini kendiliginden uzlastiriyor ve o odeyeni artik kabul etmiyor.
// 8. exit_delay dolunca odeyen parasini OPERATORSUZ cekiyor.
//
// Defter AUTO_SETTLE=0 ile calisirken: node scripts/check-exit.ts

import { newAgent, track, ledgerState, chain, dep, fmt, U } from "./testnet.ts";
import { A } from "../src/chain.ts";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("HATA:", m);
    process.exit(1);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = async (a: string) => (await ledgerState()).participants.find((p: any) => p.address === a);

const [p, r] = await Promise.all([newAgent("P", 10n * U), newAgent("R", 0n, { join: false })]);
await track([p.address, r.address], { [p.address]: "cikan", [r.address]: "alici" });

console.log("\n7) cikis ilani -> defter kendiliginden uzlastirmali");
const pay = await p.agent.pay(r.address, 3n * U);
must(pay.status === "accepted", "odeme kabul edilmeli");
const before = await ledgerState();
must(before.unsettled >= 1, "uzlasmamis fis olmali");
const batches0 = before.stats.batches;
console.log(`   uzlasmamis: ${before.unsettled}, parti sayisi: ${batches0}`);

const ex = await chain.invoke(p.kp, "exit_start", [A.addr(p.address)]);
console.log(`   exit_start: https://stellar.expert/explorer/testnet/tx/${ex.hash} (ledger ${ex.ledger})`);

let settled = false;
for (let i = 0; i < 20; i++) {
  await sleep(2000);
  const st = await ledgerState();
  if (st.stats.batches > batches0 && (await chain.paidBetween(p.address, r.address)) === 3n * U) {
    settled = true;
    console.log(`   ${(i + 1) * 2} sn icinde uzlasti: https://stellar.expert/explorer/testnet/tx/${st.stats.lastBatchTx}`);
    break;
  }
}
must(settled, "defter cikis ilanindan sonra 40 sn icinde uzlastirmadi");
const v = await view(p.address);
must(v.exiting, "defter odeyeni cikista isaretlemeli");
const again = await p.agent.pay(r.address, U);
must(again.status === "refused" && (again as any).reason === "exiting", `yeni fis reddedilmeli: ${JSON.stringify(again)}`);
console.log(`   yeni fis: RET ${(again as any).reason}`);

console.log(`\n8) kacis yolu: ${dep.exit_delay} ledger bekleniyor, sonra operatorsuz cekim`);
const early = await chain.invoke(p.kp, "withdraw", [A.addr(p.address)]).then(() => "gecti", (e) => "reddedildi");
must(early === "reddedildi", "sure dolmadan cekim reddedilmeli");
console.log("   erken cekim: reddedildi (dogru)");
for (;;) {
  const now = await chain.latestLedger();
  const left = ex.ledger + dep.exit_delay - now;
  if (left <= 0) break;
  process.stdout.write(`   kalan ~${left} ledger (~${left * 5} sn)   \r`);
  await sleep(Math.min(left * 5000, 20000));
}
const w = await chain.invoke(p.kp, "withdraw", [A.addr(p.address)]);
console.log(`\n   operatorsuz cekim: https://stellar.expert/explorer/testnet/tx/${w.hash}`);
const wallet = await chain.tokenBalance(p.address);
must(wallet === 7n * U, `cuzdanda 7 olmali, ${fmt(wallet)} var`);
console.log(`   cuzdan: ${fmt(wallet)} (10 - 3), kasada: ${fmt(await chain.balanceOf(p.address))}`);
console.log("\nKONTROL 7 + 8 GECTI");
process.exit(0);
