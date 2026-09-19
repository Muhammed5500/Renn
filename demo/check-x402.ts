// x402 v2 compliance check, on testnet. With the ledger running with AUTO_SETTLE=0:
//   node demo/check-x402.ts
//
// 1. Raw 402: PAYMENT-REQUIRED header, v2 shape, our scheme and extra fields
// 2. Paid request: PAYMENT-RESPONSE header, success, transaction ""
// 3. Unbacked payer: settle refuses, the handler NEVER runs
// 4. The x402 client's own spend controls: an expensive request is not signed
// 5. A voucher for another vault is refused
// 6. Replay of the same PAYMENT-SIGNATURE is refused

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
    console.error("ERROR:", m);
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

const [payer, broke] = await Promise.all([newAgent("payer", 5n * U), newAgent("empty", 0n)]);
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

console.log("1) raw 402");
const raw = await fetch(`${URL_}/cheap`);
const pr = b64json(raw.headers.get("payment-required"));
must(raw.status === 402, `expected 402: ${raw.status}`);
must(pr?.x402Version === 2, "x402Version 2");
const acc = pr.accepts[0];
console.log("   PAYMENT-REQUIRED:", JSON.stringify(acc));
must(acc.scheme === "batch-settlement" && acc.network === "stellar:testnet", "scheme/network");
must(acc.amount === "200000" && acc.asset === dep.token && acc.payTo === SERVICE, "amount/asset/recipient");
must(acc.extra?.hub === dep.hub && acc.extra?.ledger === LEDGER && acc.extra?.paymentFlow === "upfront", `extra: ${JSON.stringify(acc.extra)}`);
must(handlerCalls === 0, "an unpaid request must not reach the handler");

console.log("2) paid request");
const paid = await clientFor(payer)(`${URL_}/cheap`);
const sr = b64json(paid.headers.get("payment-response"));
console.log(`   ${paid.status}  PAYMENT-RESPONSE: ${JSON.stringify({ ...sr, extra: { seq: sr?.extra?.seq } })}`);
must(paid.status === 200 && sr?.success === true && sr.transaction === "" && sr.network === NETWORK, "paid response");
must(sr.payer === payer.address && sr.amount === "200000", "payer and amount");
must(handlerCalls === 1, "the handler should run once");
// What the client sends on the wire: v2 PaymentPayload, base64 JSON
const ps = b64json(lastSigHeader ?? null);
console.log(`   PAYMENT-SIGNATURE: ${JSON.stringify({ x402Version: ps?.x402Version, accepted: { scheme: ps?.accepted?.scheme, amount: ps?.accepted?.amount }, payload: { type: ps?.payload?.type, voucher: { ...ps?.payload?.voucher, signature: String(ps?.payload?.voucher?.signature).slice(0, 16) + "..." } } })}`);
must(ps?.x402Version === 2, "PAYMENT-SIGNATURE should be v2");
must(ps.accepted?.scheme === "batch-settlement" && ps.accepted?.payTo === SERVICE && ps.accepted?.amount === "200000", "accepted field");
must(ps.payload?.type === "voucher" && ps.payload.voucher.payer === payer.address && ps.payload.voucher.recipient === SERVICE, "voucher field");
must(/^[0-9a-f]{128}$/.test(ps.payload.voucher.signature), "ed25519 signature, 64 bytes hex");

console.log("3) unbacked payer");
const bad = await clientFor(broke)(`${URL_}/cheap`);
const badBody = await bad.text();
console.log(`   ${bad.status}  ${badBody.slice(0, 160)}`);
must(bad.status === 402, "an unbacked payment should return 402");
must(handlerCalls === 1, "the handler MUST NOT run");

console.log("4) the x402 client's spend controls (0.50 > 0.10)");
let spendErr = "";
const pricey = await clientFor(payer)(`${URL_}/pricey`).catch((e: Error) => {
  spendErr = e.message;
  return null;
});
console.log(`   ${pricey ? pricey.status : "client refused: " + spendErr.slice(0, 120)}`);
must(pricey === null || pricey.status === 402, "the expensive request must not be paid");
must(handlerCalls === 1, "the handler MUST NOT run");

console.log("5) voucher for another vault");
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
must(fake.success === false && fake.errorReason === "wrong_hub", "another vault should be refused");

console.log("6) replay: the same PAYMENT-SIGNATURE a second time");
const replay = await fetch(`${URL_}/cheap`, { headers: { "payment-signature": lastSigHeader! } });
const rr = b64json(replay.headers.get("payment-response"));
console.log(`   ${replay.status}  errorReason=${rr?.errorReason}`);
must(replay.status === 402 && rr?.errorReason === "stale", "a replay should be refused");
must(handlerCalls === 1, "the handler MUST NOT run");
const ver = await fetch(`${LEDGER}/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ x402Version: 2, paymentPayload: ps, paymentRequirements: acc }),
}).then((r) => r.json());
console.log(`   /verify, same payload: ${JSON.stringify(ver)}`);
must(ver.isValid === false && ver.invalidReason === "stale", "/verify should refuse it too");

console.log("\nX402 CHECK PASSED");
srv.close();
process.exit(0);
