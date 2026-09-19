// Parti tetikleyicileri, testnet'te. Defteri kucuk esiklerle calistir:
//
//   ROUND_MS=600000 MAX_PAIRS=4 MAX_UNSETTLED=80000000 MAX_RECIPIENT_UNSETTLED=50000000 npm start
//   node scripts/check-triggers.ts
//
// (sure 10 dk: bu kontrol sirasinda sure tetikleyicisi karismasin)
//   a) kapasite:     4 farkli ciftte kucuk odemeler -> "capacity"
//   b) alici tutari: tek aliciya 6 (> 5)            -> "recipient"
//   c) toplam tutar: iki aliciya 4.5'er (toplam 9 > 8, alici basina < 5) -> "total"
//   d) esik altinda: parti gitmiyor
import { Keypair } from "@stellar/stellar-sdk";
import { newAgent, track, ledgerState, pay, U } from "./testnet.ts";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("HATA:", m);
    process.exit(1);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = () => Keypair.random().publicKey();

async function expectBatch(before: number, reason: string) {
  for (let i = 0; i < 20; i++) {
    const st = await ledgerState();
    if (st.stats.batches > before && st.unsettled === 0) {
      console.log(`   parti gitti, sebep: ${st.stats.lastBatchReason}  https://stellar.expert/explorer/testnet/tx/${st.stats.lastBatchTx}`);
      must(st.stats.lastBatchReason === reason, `sebep ${reason} olmali`);
      return;
    }
    await sleep(2000);
  }
  must(false, `${reason} partisi 40 sn icinde gitmedi`);
}

const a = await newAgent("tetik", 20n * U);
await track([a.address], { [a.address]: "tetik" });

console.log("a) kapasite: 4 farkli cift, her biri 0.01");
let b0 = (await ledgerState()).stats.batches;
for (let i = 0; i < 4; i++) must((await pay(a, fresh(), U / 100n)).status === "accepted", "odeme");
await expectBatch(b0, "capacity");

console.log("b) alici tutari: tek aliciya 6");
b0 = (await ledgerState()).stats.batches;
must((await pay(a, fresh(), 6n * U)).status === "accepted", "odeme");
await expectBatch(b0, "recipient");

console.log("d) esik altinda: tek aliciya 4.5, parti gitmemeli");
b0 = (await ledgerState()).stats.batches;
must((await pay(a, fresh(), (45n * U) / 10n)).status === "accepted", "odeme");
await sleep(8000);
const mid = await ledgerState();
console.log(`   8 sn sonra parti sayisi ${b0} -> ${mid.stats.batches}, uzlasmamis ${mid.unsettled}`);
must(mid.stats.batches === b0 && mid.unsettled === 1, "esik altinda parti gitmemeli");

console.log("c) toplam tutar: ikinci aliciya 4.5 (toplam 9 > 8)");
must((await pay(a, fresh(), (45n * U) / 10n)).status === "accepted", "odeme");
await expectBatch(b0, "total");

console.log("\nTETIKLEYICI KONTROLU GECTI");
process.exit(0);
