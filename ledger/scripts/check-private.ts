// Gizli giris (SPP), testnet'te. Defter RELAYER_SECRET ile calisirken:
//   node scripts/check-private.ts        (SPP CLI ve devreler spp/ altinda, bkz. spp.ts)
//
// Zincirde bilinen uc cuzdan (W1, W2, W3) SPP havuzuna 10'ar yatirir. Biri
// havuzdan taze bir F'ye 10 ceker. F relayer sayesinde 0 XLM ile hesap acar,
// kasaya katilir, yatirir ve x402 ile oder.
//
// Kontroller:
//   1. F'nin ve cekimin HICBIR isleminde W1/W2/W3 adresi gecmiyor (bayt taramasi)
//   2. F'nin XLM'i 0; hesap rezervi relayer'in sponsorlugunda
//   3. F kasada normal ajan: x402 odemesi kabul
//   4. Relayer sadece kendi dar islem sekillerini imzaliyor
import { Asset, TransactionBuilder, Contract, xdr, nativeToScVal, Operation, type Account } from "@stellar/stellar-sdk";
import { chain, dep, fmt, U, newAgent, pay, track, LEDGER } from "./testnet.ts";
import { A } from "../src/chain.ts";
import { privateEntry, addressesIn } from "./spp.ts";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("HATA:", m);
    process.exit(1);
  }
};
const relay = (await fetch(`${LEDGER}/relay/info`).then((r) => r.json())) as { address: string };
must(!!relay.address, "defterde relayer kapali (RELAYER_SECRET)");

console.log("1) gizli giris: W1, W2, W3 -> SPP havuzu -> F -> kasa");
const t0 = Date.now();
const pe = await privateEntry(10n, 3);
const f = pe.f;
console.log(`   ${Math.round((Date.now() - t0) / 1000)} sn`);

console.log("2) F'nin hesabi");
const acct = (await fetch(`https://horizon-testnet.stellar.org/accounts/${f.address}`).then((r) => r.json())) as any;
const xlm = acct.balances.find((b: any) => b.asset_type === "native").balance;
console.log(`   XLM ${xlm}, hesap sponsoru ${acct.sponsor?.slice(0, 8)}…, kasada ${fmt(await chain.balanceOf(f.address))}`);
must(Number(xlm) === 0 && acct.sponsor === relay.address, "F 0 XLM, sponsor relayer");
must((await chain.balanceOf(f.address)) === 10n * U, "F kasada 10");

console.log("3) F'nin islemlerinde W adresi var mi (zarf + sonuc baytlari)");
for (const [name, h] of Object.entries(pe.txs)) {
  const hits = await addressesIn(h, pe.ws);
  const hasF = (await addressesIn(h, [f.address])).length > 0;
  console.log(`   ${name.padEnd(9)} W izi: ${hits.length ? hits.join(",") : "yok"}   F: ${hasF ? "var" : "yok"}`);
  must(hits.length === 0, `${name} isleminde W adresi var`);
}
console.log("   zincirden gorunen: uc cuzdan 10'ar yatirdi, F 10 aldi. F hangisi? Bilinmiyor.");

console.log("4) F x402 ile oduyor");
const seller = await newAgent("satici", 0n, { join: false });
await track([f.address, seller.address], { [f.address]: "F (gizli)", [seller.address]: "satici" });
const p = await pay(f, seller.address, U);
console.log(`   F -> satici 1: ${p.status}`);
must(p.status === "accepted", "F'nin odemesi kabul edilmeli");

console.log("5) relayer sadece kendi islem sekillerini imzaliyor");
const post = (path: string, body: unknown) =>
  fetch(`${LEDGER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()) as Promise<any>;
const rAcct = await chain.server.getAccount(relay.address);
const fAcct = await chain.server.getAccount(f.address);
const build = (source: Account, op: xdr.Operation, fee = "100") =>
  new TransactionBuilder(source, { fee, networkPassphrase: chain.cfg.passphrase }).addOperation(op).setTimeout(60).build().toXDR();
const extData = (amt: bigint) =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: A.sym("ext_amount"), val: nativeToScVal(amt, { type: "i256" }) }),
    new xdr.ScMapEntry({ key: A.sym("recipient"), val: A.addr(f.address) }),
  ]);
const transact = (amt: bigint, sender: string) => new Contract(pe.pool).call("transact", xdr.ScVal.scvVoid(), extData(amt), A.addr(sender));
const cases: [string, string, unknown, string][] = [
  ["havuza YATIRMA (R'nin parasini ceker)", "/relay/spp-sign", { xdr: build(rAcct, transact(10n * U, relay.address)) }, "not_a_withdrawal"],
  ["gonderen R degil", "/relay/spp-sign", { xdr: build(rAcct, transact(-U, f.address)) }, "sender_not_relayer"],
  ["kaynak R degil", "/relay/spp-sign", { xdr: build(fAcct, transact(-U, relay.address)) }, "source_not_relayer"],
  ["baska kontrat (token transfer)", "/relay/spp-sign", { xdr: build(rAcct, new Contract(dep.token).call("transfer", A.addr(relay.address), A.addr(f.address), A.i128(1n))) }, "not_spp_transact"],
  ["ucret tavani asan", "/relay/spp-sign", { xdr: build(rAcct, transact(-U, relay.address), "50000000") }, "fee_too_high"],
  ["fee-bump: kasa disi islem", "/relay/fee-bump", { xdr: build(fAcct, new Contract(dep.token).call("transfer", A.addr(f.address), A.addr(seller.address), A.i128(1n))) }, "not_vault_join_or_deposit"],
  ["fee-bump: baskasi adina yatirma", "/relay/fee-bump", { xdr: build(fAcct, new Contract(dep.hub).call("deposit", A.addr(seller.address), A.i128(1n))) }, "not_self"],
  ["fee-bump: XLM gonderme", "/relay/fee-bump", { xdr: build(fAcct, Operation.payment({ destination: relay.address, asset: Asset.native(), amount: "1" })) }, "not_vault_join_or_deposit"],
  ["var olan hesabi sponsorlama", "/relay/account", { address: f.address }, "account_exists"],
];
for (const [name, path, body, want] of cases) {
  const r = await post(path, body);
  console.log(`   ${name}: ${r.error ?? "IMZALANDI"}`);
  must(r.error === want, `${name}: ${want} bekleniyordu, ${JSON.stringify(r).slice(0, 120)}`);
}

console.log("\nGIZLI GIRIS KONTROLU GECTI");
process.exit(0);
