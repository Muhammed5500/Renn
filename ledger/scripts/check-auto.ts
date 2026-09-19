// Kontrol 6: otomatik parti modu. Defter AUTO_SETTLE=1 (varsayilan) ile
// calisirken kimse /settle cagirmadan her turda (ROUND_MS) parti gondermeli.
//
//   ROUND_MS=30000 npm start
//   node scripts/check-auto.ts

import { newAgent, track, ledgerState, chain, U } from "./testnet.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const [a, b] = await Promise.all([newAgent("otoA", 10n * U), newAgent("otoB", 0n, { join: false })]);
await track([a.address, b.address], { [a.address]: "otoA", [b.address]: "otoB" });

const b0 = (await ledgerState()).stats.batches;
for (let i = 0; i < 5; i++) await a.agent.pay(b.address, U);
console.log(`5 odeme kabul edildi, uzlasmamis: ${(await ledgerState()).unsettled}. /settle CAGRILMIYOR, bekleniyor...`);

const t = Date.now();
for (;;) {
  await sleep(3000);
  const st = await ledgerState();
  const paid = await chain.paidBetween(a.address, b.address);
  if (st.stats.batches > b0 && paid === 5n * U) {
    console.log(`defter kendi basina uzlastirdi (${Math.round((Date.now() - t) / 1000)} sn): https://stellar.expert/explorer/testnet/tx/${st.stats.lastBatchTx}`);
    console.log("KONTROL 6 GECTI");
    process.exit(0);
  }
  if (Date.now() - t > 75_000) {
    console.error(`HATA: 75 sn icinde parti gitmedi (parti ${st.stats.batches}, uzlasmamis ${st.unsettled})`);
    process.exit(1);
  }
}
