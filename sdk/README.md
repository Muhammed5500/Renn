# rennpay

Agent-side SDK for [Renn](https://github.com/Muhammed5500/Renn): pay per API call on Stellar with off-chain vouchers, and settle hundreds of payments in one netted transaction.

Agents deposit a SEP-41 token into a Soroban vault and pay each other with off-chain cumulative vouchers over [x402](https://github.com/coinbase/x402) v2. An ordered ledger (the operator) accepts a voucher only if the payer's spendable balance covers it, then co-signs it; the vault rejects vouchers the operator has not accepted. Many payments settle later in a single `settle_batch` transaction that moves no tokens.

Testnet only, not audited. Protocol details are in the [repository README](https://github.com/Muhammed5500/Renn#readme).

```bash
npm install rennpay
```

## Pay for a service

```ts
import { Agent, Chain, TESTNET, BatchSettlementStellarClient } from "rennpay";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const chain = new Chain({ ...TESTNET, hub: VAULT, token: TOKEN }, MY_ADDRESS);
const agent = new Agent({ address: MY_ADDRESS, seedHex: MY_VOUCHER_SEED, ledgerUrl: LEDGER, hub: { networkId, hub: VAULT } });

const client = new x402Client()
  .register("stellar:testnet", new BatchSettlementStellarClient(agent))
  .setSpendControls({ allowedAssets: [{ network: "stellar:testnet", asset: TOKEN, maxAmountPerPayment: "200000" }] });

const fetch = wrapFetchWithPayment(globalThis.fetch, client);   // plain fetch from here on
const res = await fetch("https://some-service.example/weather");
```

Before paying, the agent joins the vault once and deposits:

```ts
import { A } from "rennpay/chain";
await chain.invoke(keypair, "join", [A.addr(MY_ADDRESS), A.bytes(agent.commitmentKey)]);
await chain.invoke(keypair, "deposit", [A.addr(MY_ADDRESS), A.i128(100_000_000n)]);
```

## Sell a service

```ts
import { BatchSettlementStellarServer } from "rennpay";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER }))
  .register("stellar:testnet", new BatchSettlementStellarServer({ asset: TOKEN }));

app.use(paymentMiddleware({ "GET /weather": { accepts: {
  scheme: "batch-settlement", network: "stellar:testnet", payTo: MY_ADDRESS, price: "0.02" } } }, server));
```

A seller needs no account and signs nothing. It can withdraw its balance, or anyone can push it with `payout`.

## Private entry (optional)

Vault deposits are public: the chain shows which wallet funded which vault address. `privateOnboard()` enters the vault through a [Stellar Private Payments](https://github.com/NethermindEth/stellar-private-payments) pool, so the vault address cannot be linked to the funding wallet.

```ts
import { SppCli, privateOnboard } from "rennpay";

const spp = new SppCli({ bin: "spp", circuits: "./circuits", deployment: "./spp-deployments.json", relayUrl: LEDGER });
const f = await privateOnboard({ spp, wallet: "my-stellar-keys-alias", amount: 100_000_000n, chain, ledgerUrl: LEDGER });
// f.agent pays like any agent. Store f.secret and f.seedHex: nothing else can spend that balance.
```

This needs the official SPP CLI and its circuit artifacts installed separately; proofs are generated locally. What it hides: which wallet funded the address. What stays public: the amounts and the timing, so use round amounts and leave time between the deposit and the withdrawal. The anonymity set is the pool's depositors.

## Exports

| Import | What |
|---|---|
| `rennpay` | everything below |
| `rennpay/agent` | `Agent`: the voucher key, cumulative amounts per recipient |
| `rennpay/x402` | `BatchSettlementStellarClient`, `BatchSettlementStellarServer`, `SCHEME`, `NETWORK` |
| `rennpay/chain` | `Chain`, `TESTNET`, `A` (ScVal helpers), `voucherScVal` |
| `rennpay/payload` | the three signed payloads, byte-identical to the contract |
| `rennpay/private` | `privateOnboard`, `openSponsored`, `relayedInvoke` |
| `rennpay/spp` | `SppCli`, `units` |

MIT
