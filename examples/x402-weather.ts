// Gercek x402 v2: RESMI paketler, bizim sema.
//
//   - Hava durumu servisi: @x402/express paymentMiddleware. Servis SAF ALICI:
//     zincirde kaydi yok, hesap bile acilmadi, sadece bir adres.
//   - Ajan: @x402/fetch wrapFetchWithPayment. Normal fetch kullaniyor.
//   - Facilitator: golge defter (/supported, /settle).
//
// Defter calisirken:  node examples/x402-weather.ts

import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { BatchSettlementStellarServer, BatchSettlementStellarClient, SCHEME, NETWORK } from "@golge-defter/sdk/x402";
import { newAgent, track, settleNow, ledgerState, chain, dep, fmt, LEDGER, U } from "../demo/testnet.ts";
import { A } from "@golge-defter/sdk/chain";

// ---------------- hizmet satan taraf ----------------
const SERVICE = Keypair.random().publicKey(); // hesap bile acilmadi

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
        description: "Istanbul hava durumu",
      },
    },
    resourceServer,
  ),
);
app.get("/weather", (_req, res) => {
  res.json({ city: "Istanbul", tempC: 21 + Math.round(Math.random() * 3) });
});
const srv = app.listen(8790);

// ---------------- ajan yazan taraf ----------------
const me = await newAgent("ajan", 5n * U);
await track([me.address], { [me.address]: "ajan", [SERVICE]: "hava-servisi" });

const client = new x402Client()
  .register(NETWORK, new BatchSettlementStellarClient(me.agent))
  // x402'nin kendi harcama kontrolu: bu token, istek basina en fazla 0.10
  .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: dep.token, maxAmountPerPayment: String(U / 10n) }] });
const fetchPaid = wrapFetchWithPayment(fetch, client);

for (let i = 0; i < 10; i++) {
  const r = await fetchPaid("http://localhost:8790/weather");
  const body = await r.json();
  const receipt = r.headers.get("payment-response");
  const settle = receipt ? JSON.parse(Buffer.from(receipt, "base64").toString()) : null;
  console.log(r.status, JSON.stringify(body), settle ? `settle: success=${settle.success} seq=${settle.extra?.seq}` : "");
}

// ---------------- sonuc ----------------
const st = await ledgerState();
const view = (a: string) => st.participants.find((p: any) => p.address === a);
console.log(`\najan harcanabilir: ${fmt(view(me.address).spendable)}  (5.00 - 10 x 0.02)`);
console.log(`servis bekleyen alacak: ${fmt(view(SERVICE).pendingIn)}  zincir islemi: 0`);

await settleNow();
console.log(`parti: https://stellar.expert/explorer/testnet/tx/${(await ledgerState()).stats.lastBatchTx}`);

// PASIF ALICI: servis hicbir sey yapmadan parasini aliyor. Izinsiz itme.
await chain.invoke(me.kp, "payout", [A.addr(SERVICE)]);
console.log(`servisin cuzdani: ${fmt(await chain.tokenBalance(SERVICE))}  (hic imza atmadi)`);
srv.close();
process.exit(0);
