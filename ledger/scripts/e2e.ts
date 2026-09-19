// ADIM D4 kabul kriteri: testnet'te 3 ajan, dairesel odemeler, tek parti,
// skipped bos, kasanin token bakiyesi degismedi. Arkasindan onayli cekim.
//
// Once defteri calistir:  AUTO_SETTLE=0 npm start
// Sonra:                  node scripts/e2e.ts

import { newAgent, track, settleNow, ledgerState, withdrawApproved, chain, dep, fmt, U } from "./testnet.ts";

const say = (s: string) => console.log(`\n=== ${s} ===`);
const str = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const must = (c: boolean, msg: string) => {
  if (!c) {
    console.error("HATA:", msg);
    process.exit(1);
  }
};

say("1. Uc ajan: A'nin kasasinda 20, B ve C'nin hic yok");
const [a, b, c] = await Promise.all([newAgent("A", 20n * U), newAgent("B", 0n), newAgent("C", 0n)]);
await track([a.address, b.address, c.address]);
for (const x of [a, b, c]) console.log(x.name, x.address);

say("2. Donusumlu odemeler: A->B 1, B->C 0.9, C->A 0.8, 20 tur (ZINCIRE GITMEZ)");
const hubBefore = await chain.tokenBalance(dep.hub);
let ok = 0;
for (let i = 0; i < 20; i++) {
  for (const [p, q, amt] of [[a, b, U], [b, c, (9n * U) / 10n], [c, a, (8n * U) / 10n]] as const) {
    const r = await p.agent.pay(q.address, amt);
    must(r.status === "accepted", `tur ${i} ${p.name}->${q.name}: ${str(r)}`);
    ok++;
  }
}
console.log(`${ok} odeme kabul edildi, zincir islemi: 0`);

say("3. Karsiliksiz cek: B'nin harcanabiliri yetmiyor");
const st = await ledgerState();
const bView = st.participants.find((p: any) => p.address === b.address);
console.log(`B harcanabilir: ${fmt(bView.spendable)}`);
const refused = await b.agent.pay(c.address, BigInt(bView.spendable) + 1n);
must(refused.status === "refused", "karsiliksiz fis kabul edildi");
console.log(`ret sebebi: ${(refused as any).reason}`);

say("4. Tek parti");
await settleNow();
const after = await ledgerState();
must(after.unsettled === 0, "uzlasmamis kalmamali");
const hubAfter = await chain.tokenBalance(dep.hub);
console.log(`parti tx: https://stellar.expert/explorer/testnet/tx/${after.stats.lastBatchTx}`);
console.log(`kasa token bakiyesi: ${fmt(hubBefore)} -> ${fmt(hubAfter)}`);
must(hubBefore === hubAfter, "token hareket etti");
for (const x of [a, b, c]) console.log(`${x.name} zincirde: ${fmt(await chain.balanceOf(x.address))}`);
must((await chain.balanceOf(a.address)) === 20n * U - 20n * U + 16n * U, "A = 20 - 20 + 16");
must((await chain.balanceOf(b.address)) === 2n * U, "B = 20 - 18");
must((await chain.balanceOf(c.address)) === 2n * U, "C = 18 - 16");

say("5. A, 10 birim cekiyor: defter onayi, ANINDA");
const w = await withdrawApproved(a, 10n * U);
must(w.status === "approved", str(w));
console.log(`cekim tx: https://stellar.expert/explorer/testnet/tx/${w.hash}`);
console.log(`A cuzdanda: ${fmt(await chain.tokenBalance(a.address))}   A kasada: ${fmt(await chain.balanceOf(a.address))}`);

say("BITTI");
