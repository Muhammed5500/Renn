// Cekim onayinin iki yolu, testnet'te. Defter AUTO_SETTLE=1 (varsayilan) ile:
//   ROUND_MS=30000 npm start
//   node scripts/check-withdraw.ts
//
// 1. Kendi parasi: 20 kasada, 5 soz verildi, 15 cekiliyor -> ANINDA, parti yok.
// 2. Gelmemis para: kasa 0, C'den 10 gelecek, 10 cekiliyor -> olagan partiyi
//    bekliyor, cekim icin EK parti gonderilmiyor.
import { newAgent, track, ledgerState, withdrawApproved, chain, fmt, U, pay, hubCfg, LEDGER } from "./testnet.ts";
import * as P from "../src/payload.ts";
import { networkInterfaces } from "node:os";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("HATA:", m);
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

console.log("\n1) kendi parasi");
must((await pay(a, m.address, 5n * U)).status === "accepted", "A->M 5");
let b0 = (await ledgerState()).stats.batches;
let t = Date.now();
const w1 = await withdrawApproved(a, 15n * U);
must(w1.status === "approved", JSON.stringify(w1));
const b1 = (await ledgerState()).stats.batches;
console.log(`   yol: ${w1.path}, parti sayisi ${b0} -> ${b1}, ${Math.round((Date.now() - t) / 1000)} sn`);
console.log(`   cekim: https://stellar.expert/explorer/testnet/tx/${w1.hash}`);
must(w1.path === "direct", "anında olmali");
console.log(`   A cuzdan ${fmt(await chain.tokenBalance(a.address))}, kasada ${fmt(await chain.balanceOf(a.address))} (M'nin 5'i icin)`);

console.log("\n2) gelmemis para");
must((await pay(c, b.address, 10n * U)).status === "accepted", "C->B 10");
const st = await ledgerState();
const bv = st.participants.find((p: any) => p.address === b.address);
console.log(`   B harcanabilir ${fmt(bv.spendable)}, zincirde ${fmt(bv.locked)}`);
b0 = st.stats.batches;
t = Date.now();
const w2 = await withdrawApproved(b, 10n * U);
must(w2.status === "approved", JSON.stringify(w2));
const after = await ledgerState();
console.log(`   yol: ${w2.path}, parti sayisi ${b0} -> ${after.stats.batches}, ${Math.round((Date.now() - t) / 1000)} sn`);
console.log(`   cekim: https://stellar.expert/explorer/testnet/tx/${w2.hash}`);
must(w2.path === "after_batch", "parti sonrasi olmali");
// Bekleme sirasindaki partilerin hepsi zamanlayicinin olagan partileri olmali:
// gecen surede zamanlayicinin gonderebileceginden fazlasi = cekim ek parti tetikledi.
const elapsed = Date.now() - t;
const maxRegular = Math.floor(elapsed / 30_000) + 1;
must(after.stats.batches - b0 <= maxRegular, `ek parti var: ${after.stats.batches - b0} > ${maxRegular}`);
console.log(`   ${after.stats.batches - b0} parti, hepsi olagan (sure icinde en fazla ${maxRegular})`);
console.log(`   B cuzdan ${fmt(await chain.tokenBalance(b.address))}`);

console.log("\n3) M'nin 5'i hala odenebiliyor mu (A'nin kasasinda kalan)");
for (let i = 0; i < 25 && (await chain.paidBetween(a.address, m.address)) === 0n; i++) await new Promise((r) => setTimeout(r, 2000));
must((await chain.paidBetween(a.address, m.address)) === 5n * U, "A->M uzlasmali");
console.log(`   A->M 5 uzlasti, M zincirde ${fmt(await chain.balanceOf(m.address))}, skipped yok`);
console.log("\n4) cekim istegi guvenligi ve operator uclari");
{
  const nonce = await chain.withdrawNonceOf(d.address);
  // baskasinin anahtariyla imzalanmis istek
  const forged = P.signHex(P.keyFromSeed("22".repeat(32)), P.withdrawRequestHash(hubCfg, d.address, U, nonce));
  const r1 = await fetch(`${LEDGER}/withdraw`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ who: d.address, amount: U.toString(), nonce: nonce.toString(), sig: forged }) }).then((r) => r.json());
  console.log(`   baskasinin imzasi: ${r1.status} ${r1.reason}`);
  must(r1.status === "refused" && r1.reason === "bad_signature", "sahte istek reddedilmeli");
  // gecerli istek, sonra ayni istek tekrar
  const good = P.signHex(d.agent.key, P.withdrawRequestHash(hubCfg, d.address, U, nonce));
  const body = JSON.stringify({ who: d.address, amount: U.toString(), nonce: nonce.toString(), sig: good });
  const r2 = await fetch(`${LEDGER}/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.json());
  const r3 = await fetch(`${LEDGER}/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.json());
  console.log(`   gecerli istek: ${r2.status}, ayni istek tekrar: ${r3.status} ${r3.reason}`);
  must(r2.status === "approved" && r3.status === "refused" && r3.reason === "duplicate_request", "tekrar reddedilmeli");
  // operator uclari: makinenin kendi ag adresinden (disaridan gibi)
  const ip = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (ip) {
    const port = new URL(LEDGER).port;
    const st = await fetch(`http://${ip}:${port}/state`).then((r) => r.status).catch(() => "baglanti yok");
    const sup = await fetch(`http://${ip}:${port}/supported`).then((r) => r.status).catch(() => "baglanti yok");
    console.log(`   ${ip}: /state -> ${st}, /supported -> ${sup}`);
    must(st === 403 && sup === 200, "operator ucu disariya kapali, facilitator acik olmali");
  } else console.log("   yerel ag adresi yok, dis erisim denemesi atlandi");
}

console.log("\nCEKIM KONTROLU GECTI");
process.exit(0);
