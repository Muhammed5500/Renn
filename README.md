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
| 6. Private entry | Three wallets deposit 10 each into our SPP pool. One withdraws to a fresh F, which joins the vault with 0 XLM and pays over x402 | No wallet address in any of F's 4 transactions. F is one of three. [withdrawal](https://stellar.expert/explorer/testnet/tx/de3c7df89ed6928afc1e11a563ce050f33e0913ca281897e89151c8c2784942a) |

Every payment above goes through x402: the payer calls a paid endpoint with the official client, gets a 402, signs a voucher, and the resource server's official middleware asks the ledger (the facilitator) to settle before serving.

x402 example (`examples/x402-weather.ts`): a weather API behind `@x402/express` is called ten times by an agent using `@x402/fetch`. Zero on-chain transactions per call. The service never created an account and never signed anything; it was paid by a permissionless `payout` after one batch.

## Integration: the official x402 packages

```ts
import { Agent, BatchSettlementStellarClient, BatchSettlementStellarServer } from "@golge-defter/sdk";

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

`demo/check-x402.ts` verifies the wire format (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`), refusal paths and spend controls against testnet.

## Trust model

| The operator CAN | The operator CANNOT |
|---|---|
| Refuse to accept vouchers (censor) | Forge a voucher. It needs the payer's signature |
| Refuse to approve a withdrawal | Take anyone's money. Withdrawals need the owner's signature and go to the owner's address |
| Go offline | Lock funds. `exit_start` works without the operator |
| Accept an unbacked voucher through a bug. The recipient bears that loss | Claw back money a recipient has received |

Agent safety (a compromised or misled agent spending what it legitimately holds) is the wallet's job, not the payment rail's. The rail guarantees that nobody spends money they don't have.

**The operator can't touch your money. The worst it can do is stop, and then you withdraw yourself.**

## Private entry (SPP)

Vault balances are pseudonymous, but deposits are public: anyone can see which wallet funded which vault address. An agent that wants its vault address unlinked from its known wallet enters through a [Stellar Private Payments](https://github.com/NethermindEth/stellar-private-payments) (SPP) pool:

```
W (known wallet) --deposit--> SPP pool --withdraw--> F (fresh address) --join, deposit--> vault
```

- **The pool is ours.** Nethermind's pool contract, the unchanged wasm, deployed for our token with a blocklist-only policy. It shares SPP's testnet verifier and ASP contracts (`spp/deployments.json`). The vault contract did not change.
- **The official SPP CLI, unchanged.** Groth16 proofs are generated on the agent's machine.
- **F never holds XLM.** If W paid any of F's fees, the chain would show W → F. A relayer (operator-run, with its own key) pays every fee on F's side:
  - `POST /relay/spp-sign` signs the SPP withdrawal as source and fee payer. The CLI reaches it through `sdk/spp-shim`, a stand-in for the `stellar` binary that handles only the alias `gd-relay` and passes everything else to the real CLI.
  - `POST /relay/account` opens F with 0 XLM. The relayer sponsors the reserve.
  - `POST /relay/fee-bump` pays for F's own `join` and `deposit`.
- **The relayer signs three shapes only:** an SPP withdrawal (negative amount) with itself as source and sender, a sponsorship for a new account, and a vault `join`/`deposit` by the transaction's own source. None of them moves anyone's tokens, including its own. `check-private.ts` submits nine other shapes, and the relayer refuses all of them.

`demo/check-private.ts` on testnet: three wallets deposit 10 each, and one of them withdraws to F. A byte scan of the withdrawal and of F's three transactions finds none of the three wallets. F has 0 XLM, its sponsor is the relayer, and it pays over x402 like any other agent.

What this hides and what it doesn't:

- It hides **which** wallet funded F. F could be any depositor of the same amount.
- **Amounts and timing are public.** Depositing 10.37 and withdrawing 10.37 a minute later links the two. Use round amounts and wait.
- **The anonymity set is the pool's depositors.** With three depositors, F is one of three.
- The relayer sees request IPs, which is off-chain.
- SPP is unaudited. Its trusted setup is a local test setup. Testnet only.

## Measured limits

From `LIMITS.md` (simulation on testnet, two `ed25519_verify` per voucher):

- **About 190 pairs per transaction.** The 400M instruction budget is the limit. The ledger uses 150.
- A pair is one voucher per batch no matter how many payments it contains.
- Fee: **0.0009 XLM per pair per batch** for pairs that already exist, 0.0189 XLM the first time (rent for new storage). An x402 payment measured on mainnet is 0.0024 XLM. Testnet only, mainnet not measured.

## When a batch closes

The ledger sends a batch on whichever trigger fires first (`AUTO_SETTLE=1`, the default):

| Trigger | Default | Env | Why |
|---|---|---|---|
| Time | every 5 min if anything is unsettled | `ROUND_MS` | Cost vs. how long a recipient waits to withdraw externally |
| Capacity | 150 unsettled **distinct pairs** | `MAX_PAIRS` | ~190 pairs fit in one transaction; also the per-batch cap |
| Total value | 1000 units unsettled | `MAX_UNSETTLED` | Bounds how much value relies on the operator at any time |
| Recipient value | 100 units owed to one recipient | `MAX_RECIPIENT_UNSETTLED` | Large payments reach the chain without waiting |
| Exit | a payer calls `exit_start` | always on | The payer's vouchers must settle before the escape hatch opens |

A trigger settles only what was accepted before it fired; vouchers arriving while a batch is in flight wait for their own trigger. Each batch records its reason (visible in `/state` and on the dashboard). `demo/check-triggers.ts` verifies capacity, recipient and total triggers on testnet. Demo mode (`AUTO_SETTLE=0`) sends batches only on `/flush`, exit and withdrawals of incoming money.

Rough cost for 20 pairs that pay each other continuously, from the measured 0.0009 XLM per pair per batch: about 52 XLM/day at 30 s, 5 XLM/day at 5 min, 0.4 XLM/day at 1 h.

## Layout

Three packages (npm workspaces). An agent or a paid service needs only the SDK; the operator code is separate.

```
contracts/hub          Soroban vault: join, deposit, settle_one, settle_batch (netting), withdrawals
contracts/token        SEP-41 test token (Circle's testnet faucet has no API)

sdk/                   @golge-defter/sdk: what agents and services use
  src/agent.ts           the agent's voucher key; syncs cumulative amounts with the ledger
  src/x402.ts            x402 scheme: BatchSettlementStellarClient (payer), BatchSettlementStellarServer (seller)
  src/payload.ts         the three signed payloads, byte-identical to the contract
  src/chain.ts           vault calls and reads over Soroban RPC
  src/private.ts         private entry, agent side: sponsored account, fee-bumped join/deposit
  spp-shim/              `stellar` stand-in so the official SPP CLI can use the remote relayer

operator/              the ledger: only the operator runs this
  src/core.ts            the ledger's rules. Pure: no network, no clock, no crypto
  src/server.ts          x402 facilitator (/supported, /verify, /settle) + batcher + chain watcher
  src/relay.ts           relayer for private entry: /relay/spp-sign, /relay/account, /relay/fee-bump
  ui/index.html          live dashboard (GET /), fed by /feed and /state

demo/                  testnet demo and checks. The agents here are scripted, not autonomous
examples/              x402 weather service and an agent paying it
spp/deployments.json   our SPP pool (RTUSD), in the SPP CLI's deployment format
docs/                  x402 scheme binding spec
```

Contract addresses are in `deployments.json`. Vault: [`CDDO6GAL...X3OK2`](https://stellar.expert/explorer/testnet/contract/CDDO6GALOUQE5X7HHM6KHCU7D27M377IKOU4RC4PLSJFJRLOJDMX3OK2).

## Run it

Requirements: Rust with `wasm32v1-none`, `stellar` CLI 25.2+, Node 23.6+.

```bash
cargo test                      # 76 contract tests + 5 token tests
stellar contract build

npm install                     # from the repo root: sdk, operator, demo
npm test                        # 29 tests (sdk 5, operator 24), including the prefix and withdrawal properties
AUTO_SETTLE=0 npm start         # ledger on :8787 (needs .env with OPERATOR_SEED; RELAYER_SECRET enables /relay)
node demo/demo.ts               # scenes 0-6 on testnet, every payment over x402
node demo/check-x402.ts         # x402 v2 wire-format and refusal checks
# live dashboard: http://localhost:8787
```

The demo scripts mint test tokens with the `deployer` identity of the Stellar CLI.

Private entry (scene 6, `check-private.ts`) also needs the SPP CLI in `spp/bin/` and its circuits in `spp/circuits/` (both gitignored; `SPP_BIN` / `SPP_CIRCUITS` override):

```bash
git clone https://github.com/NethermindEth/stellar-private-payments && cd stellar-private-payments
cargo build --release -p stellar-private-payments-cli     # copy target/release/spp to spp/bin/ (tested at 10ffa0e)
# circuits: the circuits-v0.4 release tarball of the SPP repo, unpacked into spp/circuits/;
# spp/circuits/circuits.json holds the sha256 of each file
node demo/check-private.ts
```

## Honest notes

- **There is an operator, on purpose.** Ordering needs one place. It can censor and it can go down. It cannot steal and it cannot lock.
- **Recipients trust the operator on solvency.** If it accepts a bad voucher, the recipient loses. The ledger is public and every voucher is signed, so the mistake is provable, but nothing compensates it yet (roadmap: operator bond).
- **Entry can be private, payments inside are not.** SPP unlinks a vault address from the wallet that funded it (see Private entry). Inside the vault, the operator sees who pays whom, and settled pairs are visible on chain.
- **In escape mode netting can need ordering.** If the operator is down, recipients settle their own vouchers one by one, and in a cycle someone may have to wait for another to settle first.
- **x402 binding not upstream.** The scheme follows the x402 v2 interfaces and runs with the official packages, but the Stellar `batch-settlement` binding is ours; it is not part of the x402 repository (see issue #3341).
- **No audit.** Hackathon code.
