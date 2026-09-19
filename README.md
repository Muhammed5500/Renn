# Shadow Ledger (working name)

**Agents pay each other instantly. Nobody can spend more than they hold. The whole network settles in one transaction.**

Built for the Rise In x Stellar Pro Hackathon, Istanbul, 19-20 September 2026. Runs on Stellar testnet.

**A real x402 v2 scheme.** `batch-settlement` on `stellar:testnet`, used through the official `@x402/express`, `@x402/fetch` and `@x402/core` packages. Every payment in the demo is a full x402 round trip. Binding spec: [`docs/scheme_batch_settlement_stellar.md`](docs/scheme_batch_settlement_stellar.md).

## The problem

In an agent economy every agent is both a payer and a payee. Today's rails give two options:

- **Pay on chain every time (x402 `exact`).** Every call waits for a ledger close (~5 s) and is its own transaction.
- **Open a payment channel.** Channels are one-to-one. Every relationship needs its own escrow and its own locked capital.

Signing vouchers off chain avoids both, but creates a third problem: nobody can see a payer's total commitments. A payer with 20 in the pool can sign 20 to B and 20 to C. Both check the chain, both see 20, both deliver. One of them is left with a bounced cheque.

## The idea

Track the **spendable balance** off chain, in a single ordered public ledger, and make the contract refuse any voucher that ledger has not accepted.

```
spendable(x) = on-chain balance - reserved withdrawals + unsettled incoming - unsettled outgoing
```

- A voucher is accepted only if the payer's spendable balance covers it. The check happens **before** the service is delivered.
- Incoming money counts immediately. The same 10 dollars can circulate all day.
- Every accepted voucher carries two signatures: the payer's and the ledger operator's. The contract checks both, so the ledger cannot be bypassed.
- The ledger sends **prefixes of its acceptance order** as batches. Every prefix is solvent by construction, so on-chain netting never has to drop anyone.
- Settlement moves internal balances only. **No token moves during settlement.**
- Withdrawals need no batch when they are covered by the agent's own on-chain balance minus its unsettled promises. Only money that is still incoming (unsettled vouchers paid *to* the agent) waits for the next regular batch. A withdrawal never adds a settlement transaction.

## Demo (testnet, real transactions)

| Scene | What happens | Result |
|---|---|---|
| 1. Circular debt | A holds 20. A→B 100, B→C 90, C→A 80 in small alternating payments | 270 payments, **1 transaction**, vault token balance unchanged. [tx](https://stellar.expert/explorer/testnet/tx/d61993088b75e34baa118a102b95fe952310499d5b5a46ae2986105a7fefb210) |
| 2. Scale | 5 payers, 25 services, 600 payments | 600 x402 payments in ~2.4 s over local HTTP, **1 transaction**. [tx](https://stellar.expert/explorer/testnet/tx/41f0fe62e3370e7ba1bc007144b5a478497b82e46bbeefc694ef9bae7d6e3d4d) |
| 3. Bounced cheque | Empty payer tries to pay. A payer tries to promise the same 10 twice | Both refused instantly: `insufficient_spendable` |
| 4. Withdrawal | An agent with 50 pays 3, then withdraws 20 | Approved instantly, **no batch**: 3 of the 50 are promised, 20 are free. Tokens in the wallet in 4-8 s, no exit delay. [tx](https://stellar.expert/explorer/testnet/tx/d403dbcc366ec35f1e5169b8aedb30673881b53510764eb473458339b254e5f6) |
| 5. Operator down | A recipient settles its own accepted voucher without the ledger. A payer starts the escape hatch | [settle_one](https://stellar.expert/explorer/testnet/tx/bde1f1dadc08c4ff4a5d27204b450b7c4ef577b9efe16f2009b437e048ae4814), [exit_start](https://stellar.expert/explorer/testnet/tx/0d1ee7595d0a267b0764fdc0856113080227dd1092509467a9961cccd2e0d725) |

Every payment above goes through x402: the payer calls a paid endpoint with the official client, gets a 402, signs a voucher, and the resource server's official middleware asks the ledger (the facilitator) to settle before serving.

x402 example (`ledger/examples/x402-weather.ts`): a weather API behind `@x402/express` is called ten times by an agent using `@x402/fetch`. Zero on-chain transactions per call. The service never created an account and never signed anything; it was paid by a permissionless `payout` after one batch.

## Integration: the official x402 packages

```ts
// service
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER }))
  .register("stellar:testnet", new BatchSettlementStellarServer({ asset: TOKEN }));
app.use(paymentMiddleware({ "GET /weather": { accepts: {
  scheme: "batch-settlement", network: "stellar:testnet", payTo: ME, price: "0.02" } } }, server));

// agent
const client = new x402Client().register("stellar:testnet", new BatchSettlementStellarClient(agent));
const fetch = wrapFetchWithPayment(globalThis.fetch, client);   // plain fetch from here on
```

The flow is x402's `upfront`: the middleware calls the facilitator's `/settle` before running the handler. Our `/settle` records the voucher in the ledger (spendable-balance check, operator co-signature) and returns `transaction: ""`; value moves later in a batch, as the `batch-settlement` scheme allows. If settlement fails the handler never runs and the client gets a 402 with `errorReason` in `PAYMENT-RESPONSE`. The x402 client's own `spendControls` cap what an agent will pay per request.

`ledger/scripts/check-x402.ts` verifies the wire format (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`), refusal paths and spend controls against testnet.

## Trust model

| The operator CAN | The operator CANNOT |
|---|---|
| Refuse to accept vouchers (censor) | Forge a voucher. It needs the payer's signature |
| Refuse to approve a withdrawal | Take anyone's money. Withdrawals need the owner's signature and go to the owner's address |
| Go offline | Lock funds. `exit_start` works without the operator |
| Accept an unbacked voucher through a bug. The recipient bears that loss | Claw back money a recipient has received |

Agent safety (a compromised or misled agent spending what it legitimately holds) is the wallet's job, not the payment rail's. The rail guarantees that nobody spends money they don't have.

**The operator can't touch your money. The worst it can do is stop, and then you withdraw yourself.**

## Measured limits

From `LIMITS.md` (simulation on testnet, two `ed25519_verify` per voucher):

- **About 190 pairs per transaction.** The 400M instruction budget is the limit. The ledger uses 150.
- A pair is one voucher per batch no matter how many payments it contains.
- Fee: **0.0009 XLM per pair per batch** for pairs that already exist, 0.0189 XLM the first time (rent for new storage). An x402 payment measured on mainnet is 0.0024 XLM. Testnet only, mainnet not measured.

## Layout

```
contracts/hub      Soroban vault: join, deposit, settle_one, settle_batch (netting), withdrawals
contracts/token    SEP-41 test token (Circle's testnet faucet has no API)
ledger/src/core.ts     the ledger's rules. Pure: no network, no clock, no crypto
ledger/src/server.ts   x402 facilitator (/supported, /verify, /settle) + batcher + chain watcher
ledger/src/x402.ts     x402 scheme: BatchSettlementStellarServer, BatchSettlementStellarClient
ledger/src/payload.ts  the three signed payloads, byte-identical to the contract
ledger/ui/index.html   live dashboard served by the ledger (GET /), fed by /feed and /state
ledger/scripts         demo.ts, e2e.ts, limits.ts, check-*.ts
docs/                  x402 scheme binding spec
```

Contract addresses are in `deployments.json`. Vault: [`CDDO6GAL...X3OK2`](https://stellar.expert/explorer/testnet/contract/CDDO6GALOUQE5X7HHM6KHCU7D27M377IKOU4RC4PLSJFJRLOJDMX3OK2).

## Run it

Requirements: Rust with `wasm32v1-none`, `stellar` CLI 25.2+, Node 23.6+.

```bash
cargo test                      # 76 contract tests + 5 token tests
stellar contract build

cd ledger && npm install
npm test                        # 26 ledger tests, including the prefix and withdrawal properties
AUTO_SETTLE=0 npm start         # ledger on :8787 (needs ../.env with OPERATOR_SEED)
node scripts/demo.ts            # scenes 0-5 on testnet, every payment over x402
node scripts/check-x402.ts      # x402 v2 wire-format and refusal checks
# live dashboard: http://localhost:8787
```

The demo scripts mint test tokens with the `deployer` identity of the Stellar CLI.

## Honest notes

- **There is an operator, on purpose.** Ordering needs one place. It can censor and it can go down. It cannot steal and it cannot lock.
- **Recipients trust the operator on solvency.** If it accepts a bad voucher, the recipient loses. The ledger is public and every voucher is signed, so the mistake is provable, but nothing compensates it yet (roadmap: operator bond).
- **The ledger is public and pseudonymous.** Payment traffic is visible. Privacy is on the roadmap: SPP at the boundary needs zero contract changes, a closed ledger with a ZK validity proof is the full version.
- **In escape mode netting can need ordering.** If the operator is down, recipients settle their own vouchers one by one, and in a cycle someone may have to wait for another to settle first.
- **x402 binding not upstream.** The scheme follows the x402 v2 interfaces and runs with the official packages, but the Stellar `batch-settlement` binding is ours; it is not part of the x402 repository (see issue #3341).
- **No audit.** Hackathon code.
