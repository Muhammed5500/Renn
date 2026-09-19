// ADIM T - Gosteri senaryosu (plan par.5, ADIM T). Her sahne ~30 sn.
//
// Defter calisirken:   AUTO_SETTLE=0 npm start
// Sonra:               node scripts/demo.ts            (butun sahneler)
//                      node scripts/demo.ts 1 3        (sadece 1 ve 3)
// Sahne 6 (gizli giris) SPP ister: SPP_BIN, SPP_CIRCUITS ve .env'de RELAYER_SECRET.
// Yoksa atlanir. ~3 dk surer (uc Groth16 yatirma + cekim).
//
// Her sayi calisan sistemden geliyor: defterin /state'i ve zincir okumalari.

import { Keypair } from "@stellar/stellar-sdk";
import { newAgent, track, settleNow, ledgerState, withdrawApproved, chain, dep, fmt, LEDGER, U, pay } from "./testnet.ts";
import { A, voucherScVal } from "../src/chain.ts";
import { privateEntry, addressesIn } from "./spp.ts";

const only = process.argv.slice(2).map(Number);
const want = (n: number) => only.length === 0 || only.includes(n);
const line = "=".repeat(64);
const scene = (n: number, title: string, quote?: string) => {
  console.log(`\n${line}\n SAHNE ${n}  ${title}\n${line}`);
  if (quote) console.log(`  "${quote}"\n`);
};
const tx = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const view = async (addr: string) => (await ledgerState()).participants.find((p: any) => p.address === addr);

console.log("Sahne oncesi: ajanlar kuruluyor (friendbot, kayit, yatirma)...");
const t0 = Date.now();
const [a, b, c, ahmet, e, deniz, ...payers] = await Promise.all([
  newAgent("A", 20n * U),
  newAgent("B", 0n),
  newAgent("C", 0n),
  newAgent("Ahmet", 10n * U),
  newAgent("E", 0n),
  newAgent("Deniz", 50n * U),
  ...[1, 2, 3, 4, 5].map((i) => newAgent(`P${i}`, 10n * U)),
]);
const services = Array.from({ length: 25 }, () => Keypair.random().publicKey()); // saf alicilar
const everyone = [a, b, c, ahmet, e, deniz, ...payers];
await track(
  everyone.map((x) => x.address),
  Object.fromEntries([
    ...everyone.map((x) => [x.address, x.name]),
    ...services.map((s, i) => [s, `servis-${i + 1}`]),
  ]),
);
console.log(`hazir (${Math.round((Date.now() - t0) / 1000)} sn). Defter: ${LEDGER}`);

// ================= SAHNE 0 =================
if (want(0)) {
  scene(0, "KASALAR", "Bu ajanlarin hicbiri sahip olmadigi parayi harcayamiyor.");
  for (const x of [a, b, c, ahmet, e]) {
    const v = await view(x.address);
    console.log(`  ${x.name.padEnd(12)} kasada ${fmt(v.locked).padStart(6)}   harcanabilir ${fmt(v.spendable).padStart(6)}`);
  }
}

// ================= SAHNE 1 =================
if (want(1)) {
  scene(1, "DAIRESEL BORC", "A'nin kasasinda 20 var. 270 birim borc tek islemde kapaniyor.");
  const hubBefore = await chain.tokenBalance(dep.hub);
  const batchesBefore = (await ledgerState()).stats.batches;
  let minA = 20n * U;
  for (let i = 0; i < 100; i++) {
    await pay(a, b.address, U);
    if (i < 90) await pay(b, c.address, U);
    if (i < 80) await pay(c, a.address, U);
    if (i % 10 === 9) {
      const va = await view(a.address);
      if (BigInt(va.spendable) < minA) minA = BigInt(va.spendable);
      process.stdout.write(`  tur ${String(i + 1).padStart(3)}  A harcanabilir ${fmt(va.spendable).padStart(6)}   zincir islemi: 0\r`);
    }
  }
  console.log(`\n  A->B 100, B->C 90, C->A 80 = 270 odeme. A'nin en dusuk harcanabiliri: ${fmt(minA)}`);
  await settleNow();
  const st = await ledgerState();
  console.log(`  TEK PARTI: ${tx(st.stats.lastBatchTx)}`);
  console.log(`  zincir islemi: ${st.stats.batches - batchesBefore}`);
  console.log(`  kasanin token bakiyesi: ${fmt(hubBefore)} -> ${fmt(await chain.tokenBalance(dep.hub))}   (degismedi)`);
  for (const x of [a, b, c]) console.log(`  ${x.name}: zincirde ${fmt(await chain.balanceOf(x.address))}`);
}

// ================= SAHNE 2 =================
if (want(2)) {
  scene(2, "OLCEK", "5 odeyen, 25 servis, 600 odeme, tek parti.");
  const batchesBefore = (await ledgerState()).stats.batches;
  const hubBefore = await chain.tokenBalance(dep.hub);
  const t = Date.now();
  let n = 0;
  for (let i = 0; i < 600; i++) {
    const p = payers[i % 5];
    const s = services[(i * 7) % 25];
    const r = await pay(p, s, U / 20n); // 0.05
    if (r.status === "accepted") n++;
  }
  const secs = (Date.now() - t) / 1000;
  console.log(`  ${n} odeme, ${secs.toFixed(1)} sn (${Math.round(n / secs)} odeme/sn), zincir islemi: 0`);
  await settleNow();
  const st = await ledgerState();
  console.log(`  zincir islemi: ${st.stats.batches - batchesBefore}   ${tx(st.stats.lastBatchTx)}`);
  console.log(`  kasanin token bakiyesi: ${fmt(hubBefore)} -> ${fmt(await chain.tokenBalance(dep.hub))}`);
}

// ================= SAHNE 3 =================
if (want(3)) {
  scene(3, "KARSILIKSIZ CEK", "Kasandaki paradan fazlasini harcayamazsin, fis zincire hic gitmese bile.");
  const r1 = await pay(e, ahmet.address, 3n * U);
  console.log(`  E (kasasi bos) -> Ahmet 3:        ${r1.status === "refused" ? "RET  " + r1.reason : "kabul"}`);
  const s1 = services[0];
  const s2 = services[1];
  const r2 = await pay(ahmet, s1, 10n * U);
  console.log(`  Ahmet (10) -> servis-1 10:        ${r2.status === "accepted" ? "kabul" : "RET " + (r2 as any).reason}`);
  const r3 = await pay(ahmet, s2, 10n * U);
  console.log(`  Ahmet ayni 10'u servis-2'ye:      ${r3.status === "refused" ? "RET  " + r3.reason : "kabul"}`);
}

// ================= SAHNE 4 =================
if (want(4)) {
  scene(4, "CEKIM", "Kilitli ama hapis degil.");
  const r = await pay(deniz, services[2], 3n * U);
  console.log(`  Deniz (50) bir servise 3 oduyor: ${r.status === "accepted" ? "kabul, henuz uzlasmadi" : "RET " + (r as any).reason}`);
  const before = await chain.tokenBalance(deniz.address);
  const t = Date.now();
  const w = await withdrawApproved(deniz, 20n * U);
  console.log(`  Deniz 20 cekiyor: ${w.path === "direct" ? "kasasindaki 50'nin 3'u soz verildi, 20 serbest -> ANINDA onay, parti yok" : "onay parti sonrasi"}`);
  console.log(`  cekim: ${tx(w.hash)}`);
  console.log(`  cuzdan: ${fmt(before)} -> ${fmt(await chain.tokenBalance(deniz.address))}   (${Math.round((Date.now() - t) / 1000)} sn, exit_start yok)`);
  const dv = await view(deniz.address);
  console.log(`  kasada ${fmt(await chain.balanceOf(deniz.address))}: harcanabilir ${fmt(dv.spendable)} + servise soz verilen ${fmt(dv.pendingOut)} (olagan partide odenecek)`);
}

// ================= SAHNE 5 (opsiyonel) =================
if (want(5)) {
  scene(5, "OPERATOR COKERSE", "Operator cokse de para sizin.");
  // Kabul edilmis ama uzlasmamis bir fis: alici elindeki iki imzali fisi
  // defteri hic kullanmadan kendisi uzlastiriyor.
  // harcanabiliri olan ilk ajan oder (onceki sahneler bakiyeleri degistirdi)
  let payer = a;
  for (const x of [a, b, c, deniz, ...payers]) {
    if (BigInt((await view(x.address)).spendable) >= U) {
      payer = x;
      break;
    }
  }
  const to = payer === e ? a : e;
  const r = await pay(payer, to.address, U / 2n);
  if (r.status !== "accepted") throw new Error(`sahne 5 hazirlik: ${(r as any).reason}`);
  const pair = await (await fetch(`${LEDGER}/pair/${payer.address}/${to.address}`)).json();
  const v = { payer: payer.address, recipient: to.address, cumulative: BigInt(pair.accepted), sig: pair.sig, opSig: pair.op_sig };
  const res = await chain.invoke(to.kp, "settle_one", [A.addr(to.address), voucherScVal(v)]);
  console.log(`  ${to.name} kendi fisini defteri kullanmadan uzlastirdi: ${tx(res.hash)}`);
  const ex = await chain.invoke(payer.kp, "exit_start", [A.addr(payer.address)]);
  console.log(`  ${payer.name} kacis yolunu baslatti (exit_start): ${tx(ex.hash)}`);
  console.log(`  ${dep.exit_delay} ledger (~5 dk) sonra operatorsuz cekebilir.`);
}

// ================= SAHNE 6 (SPP varsa) =================
if (want(6)) {
  scene(6, "GIZLI GIRIS", "Kasaya kim girdi, zincirden bilinmiyor.");
  if (!process.env.SPP_CIRCUITS) {
    console.log("  SPP_CIRCUITS ayarli degil, atlandi.");
  } else {
    const pe = await privateEntry(10n, 3, (s) => console.log(s));
    await track([pe.f.address], { [pe.f.address]: "F (gizli)" });
    const r = await pay(pe.f, services[3], U);
    console.log(`  F x402 ile servis-4'e 1 odedi: ${r.status === "accepted" ? "kabul" : "RET " + (r as any).reason}`);
    let traces = 0;
    for (const h of Object.values(pe.txs)) traces += (await addressesIn(h, pe.ws)).length;
    const acct = (await fetch(`https://horizon-testnet.stellar.org/accounts/${pe.f.address}`).then((x) => x.json())) as any;
    const xlm = acct.balances.find((b: any) => b.asset_type === "native").balance;
    console.log(`  F'nin ${Object.keys(pe.txs).length} isleminde W adresi: ${traces === 0 ? "YOK" : traces}   F'nin XLM'i: ${xlm}`);
    console.log("  zincirde gorunen: uc cuzdan 10'ar yatirdi, F 10 aldi. F hangisi? Bilinmiyor.");
    console.log("  acik kalan: tutar ve zaman. Ayni tutari yatiran kalabalik buyudukce gizlilik artar.");
  }
}

console.log(`\n${line}\n kasa: https://stellar.expert/explorer/testnet/contract/${dep.hub}\n${line}`);
process.exit(0);
