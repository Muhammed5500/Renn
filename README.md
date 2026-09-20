# Renn

**Hundreds of agent payments, one Stellar transaction.**

Renn is a payment rail for agent-to-agent commerce on Stellar. An agent deposits once into a shared Soroban vault and then pays per API call with signed off-chain vouchers. Each payment clears in milliseconds, so the service is served on the same request; the debts are netted and written to the chain later, many payments at a time, in a single transaction. A payer can never promise more than its vault balance covers, and that is checked before the service is delivered.

It is a real [x402](https://github.com/coinbase/x402) v2 scheme, so any agent or service already speaking x402 can use it by registering one scheme.

```bash
npm install rennpay
```

| | |
|---|---|
| Site | [renn-beryl.vercel.app](https://renn-beryl.vercel.app) |
| SDK | [`rennpay`](https://www.npmjs.com/package/rennpay), MIT |
| Network | Stellar testnet, Protocol 28, Soroban |
| x402 | v2, scheme `batch-settlement`, flow `upfront` ([spec](docs/scheme_batch_settlement_stellar.md)) |
| Vault | [`CBIKFGMU…NJHLCCK`](https://stellar.expert/explorer/testnet/contract/CBIKFGMUUTJQ7PWRHHMH7TW4H3LFJS5HUFE6QHYZ2NDZ6ZZIPNJHLCCK) |
| Built for | Rise In x Stellar Pro Hackathon, Istanbul, 19-20 September 2026 |
| Status | Works on testnet. Not audited, not on mainnet |

What it gives an agent:

- **No wait per call.** The payment clears off chain and the service is served on the same request. Only settlement waits for a batch, and the recipient already holds an enforceable claim.
- **One deposit for everyone.** Not a channel per counterparty. Money received is immediately spendable against anyone.
- **No bounced cheques.** A payer cannot promise more than it holds, and the check happens before the service is delivered.
- **Your money stays yours.** Withdraw whenever you like, and if the operator disappears there is an escape hatch that does not need it.

---

## The problem

In an agent economy everyone is both payer and payee, and the payments are small and constant. Today there are two options:

- **Pay on chain every time** (x402 `exact`). Every call is its own transaction and waits about 5 seconds. Fees dominate a $0.02 call.
- **Open a payment channel.** Channels are one-to-one: every counterparty needs its own escrow and its own locked capital.

Signing vouchers off chain avoids both and creates a third problem: **nobody can see a payer's total commitments.** A payer holding 20 can sign 20 to B and 20 to C. Both check the chain, both see 20, both deliver, and one of them is left with a bounced cheque.

**Renn is neither of the two.** One shared vault, not a channel. Deposit once, pay anyone who uses the same vault, including agents you have never met.

| | On chain per call | Payment channel | Renn |
|---|---|---|---|
| Capital | Nothing locked | Locked per counterparty | One deposit, usable against everyone |
| New counterparty | Nothing to do | A new channel, funded and opened | Nothing to do |
| Cost per payment | One transaction | Amortised over open and close | A share of one batch transaction |
| Time to serve | About 5 s, one ledger close | Immediate | Immediate |
| Money received | Usable after the transaction | Usable inside that channel | Spendable immediately, anywhere in the vault |
| Who can be paid | Anyone | Only the channel's other side | Any address, even one that never joined |

## The idea

Track the **spendable balance** off chain, in one ordered public ledger, and make the contract refuse any voucher that ledger has not accepted.

```
spendable(x) = on-chain balance
             - reserved withdrawals
             + unsettled incoming        (vouchers others signed to x)
             - unsettled outgoing        (vouchers x signed to others)
```

1. **A voucher is accepted only if that balance covers it**, before the service is delivered. A bounced cheque never exists.
2. **Incoming money counts immediately.** The same 10 units circulate all day: A→B→C→A closes with nobody topping up.
3. **Every accepted voucher carries two signatures**, the payer's and the operator's. The contract checks both, so the ledger cannot be bypassed and the operator cannot forge.
4. **Batches are prefixes of the acceptance order**, so every batch is solvent by construction and on-chain netting never drops anyone.
5. **Settlement moves internal balances only.** The vault's token balance does not move when debts net out.

---

## Architecture

```
  OFF CHAIN: agents, services, the ledger

  +---------------+   1 GET /weather    +----------------+
  |    Agent A    | ------------------> |   Service B    |
  |               |   2 402 + terms     |                |
  |  rennpay SDK  | <------------------ |  rennpay SDK   |
  |  voucher key  |   3 signed voucher  |  + x402 mw     |
  |               | ------------------> |                |
  +---------------+   6 200 + data      +-------+--------+
          ^                                     |
          |                                     | 4 POST /settle
          |                                     v
          |                         +-----------------------+
          +------ 5 accepted -------|   Ledger (operator)   |
                 (two signatures)   |                       |
                                    |  ordered acceptance   |
                                    |  spendable check      |
                                    |  co-signature         |
                                    |  append-only log      |
                                    |  x402 facilitator     |
                                    +-----+-----------+-----+
                                          |           ^
                        7 settle_batch    |           |  reads + events
                        (one transaction) v           |  join, deposit, exit

                                    +-----------------------+   ON CHAIN
                                    |   Vault (Soroban)     |
                                    |                       |
                                    |  balance per agent    |
                                    |  paid(payer->recip)   |
                                    |  registered keys      |
                                    |  exit timers, nonces  |
                                    +-----------------------+
```

Steps 1, 2 and 6 are stock x402. Step 3 is a cumulative voucher instead of a transfer. Steps 4 and 5 are the facilitator, which here is an ordered ledger rather than a broadcaster. Step 7 happens later, once, for many payments at a time.

| Component | Runs where | Responsibility | Can it move money? |
|---|---|---|---|
| **Vault** (`contracts/hub`) | Stellar | Holds deposits, verifies both signatures, nets batches, pays withdrawals, enforces the escape hatch | It *is* the money. Only the owner's signature moves it out |
| **Ledger / operator** (`operator/`) | One server | Orders vouchers, checks the spendable balance, co-signs, sends batches, approves withdrawals, serves the x402 facilitator API | No. It can refuse and it can stop |
| **SDK** (`sdk/` → `rennpay`) | Every agent and paid service | Voucher signing, x402 client and seller scheme, vault calls, private entry | Only with the agent's own key |
| **Relayer** (`operator/src/relay.ts`) | With the operator, separate key | Pays fees for a fresh address during private entry | No. Three narrow transaction shapes, none of which transfers tokens |

**What the recipient holds after step 5** is a claim with two signatures on it. That claim is enforceable on chain without the operator (`settle_one`), which is what makes waiting for a batch safe.

**Cumulative, not incremental.** A voucher says "I have committed 4.20 in total to you", not "here is 0.02". A lost voucher costs nothing, a replay is a no-op, and only the newest voucher per pair is ever settled. That is why 600 payments between 5 payers and 25 services settle as at most 125 rows.

**Prefix batches.** The operator cuts a prefix of its acceptance order and sends one voucher per pair. On chain the vault verifies both signatures, skips vouchers already settled by someone else, nets every position and applies the result with a fixed-point loop. Because every acceptance was checked against all earlier ones, every prefix is solvent and the loop never has to drop a payer. This is tested as a property over random histories.

### Trust model

| The operator CAN | The operator CANNOT |
|---|---|
| Refuse vouchers (censor) | Forge a voucher: it needs the payer's key |
| Refuse to approve a withdrawal | Take anyone's money: withdrawals need the owner's signature and go to the owner |
| Go offline | Lock funds: `exit_start` works without it |
| Accept an unbacked voucher through a bug, and the recipient bears that loss | Claw back money a recipient received |
| See who pays whom | Change the rules: the contract verifies both signatures itself |

**The operator cannot touch your money. The worst it can do is stop, and then you withdraw yourself.**

Agent safety, meaning a compromised agent spending money it legitimately holds, is the wallet's problem, not the rail's. Spending policy belongs in the x402 client's `spendControls`.

### Getting money out

| Situation | Path | Waiting |
|---|---|---|
| Withdraw what you hold | `POST /withdraw` (signed, nonced) → `withdraw_approved` | Instant, no batch |
| Withdraw money still incoming | Same, but the approval waits for the next regular batch | One batch |
| Operator refuses or is down | `exit_start`, wait `exit_delay`, `withdraw` | 60 ledgers on testnet |
| You are a recipient who never joined | `withdraw` any time, or anyone calls `payout` | One transaction |

```
withdrawable now = on-chain balance - unsettled vouchers you signed - existing reservations
```

Up to that amount the operator signs immediately and **no batch is sent**: a withdrawal never costs the rail an extra transaction.

---

## Demo

`npm run demo` runs seven scenes on testnet. Every payment is a full x402 round trip through the official packages; nothing is mocked.

| Scene | What happens | Result |
|---|---|---|
| 0. Vaults | Five agents, balances and spendable amounts | Nobody can spend more than they hold |
| 1. Circular debt | A holds 20. A→B 100, B→C 90, C→A 80 in small alternating payments | 270 payments, **1 transaction**, vault token balance unchanged. [tx](https://stellar.expert/explorer/testnet/tx/d61993088b75e34baa118a102b95fe952310499d5b5a46ae2986105a7fefb210) |
| 2. Scale | 5 payers, 25 services, 600 payments | 600 x402 payments in a few seconds, **1 transaction**. [tx](https://stellar.expert/explorer/testnet/tx/41f0fe62e3370e7ba1bc007144b5a478497b82e46bbeefc694ef9bae7d6e3d4d) |
| 3. Bounced cheque | An empty payer tries to pay; a payer promises the same 10 twice | Both refused instantly: `insufficient_spendable` |
| 4. Withdrawal | An agent with 50 pays 3, then withdraws 20 | Instant approval, **no batch**, tokens in the wallet in seconds. [tx](https://stellar.expert/explorer/testnet/tx/d403dbcc366ec35f1e5169b8aedb30673881b53510764eb473458339b254e5f6) |
| 5. Operator down | A recipient settles its own voucher without the ledger; a payer opens the escape hatch | [settle_one](https://stellar.expert/explorer/testnet/tx/bde1f1dadc08c4ff4a5d27204b450b7c4ef577b9efe16f2009b437e048ae4814), [exit_start](https://stellar.expert/explorer/testnet/tx/0d1ee7595d0a267b0764fdc0856113080227dd1092509467a9961cccd2e0d725) |
| 6. Private entry | Three wallets deposit into an SPP pool; one enters the vault as a fresh address and pays | No wallet address in any of the fresh address's transactions. [withdrawal](https://stellar.expert/explorer/testnet/tx/de3c7df89ed6928afc1e11a563ce050f33e0913ca281897e89151c8c2784942a) |

`examples/x402-weather.ts` is the smallest complete picture: a weather API behind `@x402/express` called ten times by an agent using `@x402/fetch`, zero on-chain transactions per call. The service never created an account and never signed anything; a permissionless `payout` paid it after one batch.

### Four Claude agents trading

`examples/llm-agents/` is the demo that is not scripted. Four agents run as ordinary consumers of the published npm package: each sells one thing (briefs, analysis, copy, criticism), and on its own schedule asks Claude what to buy and from whom, then pays for it over x402. The seller's answer is Claude too.

```bash
cd examples/llm-agents && npm install && node run.ts
```

They are worth reading because they are the outside view of the SDK, and that view found two real bugs: an agent that joined, deposited and paid within the same second was refused, and a lagging RPC node answering "Account not found" for an account that exists took a process down. Both are fixed; both were invisible from inside our own demo.

The LLM is the local `claude` CLI, so it needs no API key, and identities live in `examples/llm-agents/state/` (gitignored), so restarts keep the same addresses and vault balances.

The dashboard at `http://localhost:8787` shows the same live: the voucher stream, the netting panel, batch reasons, and the vault's token balance standing still while hundreds of payments clear.

---

## Use it

**Pay for a service.** Everything except the scheme registration is stock x402.

```ts
import { Agent, Chain, TESTNET, BatchSettlementStellarClient } from "rennpay";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const chain = new Chain({ ...TESTNET, hub: VAULT, token: TOKEN }, MY_ADDRESS);
const agent = new Agent({ address: MY_ADDRESS, seedHex: VOUCHER_SEED, ledgerUrl: LEDGER, hub: HUB_CFG });

const client = new x402Client()
  .register("stellar:testnet", new BatchSettlementStellarClient(agent))
  .setSpendControls({ allowedAssets: [{ network: "stellar:testnet", asset: TOKEN, maxAmountPerPayment: "200000" }] });

const pay = wrapFetchWithPayment(globalThis.fetch, client);
const res = await pay("https://service.example/weather");   // 402, sign, retry, served
```

**Join the vault once**, before paying:

```ts
import { A } from "rennpay/chain";
await chain.invoke(keypair, "join", [A.addr(MY_ADDRESS), A.bytes(agent.commitmentKey)]);
await chain.invoke(keypair, "deposit", [A.addr(MY_ADDRESS), A.i128(100_000_000n)]);
```

**Sell a service.** A seller needs no account, no registration and no signature.

```ts
import { BatchSettlementStellarServer } from "rennpay";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER }))
  .register("stellar:testnet", new BatchSettlementStellarServer({ asset: TOKEN }));

app.use(paymentMiddleware({ "GET /weather": { accepts: {
  scheme: "batch-settlement", network: "stellar:testnet", payTo: MY_ADDRESS, price: "0.02" } } }, server));
```

---

## Run the whole thing

Requirements: Rust with `wasm32v1-none`, the `stellar` CLI, Node 23.6+. The operator and the demo run TypeScript directly; only the SDK is compiled, and the npm scripts do that for you.

```bash
cargo test                  # 76 vault tests + 5 token tests
stellar contract build

npm install                 # workspace: sdk, operator, demo
npm test                    # builds the SDK, then 29 tests (sdk 5, operator 24)

AUTO_SETTLE=0 npm start     # ledger on :8787, needs .env (below)
npm run demo                # scenes 0-6 on testnet
node demo/check-x402.ts     # x402 wire format, refusals, replay, spend controls
# dashboard: http://localhost:8787
```

`.env` at the repo root, never committed:

```
OPERATOR_SEED=<32-byte hex>     # the operator's acceptance key
RELAYER_SECRET=<S…>             # optional, enables /relay for private entry
```

Three packages in one npm workspace. An agent installs only the SDK; the operator's code never ships to agents.

```
contracts/hub     Soroban vault: join, deposit, settle_one, settle_batch, withdrawals, exit
contracts/token   SEP-41 test token (Circle's testnet faucet has no API)

sdk/              rennpay on npm: agent.ts (voucher key), x402.ts (client + seller scheme),
                  payload.ts (signed bytes), chain.ts (vault calls), private.ts + spp.ts
                  (private entry), spp-shim/ (stand-in for the `stellar` binary)

operator/         core.ts (the rules, pure), server.ts (facilitator + batcher + watcher),
                  relay.ts (fee relayer), ui/ (live dashboard)

demo/             testnet demo and checks; the agents here are scripted, not autonomous
examples/         a paid weather API, and four Claude agents that trade with each other
                  using the published npm package (llm-agents/)
docs/             the x402 scheme binding spec
```

<details>
<summary><b>Private entry setup (SPP CLI and circuits)</b></summary>

Scene 6 and `demo/check-private.ts` need the SPP CLI in `spp/bin/` and its circuits in `spp/circuits/`, both gitignored:

```bash
git clone https://github.com/NethermindEth/stellar-private-payments && cd stellar-private-payments
cargo build --release -p stellar-private-payments-cli   # copy target/release/spp to spp/bin/ (tested at 10ffa0e)
# circuits: the circuits-v0.4 tarball, unpacked into spp/circuits/
# spp/circuits/circuits.json holds the sha256 of every artifact
node demo/check-private.ts
```
</details>

---

## Private entry (SPP)

Vault balances are pseudonymous, but deposits are public: the chain shows which wallet funded which vault address. An agent that wants those unlinked enters through a [Stellar Private Payments](https://github.com/NethermindEth/stellar-private-payments) pool.

```
   W  (known wallet) --+
   W2 --------------+  |   1 deposit 10 each     +--------------+
   W3 ------------+ |  +-----------------------> |   SPP pool   |
                  | +------------------------->  |  (ours,      |
                  +--------------------------->  |   Groth16)   |
                                                 +------+-------+
              2 wait. the crowd is the anonymity set    |
                                                        | 3 withdraw 10 to a fresh
                                                        |   address. Source and fee
                                                        |   payer is the relayer,
                                                        v   so no wallet appears
                                                 +--------------+
                                                 |      F       |
                                                 | fresh address|
                                                 +------+-------+
                                                        | 4 account opened with 0 XLM
                                                        |   (relayer sponsors it)
                                                        | 5 join + deposit, fees
                                                        v   paid by the relayer
                                                 +--------------+
                                                 |    Vault     |
                                                 +--------------+
```

One call from the SDK:

```ts
import { SppCli, privateOnboard } from "rennpay";

const spp = new SppCli({ bin: "spp", circuits: "./circuits", deployment: "./spp-deployments.json", relayUrl: LEDGER });
const f = await privateOnboard({ spp, wallet: "my-keys-alias", amount: 100_000_000n, chain, ledgerUrl: LEDGER });
// f.agent pays over x402 like any agent. Store f.secret and f.seedHex.
```

The pool is ours: Nethermind's pool contract, the unchanged wasm, deployed for our token with a blocklist-only policy. The vault contract did not change at all, and the official SPP CLI is used unmodified, with proofs generated on the agent's own machine.

**The fresh address never pays a fee**, because if the wallet paid even one of them the chain would show the link. A relayer covers all of them and signs three shapes only: the SPP withdrawal (negative amount, itself as sender), a sponsorship for a new account, and a fee bump over the vault's `join`/`deposit` for the transaction's own source. `demo/check-private.ts` submits nine other shapes and the relayer refuses every one.

**What it hides:** which wallet funded the address. **What stays public:** amounts and timing, so use round amounts and leave time between deposit and withdrawal. **The anonymity set** is the pool's depositors. The relayer also sees request IPs, which is an off-chain link. SPP is unaudited and its trusted setup is a local test setup.

---

## Reference

<details>
<summary><b>x402 binding</b></summary>

The scheme implements x402 v2's `SchemeNetworkServer` and `SchemeNetworkClient`, so it plugs into `@x402/express`, `@x402/fetch` and `@x402/core` unchanged.

| Field | Value |
|---|---|
| `scheme` / `network` | `batch-settlement` / `stellar:testnet` |
| `amount` | Atomic units, 7 decimals (`"200000"` = 0.02) |
| `asset` | The vault's SEP-41 token |
| `payTo` | Any address. No account, no registration, no signature |
| `extra` | `hub`, `ledger`, `operator`, merged from the facilitator's `/supported` |
| `payload` | `{ type: "voucher", voucher: { payer, recipient, cumulative, signature } }` |

Facilitator: `GET /supported`, `POST /verify` (read-only), `POST /settle` (records the acceptance, returns `transaction: ""`). Also `GET /pair/:payer/:recipient` (the last accepted cumulative and both signatures, so a recipient can settle on its own) and `POST /withdraw`. The operator-only `/state`, `/feed`, `/flush`, `/track` and the dashboard refuse non-local requests unless `OPERATOR_ONLY=0`.

The binding is ours and is not upstream; the closest discussion is x402 issue #3341.
</details>

<details>
<summary><b>Signed payloads</b></summary>

Three payloads, domain-separated, byte-identical between `contracts/hub/src/voucher.rs` and `sdk/src/payload.ts`. The SDK's test compares against vectors frozen from the live contract.

```
voucher:  sha256( XDR( ScVal::Vec[ Symbol("batchv3"),  Bytes(network_id), Address(vault),
                                   Address(payer), Address(recipient), I128(cumulative) ] ) )

accept:   sha256( XDR( ScVal::Vec[ Symbol("acceptv1"), Bytes(network_id), Address(vault),
                                   Address(payer), Address(recipient), I128(cumulative) ] ) )

withdraw: sha256( XDR( ScVal::Vec[ Symbol("withdrv1"), Bytes(network_id), Address(vault),
                                   Address(who), I128(amount), U64(nonce), U32(valid_until) ] ) )
```

`network_id` is `sha256(network passphrase)`, and the vault address is in every payload, so a signature cannot be replayed on another network or another deployment. The domain separator keeps an operator's acceptance from being usable as a payer's voucher: the two carry identical fields otherwise.

Raw ed25519, not Soroban auth entries: an auth entry expires with `max_entry_ttl` and is consumed by one invocation, while a voucher is a standing statement replaced thousands of times.
</details>

<details>
<summary><b>The contract surface</b></summary>

`contracts/hub`: no admin, no upgrade, no pause.

| Function | Who | What |
|---|---|---|
| `join(who, commitment_key)` | The agent | Registers the ed25519 key its vouchers are signed with. Once, no rotation |
| `deposit(who, amount)` | The agent | Moves SEP-41 tokens in, credits the internal balance |
| `settle_one(recipient, voucher)` | Anyone with a two-signature voucher | Settles one pair without the operator |
| `settle_batch(vouchers)` | Anyone, the operator in practice | Verifies, skips stale, nets, applies |
| `withdraw_approved(who, amount, valid_until, op_sig)` | The owner | Instant withdrawal against the operator's approval, nonce-guarded |
| `exit_start(who)` | The owner | Opens the escape hatch; the ledger stops accepting that payer |
| `withdraw(who)` | The owner | After `exit_delay`, or any time for an address that never joined |
| `payout(who)` | Anyone | Pushes a recipient's balance to its own address |
| `balance_of`, `paid_between`, `signer_of`, `exit_at_of`, `withdraw_nonce_of`, `config` | Anyone | Reads |
| `preimage_*`, `verify_voucher` | Anyone | Payload bytes and verifier, exposed for off-chain comparison |

Storage: `Config`, `Signer(addr)`, `Balance(addr)`, `Paid(payer, recipient)`, `ExitAt(addr)`, `WithdrawNonce(addr)`.
</details>

<details>
<summary><b>The ledger's refusal rules</b></summary>

`operator/src/core.ts` is pure: no network, no clock, no crypto (signature verification is injected), because these are the rules that decide whether money exists.

| Refusal | Meaning |
|---|---|
| `not_joined` | The payer never registered a voucher key |
| `bad_signature` | Not signed by the registered key, for this vault and network |
| `self_payment` | Payer and recipient are the same |
| `exiting` | The payer opened the escape hatch and can no longer promise |
| `stale` | The cumulative is not above what the pair already accepted or settled |
| `underpaid` | The increase is smaller than the price asked |
| `insufficient_spendable` | The increase exceeds the payer's spendable balance |
| `bad_amount` | Non-positive or malformed |

Before answering `not_joined` or `insufficient_spendable` the ledger re-reads that one address from the chain and retries once, at most one read per address per 5 seconds. Without it, an agent that joins, deposits and pays within the same second would be refused because the watcher had not caught up.
</details>

<details>
<summary><b>State, recovery, ordering and RPC lag</b></summary>

**Persistence.** The ledger's durable state is an append-only log (`operator/ledger.log`): `accept`, `settled`, `reserve`/`release`, `known`/`label`, `cursor`. On restart it replays the log and refreshes from the chain, so a crash loses nothing that was promised. Replay is idempotent by sequence number, and `demo/restart-check.ts` verifies that the rebuilt state matches exactly.

**The watcher** polls Soroban RPC events every 4 seconds for join, deposit, settle, exit and withdrawal events, so the operator's view of balances is derived from the chain rather than from its own bookkeeping.

**Ordering.** Acceptance is strictly sequential: check and update happen in one synchronous step, so two vouchers can never both pass against the same balance. While a batch is unconfirmed the ledger does not apply chain reads that could contradict it, and a trigger settles only what existed when it fired. Withdrawal reservations leave the spendable balance immediately, so reserved money cannot be promised away.

**Lagging RPC nodes.** Testnet RPC is several nodes and a stale one can answer with a pre-batch balance. Two guards: the chain client keeps a monotonic read floor and retries any simulation answered from an older state, and in the core the settled amount for a pair never decreases (`reconcile_monotonic`).
</details>

<details>
<summary><b>When a batch closes</b></summary>

Whichever trigger fires first (`AUTO_SETTLE=1`, the default):

| Trigger | Default | Env | Why |
|---|---|---|---|
| Time | every 5 min if anything is unsettled | `ROUND_MS` | Cost against how long a recipient waits |
| Capacity | 150 unsettled distinct pairs | `MAX_PAIRS` | About 190 fit in one transaction |
| Total value | 1000 units unsettled | `MAX_UNSETTLED` | Bounds what depends on the operator at any moment |
| Recipient value | 100 units owed to one recipient | `MAX_RECIPIENT_UNSETTLED` | A large payment reaches the chain without waiting |
| Exit | a payer calls `exit_start` | always on | That payer's vouchers must settle first |

Each batch records its reason, visible in `/state` and on the dashboard. `demo/check-triggers.ts` verifies capacity, recipient and total on testnet. In demo mode (`AUTO_SETTLE=0`) batches come only from `/flush`, an exit, or a withdrawal of incoming money.

Other environment variables: `PORT`, `PUBLIC_URL`, `OPERATOR_ONLY`, `LEDGER_LOG`, `RELAY_MAX_FEE`, `RELAY_PER_HOUR`.
</details>

<details>
<summary><b>Measured limits and cost</b></summary>

From `LIMITS.md`, simulated on testnet with two `ed25519_verify` per voucher:

- **About 190 pairs per transaction.** The 400M instruction budget is the binding limit; the ledger uses 150 for headroom.
- **A pair is one row per batch** no matter how many payments it contains.
- **0.0009 XLM per pair per batch** for a pair settled before, 0.0189 XLM the first time (storage rent). A single x402 `exact` payment on mainnet costs about 0.0024 XLM.
- Steady state for 20 pairs paying continuously: about 52 XLM/day at a 30 s round, 5 XLM/day at 5 min, 0.4 XLM/day at 1 h.

Testnet only; mainnet is not measured.
</details>

<details>
<summary><b>What is verified</b></summary>

| Layer | How |
|---|---|
| Contract | 76 tests: signatures, domain separation, netting fixed point, stale vouchers, exit, withdrawal nonces, TTL |
| Payload equality | Vectors frozen from the live contract, compared byte for byte |
| Ledger rules | 24 tests including properties over random histories: every prefix is solvent, withdrawals never over-approve, settled amounts never go backwards. Both dangerous withdrawal mistakes are caught by mutation |
| Restart | `restart-check.ts`: state after a restart matches state before |
| x402 | `check-x402.ts`: wire format, refusals, replay, spend controls, foreign vault |
| Withdrawals | `check-withdraw.ts`: instant path, batch-waiting path, forged request, replay, operator endpoints closed from the network |
| Triggers | `check-triggers.ts`: capacity, recipient value, total value |
| Escape hatch | `check-exit.ts`: exit, refusal of new vouchers, withdrawal after the delay |
| Private entry | `check-private.ts`: no wallet address in the fresh address's transactions, 0 XLM, nine malformed relayer requests refused |
| The published package | Installed from npm into an empty project, joins the vault and pays over x402 |
</details>

<details>
<summary><b>Deployed addresses</b></summary>

| What | Address |
|---|---|
| Vault | [`CBIKFGMU…NJHLCCK`](https://stellar.expert/explorer/testnet/contract/CBIKFGMUUTJQ7PWRHHMH7TW4H3LFJS5HUFE6QHYZ2NDZ6ZZIPNJHLCCK) |
| Token (RTUSD, SEP-41 test token) | [`CBXCYC6Q…E2WA`](https://stellar.expert/explorer/testnet/contract/CBXCYC6QC2V2CTAE2U44LMYO2WBLIR7MU7K4YI737OKKQZAJJ4LFE2WA) |
| SPP pool (ours) | [`CAVLB3J4…Q2OW`](https://stellar.expert/explorer/testnet/contract/CAVLB3J4I5EPWAFWZ6O464DNPMK523TCNTSECN3XGLUNPGAXTYZ3Q2OW) |

All in `deployments.json`. Earlier vaults stay under `legacy_hubs` so old logs remain readable.
</details>

---

## Roadmap

- **Operator bond.** A bad acceptance is provable today but not compensated.
- **Key rotation.** `join` is once; a stolen voucher key means exiting and re-entering.
- **Several operators.** Ordering needs one place, so more than one means consensus between them and payments across vaults.
- **Automatic payout above a threshold**, so a recipient that never joins sees tokens without anyone pushing.
- **Mainnet and USDC.** The vault takes any SEP-41 token; the test token exists because Circle's testnet faucet has no API.
- **Upstream the x402 binding** (issue #3341).
- **Privacy inside the vault.** Entry is private today, payments inside are not.

## Honest notes

- **There is an operator, on purpose.** Ordering needs one place. It can censor and it can stop. It cannot steal and it cannot lock.
- **Recipients trust the operator on solvency.** If a bug accepts an unbacked voucher, the recipient bears the loss. It is provable, but nothing compensates it yet.
- **Entry can be private, payments inside are not.** The operator sees who pays whom, and settled pairs are visible on chain.
- **In escape mode netting can need ordering.** With the operator down, recipients settle one by one and in a cycle one may wait for another.
- **The x402 binding is not upstream.** It follows the v2 interfaces and runs with the official packages, but the Stellar binding is ours.
- **Testnet only, and no audit.** Hackathon code, written in two days.

MIT
