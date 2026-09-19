// x402 v2 uyumluluk kontrolu, testnet'te. Defter AUTO_SETTLE=0 ile calisirken:
//   node demo/check-x402.ts
//
// 1. Ham 402: PAYMENT-REQUIRED basligi, v2 sekli, bizim sema ve extra alanlari
// 2. Odenen istek: PAYMENT-RESPONSE basligi, success, transaction ""
// 3. Karsiliksiz odeyen: settle reddeder, isleyici HIC calismaz
// 4. x402 istemcisinin kendi harcama kontrolu: pahali istek imzalanmaz
// 5. Baska kasanin fisi reddedilir

import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { BatchSettlementStellarServer, BatchSettlementStellarClient, SCHEME, NETWORK } from "@golge-defter/sdk/x402";
import { newAgent, track, dep, LEDGER, U } from "./testnet.ts";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("HATA:", m);
    process.exit(1);
  }
};
const b64json = (h: string | null) => (h ? JSON.parse(Buffer.from(h, "base64").toString()) : null);

const SERVICE = Keypair.random().publicKey();
let handlerCalls = 0;
let lastSigHeader: string | undefined;
const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER })).register(
  NETWORK,
  new BatchSettlementStellarServer({ asset: dep.token }),
);
const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /cheap": { accepts: { scheme: SCHEME, network: NETWORK, payTo: SERVICE, price: "0.02" } },
      "GET /pricey": { accepts: { scheme: SCHEME, network: NETWORK, payTo: SERVICE, price: "0.50" } },
    },
    rs,
  ),
);
app.get("/cheap", (q, r) => {
  handlerCalls++;
  lastSigHeader = q.header("payment-signature");
  r.json({ ok: true });
});
app.get("/pricey", (_q, r) => {
  handlerCalls++;
  r.json({ ok: true });
});
const srv = app.listen(8791);
const URL_ = "http://localhost:8791";

const [payer, broke] = await Promise.all([newAgent("odeyen", 5n * U), newAgent("bos", 0n)]);
await track([payer.address, broke.address]);
const clientFor = (a: typeof payer) =>
  wrapFetchWithPayment(
    fetch,
    new x402Client()
      .register(NETWORK, new BatchSettlementStellarClient(a.agent))
      .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: dep.token, maxAmountPerPayment: String(U / 10n) }] }),
  );

console.log("0) facilitator /supported");
const sup = await fetch(`${LEDGER}/supported`).then((r) => r.json());
console.log(`   ${JSON.stringify(sup.kinds.map((k: any) => [k.x402Version, k.scheme, k.network]))}`);
must(sup.kinds.some((k: any) => k.x402Version === 2 && k.scheme === SCHEME && k.network === NETWORK), "supported");

console.log("1) ham 402");
const raw = await fetch(`${URL_}/cheap`);
const pr = b64json(raw.headers.get("payment-required"));
must(raw.status === 402, `402 bekleniyordu: ${raw.status}`);
must(pr?.x402Version === 2, "x402Version 2");
const acc = pr.accepts[0];
console.log("   PAYMENT-REQUIRED:", JSON.stringify(acc));
must(acc.scheme === "batch-settlement" && acc.network === "stellar:testnet", "sema/ag");
must(acc.amount === "200000" && acc.asset === dep.token && acc.payTo === SERVICE, "tutar/varlik/alici");
must(acc.extra?.hub === dep.hub && acc.extra?.ledger === LEDGER && acc.extra?.paymentFlow === "upfront", `extra: ${JSON.stringify(acc.extra)}`);
must(handlerCalls === 0, "odemesiz istek isleyiciye ulasmamali");

console.log("2) odenen istek");
const paid = await clientFor(payer)(`${URL_}/cheap`);
const sr = b64json(paid.headers.get("payment-response"));
console.log(`   ${paid.status}  PAYMENT-RESPONSE: ${JSON.stringify({ ...sr, extra: { seq: sr?.extra?.seq } })}`);
must(paid.status === 200 && sr?.success === true && sr.transaction === "" && sr.network === NETWORK, "odenmis cevap");
must(sr.payer === payer.address && sr.amount === "200000", "odeyen ve tutar");
must(handlerCalls === 1, "isleyici bir kez calismali");
// Istemcinin tel uzerinden gonderdigi: v2 PaymentPayload, base64 JSON
const ps = b64json(lastSigHeader ?? null);
console.log(`   PAYMENT-SIGNATURE: ${JSON.stringify({ x402Version: ps?.x402Version, accepted: { scheme: ps?.accepted?.scheme, amount: ps?.accepted?.amount }, payload: { type: ps?.payload?.type, voucher: { ...ps?.payload?.voucher, signature: String(ps?.payload?.voucher?.signature).slice(0, 16) + "..." } } })}`);
must(ps?.x402Version === 2, "PAYMENT-SIGNATURE v2 olmali");
must(ps.accepted?.scheme === "batch-settlement" && ps.accepted?.payTo === SERVICE && ps.accepted?.amount === "200000", "accepted alani");
must(ps.payload?.type === "voucher" && ps.payload.voucher.payer === payer.address && ps.payload.voucher.recipient === SERVICE, "fis alani");
must(/^[0-9a-f]{128}$/.test(ps.payload.voucher.signature), "ed25519 imza, 64 bayt hex");

console.log("3) karsiliksiz odeyen");
const bad = await clientFor(broke)(`${URL_}/cheap`);
const badBody = await bad.text();
console.log(`   ${bad.status}  ${badBody.slice(0, 160)}`);
must(bad.status === 402, "karsiliksiz odeme 402 donmeli");
must(handlerCalls === 1, "isleyici CALISMAMALI");

console.log("4) x402 istemcisinin harcama kontrolu (0.50 > 0.10)");
let spendErr = "";
const pricey = await clientFor(payer)(`${URL_}/pricey`).catch((e: Error) => {
  spendErr = e.message;
  return null;
});
console.log(`   ${pricey ? pricey.status : "istemci reddetti: " + spendErr.slice(0, 120)}`);
must(pricey === null || pricey.status === 402, "pahali istek odenmemeli");
must(handlerCalls === 1, "isleyici CALISMAMALI");

console.log("5) baska kasanin fisi");
const fake = await fetch(`${LEDGER}/settle`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    x402Version: 2,
    paymentRequirements: { ...acc, extra: { ...acc.extra, hub: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 56) } },
    paymentPayload: { x402Version: 2, accepted: acc, payload: { type: "voucher", voucher: {} } },
  }),
}).then((r) => r.json());
console.log(`   ${JSON.stringify(fake)}`);
must(fake.success === false && fake.errorReason === "wrong_hub", "baska kasa reddedilmeli");

console.log("6) tekrar gonderim: ayni PAYMENT-SIGNATURE ikinci kez");
const replay = await fetch(`${URL_}/cheap`, { headers: { "payment-signature": lastSigHeader! } });
const rr = b64json(replay.headers.get("payment-response"));
console.log(`   ${replay.status}  errorReason=${rr?.errorReason}`);
must(replay.status === 402 && rr?.errorReason === "stale", "tekrar gonderim reddedilmeli");
must(handlerCalls === 1, "isleyici CALISMAMALI");
const ver = await fetch(`${LEDGER}/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ x402Version: 2, paymentPayload: ps, paymentRequirements: acc }),
}).then((r) => r.json());
console.log(`   /verify ayni yuk: ${JSON.stringify(ver)}`);
must(ver.isValid === false && ver.invalidReason === "stale", "/verify de reddetmeli");

console.log("\nX402 KONTROLU GECTI");
srv.close();
process.exit(0);
