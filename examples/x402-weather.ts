// Real x402 v2: the OFFICIAL packages, our scheme.
//
//   - Weather service: @x402/express paymentMiddleware. The service is a PURE
//     RECIPIENT: not registered on chain, no account opened, just an address.
//   - Agent: @x402/fetch wrapFetchWithPayment. It uses plain fetch.
//   - Facilitator: the shadow ledger (/supported, /settle).
//
// With the ledger running:  node examples/x402-weather.ts

import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { BatchSettlementStellarServer, BatchSettlementStellarClient, SCHEME, NETWORK } from "@golge-defter/sdk/x402";
import { newAgent, track, settleNow, ledgerState, chain, dep, fmt, LEDGER, U } from "../demo/testnet.ts";
import { A } from "@golge-defter/sdk/chain";

// ---------------- selling side (service) ----------------
const SERVICE = Keypair.random().publicKey(); // no account opened

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER })).register(
  NETWORK,
  new BatchSettlementStellarServer({ asset: dep.token }),
);

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: { scheme: SCHEME, network: NETWORK, payTo: SERVICE, price: "0.02" },
        description: "Istanbul weather",
      },
    },
    resourceServer,
  ),
);
app.get("/weather", (_req, res) => {
  res.json({ city: "Istanbul", tempC: 21 + Math.round(Math.random() * 3) });
});
const srv = app.listen(8790);

// ---------------- paying side (agent) ----------------
const me = await newAgent("agent", 5n * U);
await track([me.address], { [me.address]: "agent", [SERVICE]: "weather-service" });

const client = new x402Client()
  .register(NETWORK, new BatchSettlementStellarClient(me.agent))
  // x402's own spend control: this token, at most 0.10 per request
  .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: dep.token, maxAmountPerPayment: String(U / 10n) }] });
const fetchPaid = wrapFetchWithPayment(fetch, client);

for (let i = 0; i < 10; i++) {
  const r = await fetchPaid("http://localhost:8790/weather");
  const body = await r.json();
  const receipt = r.headers.get("payment-response");
  const settle = receipt ? JSON.parse(Buffer.from(receipt, "base64").toString()) : null;
  console.log(r.status, JSON.stringify(body), settle ? `settle: success=${settle.success} seq=${settle.extra?.seq}` : "");
}

// ---------------- result ----------------
const st = await ledgerState();
const view = (a: string) => st.participants.find((p: any) => p.address === a);
console.log(`\nagent spendable: ${fmt(view(me.address).spendable)}  (5.00 - 10 x 0.02)`);
console.log(`service pending incoming: ${fmt(view(SERVICE).pendingIn)}  on-chain transactions: 0`);

await settleNow();
console.log(`batch: https://stellar.expert/explorer/testnet/tx/${(await ledgerState()).stats.lastBatchTx}`);

// PASSIVE RECIPIENT: the service gets paid without doing anything. Permissionless push.
await chain.invoke(me.kp, "payout", [A.addr(SERVICE)]);
console.log(`service wallet: ${fmt(await chain.tokenBalance(SERVICE))}  (never signed anything)`);
srv.close();
process.exit(0);
