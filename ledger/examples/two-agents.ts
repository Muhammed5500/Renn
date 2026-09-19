// ADIM S kabul kriteri. Iki taraf, iki satir entegrasyon.
//
//   - Hava durumu servisi: SAF ALICI. Hicbir sey kurmuyor, zincirde kaydi yok,
//     sadece bir adres. Tek satir: tab({...}, handler)
//   - Ajan: tek satir: wrapFetch(agent). Kodunda odemeyle ilgili tek kelime yok.
//
// Defter calisirken:  node examples/two-agents.ts

import http from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { tab, wrapFetch } from "../src/http402.ts";
import { newAgent, track, settleNow, ledgerState, chain, dep, fmt, LEDGER, U } from "../scripts/testnet.ts";
import { A } from "../src/chain.ts";

// ---------------- hizmet satan taraf ----------------
const service = Keypair.random().publicKey(); // hesap bile acilmadi
const PRICE = U / 50n; // 0.02

http
  .createServer(
    tab({ ledger: LEDGER, hub: dep.hub, recipient: service, price: PRICE }, (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ city: "Istanbul", tempC: 21 + Math.round(Math.random() * 3) }));
    }),
  )
  .listen(8790);

// ---------------- ajan yazan taraf ----------------
const me = await newAgent("ajan", 5n * U);
await track([me.address]);
const fetch = wrapFetch(me.agent, { maxPrice: U / 10n });

for (let i = 0; i < 10; i++) {
  const r = await fetch("http://localhost:8790/weather");
  const body = await r.json();
  console.log(r.status, JSON.stringify(body), "fis#", r.headers.get("x-tab-receipt"));
}

// ---------------- sonuc ----------------
const st = await ledgerState();
const view = (a: string) => st.participants.find((p: any) => p.address === a);
console.log(`\najan harcanabilir: ${fmt(view(me.address).spendable)}  (5.00 - 10 x 0.02)`);
console.log(`servis bekleyen alacak: ${fmt(view(service).pendingIn)}  zincir islemi: 0`);

await settleNow();
console.log(`parti: https://stellar.expert/explorer/testnet/tx/${(await ledgerState()).stats.lastBatchTx}`);

// PASIF ALICI: servis hicbir sey yapmadan parasini aliyor. Izinsiz itme.
await chain.invoke(me.kp, "payout", [A.addr(service)]);
console.log(`servisin cuzdani: ${fmt(await chain.tokenBalance(service))}  (hic imza atmadi)`);
process.exit(0);
