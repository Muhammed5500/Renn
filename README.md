# Renn

**Agents pay each other instantly. Nobody can spend more than they hold. The whole network settles in one transaction.**

A payment rail for agent-to-agent commerce on Stellar: a shared Soroban vault, off-chain cumulative vouchers, and many-to-many netting. It is a real [x402](https://github.com/coinbase/x402) v2 scheme (`batch-settlement` on `stellar:testnet`) that runs with the official x402 packages, so any agent or service already speaking x402 can use it.

| | |
|---|---|
| SDK | [`rennpay`](https://www.npmjs.com/package/rennpay) on npm, MIT |
| Network | Stellar testnet (Protocol 28, Soroban) |
| x402 | v2, scheme `batch-settlement`, flow `upfront`, spec in [`docs/`](docs/scheme_batch_settlement_stellar.md) |
| Built for | Rise In x Stellar Pro Hackathon, Istanbul, 19-20 September 2026 |
| Status | Working on testnet. Not audited, not on mainnet |

---

## Table of contents

- [Quickstart](#quickstart)
- [The problem](#the-problem)
- [The idea](#the-idea)
- [Architecture](#architecture)
  - [Components](#components)
  - [A payment, end to end](#a-payment-end-to-end)
  - [The ledger's rules](#the-ledgers-rules)
  - [Settlement: prefix batches and netting](#settlement-prefix-batches-and-netting)
  - [Signed payloads](#signed-payloads)
  - [The contract](#the-contract)
  - [State, persistence and recovery](#state-persistence-and-recovery)
  - [Concurrency and ordering](#concurrency-and-ordering)
  - [Chain reads under a lagging RPC](#chain-reads-under-a-lagging-rpc)
- [Getting money in and out](#getting-money-in-and-out)
- [Private entry (SPP)](#private-entry-spp)
- [x402 binding](#x402-binding)
- [When a batch closes](#when-a-batch-closes)
- [Trust model](#trust-model)
- [Measured limits and cost](#measured-limits-and-cost)
- [Demo](#demo)
- [Repository layout](#repository-layout)
- [Run it](#run-it)
- [What is verified](#what-is-verified)
- [Deployed addresses](#deployed-addresses)
- [Roadmap](#roadmap)
- [Honest notes](#honest-notes)

---

## Quickstart

```bash
npm install rennpay
```

**Pay for a service.** Nothing here is Renn-specific except the scheme registration: the rest is stock x402.

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
const res = await pay("https://service.example/weather");    // 402, sign, retry, served
```

**Sell a service.**

```ts
import { BatchSettlementStellarServer } from "rennpay";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER }))
  .register("stellar:testnet", new BatchSettlementStellarServer({ asset: TOKEN }));

app.use(paymentMiddleware({ "GET /weather": { accepts: {
  scheme: "batch-settlement", network: "stellar:testnet", payTo: MY_ADDRESS, price: "0.02" } } }, server));
```

**Join the vault once** (the payer side only; a seller needs no account and no registration):

```ts
import { A } from "rennpay/chain";
await chain.invoke(keypair, "join", [A.addr(MY_ADDRESS), A.bytes(agent.commitmentKey)]);
await chain.invoke(keypair, "deposit", [A.addr(MY_ADDRESS), A.i128(100_000_000n)]);
```

---

## The problem

In an agent economy every agent is both a payer and a payee, and the payments are small and constant. Today's rails give two options:

- **Pay on chain every time** (x402 `exact`). Every call is its own transaction and waits for a ledger close, about 5 seconds. Fees dominate a $0.02 call.
- **Open a payment channel.** Channels are one-to-one. Every counterparty needs its own escrow and its own locked capital, and an agent that talks to fifty services needs fifty channels.

Signing vouchers off chain avoids both, and creates a third problem: **nobody can see a payer's total commitments.** A payer holding 20 can sign a voucher for 20 to B and another for 20 to C. Both check the chain, both see 20 backing the promise, both deliver. One of them is left with a bounced cheque.

That is the problem this rail solves, and it is the reason the design has an operator.

**Renn is neither of the two.** It is not a channel: there is no escrow per relationship and no capital locked against one partner. It is **one shared vault**. An agent deposits once and can pay anyone who uses the same vault, including agents it has never met, and money it receives is spendable immediately, against anyone.

| | On chain per call | Payment channel | Renn |
|---|---|---|---|
| Capital | Nothing locked | Locked per counterparty | One deposit, usable against everyone |
| New counterparty | Nothing to do | A new channel, funded and opened | Nothing to do |
| Cost per payment | One transaction | Amortised over open and close | A share of one batch transaction |
| Time to serve | About 5 s | Instant | Instant |
| Money received | Usable after the transaction | Usable inside that channel | Spendable immediately, anywhere in the vault |
| Who can be paid | Anyone | Only the channel's other side | Any address, even one that never joined |

## The idea

Track the **spendable balance** off chain, in one ordered public ledger, and make the contract refuse any voucher that ledger has not accepted.

```
spendable(x) = on-chain balance
             - reserved withdrawals
             + unsettled incoming          (vouchers others signed to x)
             - unsettled outgoing          (vouchers x signed to others)
```

Five consequences, and they are the whole design:

1. **A voucher is accepted only if the payer's spendable balance covers it**, and the check happens *before* the service is delivered. A bounced cheque is not detected late; it never exists.
2. **Incoming money counts immediately.** The same 10 units can circulate all day. A→B→C→A closes without anyone topping up.
3. **Every accepted voucher carries two signatures**, the payer's and the operator's. The contract verifies both, so an agent cannot settle a voucher the ledger never accepted, and the operator cannot forge one.
4. **Batches are prefixes of the acceptance order.** Every prefix is solvent by construction, so on-chain netting never has to drop a payer.
5. **Settlement moves internal balances only.** The vault's token balance does not change when a batch lands. Tokens move when someone deposits or withdraws, not when debts net out.

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

### Components

| Component | Runs where | Responsibility | Can it move money? |
|---|---|---|---|
| **Vault** (`contracts/hub`, Soroban) | Stellar | Holds deposits, verifies both signatures on every voucher, nets batches, pays withdrawals, enforces the escape hatch | It *is* the money. Only the owner's signature moves it out |
| **Ledger / operator** (`operator/`) | One server | Orders vouchers, checks the spendable balance, co-signs acceptances, sends batches, approves withdrawals, serves the x402 facilitator API | No. It can refuse and it can stop |
| **SDK** (`sdk/` → npm `rennpay`) | Every agent and every paid service | Voucher signing, x402 client and server scheme, vault calls, private entry | Only with the agent's own key |
| **Relayer** (`operator/src/relay.ts`) | With the operator, separate key | Pays fees for a fresh address during private entry | No. It signs three narrow transaction shapes, none of which transfers tokens |
| **Dashboard** (`operator/ui`) | Operator, local only | Live view of vouchers, netting, batches and balances | No |

The split matters: an agent installs the SDK and nothing else. The operator's code is a separate package and never ships to agents.

### A payment, end to end

This is x402's `upfront` flow. Steps 1, 2, 6 and 7 are stock x402; steps 3 to 5 are where this scheme differs.

1. **Agent calls a paid endpoint.** Plain `fetch`, wrapped by `@x402/fetch`.
2. **Service answers 402** with `PAYMENT-REQUIRED`: price, asset, `payTo`, and in `extra` the vault address, the ledger URL and the operator's public key. The agent needs no prior knowledge of the vault: the 402 is the introduction.
3. **Agent signs a cumulative voucher.** It reads the last accepted cumulative for this (payer, recipient) pair from the ledger (`GET /pair/:payer/:recipient`), adds the price, and signs `sha256(XDR(...))` with its registered ed25519 key. The request is retried with `PAYMENT-SIGNATURE`.
4. **The service's middleware calls the facilitator** (`POST /settle`) before running the handler. This is the operator.
5. **The ledger decides, in one synchronous step.** Registered? Not exiting? Signature valid? Cumulative strictly increasing? Increase at least the price? Increase within the payer's spendable balance? If yes it appends the voucher to its order, co-signs the acceptance, and answers `success: true, transaction: ""`. Value has not moved yet, and the scheme allows that.
6. **The service runs the handler** and answers 200 with `PAYMENT-RESPONSE`. If the facilitator refused, the handler never runs and the agent gets a 402 carrying `errorReason`.
7. **Later, a batch settles many payments at once**, with one transaction.

What the recipient holds after step 5 is a **claim with two signatures** on it: the payer's and the operator's. That claim is enforceable on chain without the operator's help (`settle_one`), which is what makes waiting for the batch safe.

### The ledger's rules

`operator/src/core.ts` is pure: no network, no clock, no crypto (signature verification is injected). That is deliberate, because these are the rules that decide whether money exists, and they are the part that must be testable exhaustively.

A voucher is refused with exactly one of:

| Refusal | Meaning |
|---|---|
| `not_joined` | The payer never registered a voucher key in the vault |
| `bad_signature` | Not signed by the payer's registered key, for this vault and this network |
| `self_payment` | Payer and recipient are the same address |
| `exiting` | The payer has started the escape hatch; it can no longer promise |
| `stale` | The cumulative is not above what the pair already settled or accepted (a replay) |
| `underpaid` | The increase is smaller than the price the service asked for |
| `insufficient_spendable` | The increase exceeds the payer's spendable balance |
| `bad_amount` | Non-positive or malformed |

Before answering `not_joined` or `insufficient_spendable`, the ledger re-reads that one address from the chain and retries once, at most one read per address per 5 seconds. Without it, an agent that joins, deposits and pays within the same second would be refused because the chain watcher had not caught up yet.

**Cumulative, not incremental.** A voucher says "I have committed 4.20 in total to you", not "here is 0.02". A lost voucher costs nothing, a replayed voucher is a no-op, and only the newest voucher per pair ever has to be settled. This is why 600 payments between 5 payers and 25 services settle as at most 125 rows.

### Settlement: prefix batches and netting

The operator periodically cuts a **prefix of its acceptance order** and sends it to `settle_batch`, one voucher per pair (the latest within the prefix).

```
acceptance order:  v1  v2  v3  v4  v5  v6  v7  v8 │ v9  v10   ← still open
                   └──────── batch prefix ───────┘
```

On chain, `settle_batch`:

1. Verifies the payer's signature and the operator's acceptance signature for every voucher. A bad signature reverts the whole batch.
2. Skips vouchers whose cumulative is not above what that pair already settled, for example because the recipient settled it itself. Stale vouchers do not revert the batch.
3. Computes each pair's delta, nets all positions, and applies them to internal balances with a fixed-point loop that would drop an insolvent payer.
4. Moves no tokens.

Step 3's loop can drop a payer in theory, and in practice it never does: every accepted voucher was checked against every earlier acceptance, so **every prefix is solvent**. That property is the reason batches are prefixes and not arbitrary selections, and it is tested as a property on random histories (`prefix_property`, `prefix_property_with_batches`).

Netting is what makes the demo's circular-debt scene work: 270 payments around A→B→C→A become one transaction in which the vault's token balance does not move at all.

### Signed payloads

Three payloads, each domain-separated, each byte-identical between the contract (`contracts/hub/src/voucher.rs`) and the SDK (`sdk/src/payload.ts`). The SDK's test compares against vectors frozen from the live contract.

```
voucher:  sha256( XDR( ScVal::Vec[ Symbol("batchv3"),  Bytes(network_id), Address(vault),
                                   Address(payer), Address(recipient), I128(cumulative) ] ) )

accept:   sha256( XDR( ScVal::Vec[ Symbol("acceptv1"), Bytes(network_id), Address(vault),
                                   Address(payer), Address(recipient), I128(cumulative) ] ) )

withdraw: sha256( XDR( ScVal::Vec[ Symbol("withdrv1"), Bytes(network_id), Address(vault),
                                   Address(who), I128(amount), U64(nonce), U32(valid_until) ] ) )
```

`network_id` is `sha256(network passphrase)`, so a signature cannot be replayed on another network, and the vault address stops replay against another deployment. The domain separator is what keeps an operator's acceptance from being usable as a payer's voucher: the two payloads carry identical fields otherwise, and the contract tests check exactly that.

Raw ed25519 signatures, not Soroban authorization entries, because an auth entry expires with the network's `max_entry_ttl` and is consumed by one invocation, while a voucher is a standing statement that gets replaced thousands of times.

### The contract

`contracts/hub`, no admin, no upgrade, no pause.

| Function | Who calls it | What it does |
|---|---|---|
| `join(who, commitment_key)` | The agent | Registers the ed25519 key its vouchers will be signed with. Once, never rotated |
| `deposit(who, amount)` | The agent | Moves SEP-41 tokens into the vault, credits the internal balance |
| `settle_one(recipient, voucher)` | Anyone holding a two-signature voucher | Settles a single pair without the operator |
| `settle_batch(vouchers)` | Anyone (the operator in practice) | Verifies, skips stale, nets, applies |
| `withdraw_approved(who, amount, valid_until, op_sig)` | The owner | Instant withdrawal with the operator's signed approval, guarded by a nonce |
| `exit_start(who)` | The owner | Opens the escape hatch. The ledger stops accepting this payer's vouchers |
| `withdraw(who)` | The owner | After `exit_delay`, or at any time for an address that never joined |
| `payout(who)` | Anyone | Pushes a recipient's balance to its own address. Permissionless |
| `balance_of`, `paid_between`, `signer_of`, `exit_at_of`, `withdraw_nonce_of`, `config` | Anyone | Reads |
| `preimage_*`, `verify_voucher` | Anyone | The payload bytes and the verifier, exposed so off-chain code can be compared against them |

Storage: `Config`, `Signer(addr)`, `Balance(addr)`, `Paid(payer, recipient)`, `ExitAt(addr)`, `WithdrawNonce(addr)`.

### State, persistence and recovery

The ledger's durable state is an **append-only log** (`operator/ledger.log`), one JSON record per line:

| Record | Written when |
|---|---|
| `accept` | A voucher is accepted (payer signature, operator signature, sequence number) |
| `settled` | A batch landed on chain |
| `reserve` / `release` | A withdrawal reserves money, or the reservation expires |
| `known` / `label` | An address becomes known to the ledger (for the dashboard) |
| `cursor` | How far the chain event watcher has read |

On restart the ledger replays the log, then refreshes from the chain, so an operator crash loses nothing that was promised. Acceptance is idempotent on replay (by sequence number), and `restart-check.ts` verifies that the rebuilt state matches the pre-restart state exactly.

The chain watcher polls Soroban RPC events every 4 seconds for `join`, `deposit`, `settled`, `exit` and withdrawal events, and refreshes the addresses involved. The operator's own view of balances is therefore derived from the chain, not from its own bookkeeping.

### Concurrency and ordering

- **Acceptance is strictly sequential.** Check and update happen in one synchronous step, so two vouchers can never both pass against the same balance. This is the whole reason the rail needs a single ordering point.
- **A batch in flight blocks reconciliation.** While `settle_batch` is unconfirmed, the ledger does not apply chain reads that could contradict it.
- **A trigger settles only what existed when it fired.** Vouchers accepted while a batch is in flight wait for their own trigger, which keeps a busy rail from sending overlapping batches forever.
- **Withdrawal reservations** take money out of the spendable balance the moment they are approved, so the same funds cannot be promised away between approval and the on-chain withdrawal.

### Chain reads under a lagging RPC

Testnet RPC is several nodes. A node that is behind can answer with a balance from before a batch or a withdrawal, which would make the ledger believe a payer has more money than it does. Two guards:

- **A monotonic read floor.** The chain client remembers the highest ledger it has seen and rejects any simulation answered from an older state, then retries.
- **Monotonic settled amounts.** In the core, the settled amount for a pair never decreases; a smaller reading is treated as stale and ignored (`reconcile_monotonic`).

---

## Getting money in and out

| Situation | Path | Waiting |
|---|---|---|
| Deposit | `deposit` | One transaction, about 5 s |
| Withdraw what you hold | `POST /withdraw` (signed request, nonce) → `withdraw_approved` | Instant, no batch |
| Withdraw money still incoming | Same, but the approval waits for the next regular batch | One batch |
| Operator refuses or is down | `exit_start`, wait `exit_delay`, `withdraw` | The exit delay (60 ledgers on testnet) |
| You are a recipient who never joined | `withdraw` at any time, or anyone calls `payout` | One transaction |

The withdrawal rule in one line:

```
withdrawable now = on-chain balance - unsettled vouchers you signed - existing reservations
```

Up to that amount the operator signs immediately and **no batch is sent**; a withdrawal never costs the rail an extra settlement transaction. Beyond it, the part that consists of money others still owe you waits for the regular batch. The two dangerous mistakes here (counting incoming money as withdrawable, ignoring vouchers you signed) are both caught by a property test over random histories (`withdrawal_property`).

The withdrawal request is signed by the agent's voucher key over `gd-withdraw-request | network | vault | who | amount | nonce`, so the operator cannot be tricked into approving a withdrawal nobody asked for, and a captured request cannot be replayed (the nonce lives in the contract).

---

## Private entry (SPP)

Vault balances are pseudonymous, but deposits are public: the chain shows which wallet funded which vault address. An agent that wants its vault address unlinked from its known wallet enters through a [Stellar Private Payments](https://github.com/NethermindEth/stellar-private-payments) pool.

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

- **The pool is ours**: Nethermind's pool contract, the unchanged wasm, deployed for our token with a blocklist-only policy, sharing SPP's testnet verifier and ASP contracts. The vault contract did not change at all.
- **The official SPP CLI, unchanged.** Groth16 proofs are generated on the agent's own machine.
- **The fresh address never pays a fee.** If W paid even one of F's fees, the chain would show W → F. A relayer (operator-run, own key) covers all of them:

| Endpoint | What the relayer signs | Guard |
|---|---|---|
| `POST /relay/spp-sign` | The SPP withdrawal, as source and fee payer | Only our pool's `transact`, sender is the relayer, amount negative (a withdrawal, never a deposit), fee under a cap, no extra sub-invocations |
| `POST /relay/account` | `BeginSponsoring` + `CreateAccount(0 XLM)` + `EndSponsoring` | The account must not exist yet; F co-signs its own part |
| `POST /relay/fee-bump` | A fee bump over F's own transaction | Only the vault's `join` or `deposit`, and only for the transaction's own source |

The CLI reaches the remote relayer through `sdk/spp-shim`, a stand-in for the `stellar` binary that answers for exactly one alias (`gd-relay`) and passes every other call to the real CLI. So the agent's key never leaves its machine, and the relayer's key never reaches the agent.

From the SDK it is one call:

```ts
import { SppCli, privateOnboard } from "rennpay";

const spp = new SppCli({ bin: "spp", circuits: "./circuits", deployment: "./spp-deployments.json", relayUrl: LEDGER });
const f = await privateOnboard({ spp, wallet: "my-keys-alias", amount: 100_000_000n, chain, ledgerUrl: LEDGER });
// f.agent pays over x402 like any agent. Store f.secret and f.seedHex.
```

With `deposit: false` an earlier deposit is used instead, which is the better practice: time between the deposit and the withdrawal is what hides the link.

**What it hides:** which wallet funded the address. **What stays public:** the amounts and the timing, so use round amounts and wait. **The anonymity set** is the pool's depositors, and with three depositors it is three. The relayer also sees request IPs, which is an off-chain link. SPP is unaudited and its trusted setup is a local test setup.

`demo/check-private.ts` proves the on-chain part: three wallets deposit, one withdraws to F, and a byte scan of the withdrawal and of F's three transactions finds none of the three wallets. It then submits nine malformed transactions to the relayer, and the relayer refuses all of them.

---

## x402 binding

The scheme implements x402 v2's `SchemeNetworkServer` and `SchemeNetworkClient` interfaces, so it plugs into `@x402/express`, `@x402/fetch` and `@x402/core` unchanged.

| Field | Value |
|---|---|
| `scheme` | `batch-settlement` |
| `network` | `stellar:testnet` |
| `amount` | Atomic units, 7 decimals (`"200000"` = 0.02) |
| `asset` | The vault's SEP-41 token |
| `payTo` | Any address. No account, no registration, no signature |
| `extra.hub` / `extra.ledger` / `extra.operator` | Vault, facilitator URL, operator public key, merged from the facilitator's `/supported` |
| `payload` | `{ type: "voucher", voucher: { payer, recipient, cumulative, signature } }` |

Facilitator API: `GET /supported`, `POST /verify` (read-only), `POST /settle` (records the acceptance, returns `transaction: ""`). Supporting endpoints: `GET /pair/:payer/:recipient` (the last accepted cumulative and both signatures, which is how a recipient can settle on its own), `POST /withdraw`, and the operator-only `/state`, `/feed`, `/flush`, `/track` and dashboard, which refuse non-local requests unless `OPERATOR_ONLY=0`.

`demo/check-x402.ts` checks the wire format, the refusal paths, replay, and the client's own spend controls against testnet.

The binding is ours and has not been submitted upstream; the closest upstream discussion is x402 issue #3341, "Stellar has no `batch-settlement` binding".

---

## When a batch closes

The ledger sends a batch on whichever trigger fires first (`AUTO_SETTLE=1`, the default):

| Trigger | Default | Env | Why |
|---|---|---|---|
| Time | every 5 min if anything is unsettled | `ROUND_MS` | Cost against how long a recipient waits to withdraw externally |
| Capacity | 150 unsettled distinct pairs | `MAX_PAIRS` | About 190 pairs fit in one transaction; also the per-batch cap |
| Total value | 1000 units unsettled | `MAX_UNSETTLED` | Bounds how much value depends on the operator at any moment |
| Recipient value | 100 units owed to one recipient | `MAX_RECIPIENT_UNSETTLED` | A large payment reaches the chain without waiting |
| Exit | a payer calls `exit_start` | always on | That payer's vouchers must settle before the hatch opens |

Each batch records its reason, visible in `/state` and on the dashboard. `demo/check-triggers.ts` verifies the capacity, recipient and total triggers on testnet. In demo mode (`AUTO_SETTLE=0`) batches are sent only by `/flush`, by an exit, and by a withdrawal of money that is still incoming.

---

## Trust model

| The operator CAN | The operator CANNOT |
|---|---|
| Refuse to accept vouchers (censor) | Forge a voucher: it needs the payer's key |
| Refuse to approve a withdrawal | Take anyone's money: withdrawals need the owner's signature and go to the owner's address |
| Go offline | Lock funds: `exit_start` works without it |
| Accept an unbacked voucher through a bug, and the recipient bears that loss | Claw back money a recipient has received |
| See who pays whom | Change the rules: the contract verifies both signatures itself |

**The operator cannot touch your money. The worst it can do is stop, and then you withdraw yourself.**

Agent safety, meaning a compromised or misled agent spending money it legitimately holds, is the wallet's problem and not the rail's. The rail guarantees one thing: nobody spends money they do not have. Spending policy belongs in the x402 client's `spendControls`, which every agent sets for itself.

---

## Measured limits and cost

From `LIMITS.md`, simulated on testnet with two `ed25519_verify` per voucher:

- **About 190 pairs per transaction.** The 400M instruction budget is the binding limit; the ledger uses 150 for headroom.
- **A pair is one row per batch** no matter how many payments it contains. 600 payments between 5 payers and 25 services is at most 125 rows.
- **0.0009 XLM per pair per batch** for a pair that has been settled before, 0.0189 XLM the first time (storage rent for a new pair). A single x402 `exact` payment on mainnet costs about 0.0024 XLM.
- Rough steady-state cost for 20 pairs paying each other continuously: about 52 XLM/day at a 30 s round, 5 XLM/day at 5 min, 0.4 XLM/day at 1 h.

Testnet measurements. Mainnet is not measured.

---

## Demo

`node demo/demo.ts` runs seven scenes on testnet. Every payment in every scene is a full x402 round trip through the official packages; nothing is mocked and no voucher is posted to the ledger directly.

| Scene | What happens | Result |
|---|---|---|
| 0. Vaults | Five agents, their balances and spendable amounts | Nobody can spend more than they hold |
| 1. Circular debt | A holds 20. A→B 100, B→C 90, C→A 80, in small alternating payments | 270 payments, **1 transaction**, vault token balance unchanged. [tx](https://stellar.expert/explorer/testnet/tx/d61993088b75e34baa118a102b95fe952310499d5b5a46ae2986105a7fefb210) |
| 2. Scale | 5 payers, 25 services, 600 payments | 600 x402 payments in a few seconds over local HTTP, **1 transaction**. [tx](https://stellar.expert/explorer/testnet/tx/41f0fe62e3370e7ba1bc007144b5a478497b82e46bbeefc694ef9bae7d6e3d4d) |
| 3. Bounced cheque | An empty payer tries to pay; a payer tries to promise the same 10 twice | Both refused instantly with `insufficient_spendable` |
| 4. Withdrawal | An agent with 50 pays 3, then withdraws 20 | Approved instantly, **no batch**, tokens in the wallet in seconds. [tx](https://stellar.expert/explorer/testnet/tx/d403dbcc366ec35f1e5169b8aedb30673881b53510764eb473458339b254e5f6) |
| 5. Operator down | A recipient settles its own voucher without the ledger; a payer opens the escape hatch | [settle_one](https://stellar.expert/explorer/testnet/tx/bde1f1dadc08c4ff4a5d27204b450b7c4ef577b9efe16f2009b437e048ae4814), [exit_start](https://stellar.expert/explorer/testnet/tx/0d1ee7595d0a267b0764fdc0856113080227dd1092509467a9961cccd2e0d725) |
| 6. Private entry | Three wallets deposit into the SPP pool; one enters the vault as a fresh address and pays | No wallet address in any of the fresh address's transactions. [withdrawal](https://stellar.expert/explorer/testnet/tx/de3c7df89ed6928afc1e11a563ce050f33e0913ca281897e89151c8c2784942a) |

`examples/x402-weather.ts` is the smallest complete picture: a weather API behind `@x402/express`, called ten times by an agent using `@x402/fetch`. Zero on-chain transactions per call. The service never created an account and never signed anything, and it was paid by a permissionless `payout` after one batch.

The dashboard at `http://localhost:8787` shows the same thing live: the voucher stream, the netting panel, the batch reasons, and the vault's token balance staying still while hundreds of payments clear.

---

## Repository layout

Three packages in one npm workspace. An agent or a paid service needs only the SDK; the operator's code is separate and never ships to agents.

```
contracts/hub          Soroban vault: join, deposit, settle_one, settle_batch, withdrawals, exit
contracts/token        SEP-41 test token (Circle's testnet faucet has no API)

sdk/                   rennpay on npm: what agents and services use
  src/agent.ts           the voucher key; keeps cumulative amounts in step with the ledger
  src/x402.ts            the scheme: BatchSettlementStellarClient (payer), …Server (seller)
  src/payload.ts         the three signed payloads, byte-identical to the contract
  src/chain.ts           vault calls and reads over Soroban RPC, with the monotonic read floor
  src/private.ts         privateOnboard() in one call, sponsored account, fee-bumped join/deposit
  src/spp.ts             SppCli: the official SPP CLI, with safe retries
  spp-shim/              `stellar` stand-in so the stock SPP CLI can use the remote relayer

operator/              the ledger. Only the operator runs this
  src/core.ts            the rules. Pure: no network, no clock, no crypto
  src/server.ts          x402 facilitator + batcher + chain watcher + withdrawal approvals
  src/relay.ts           the fee relayer for private entry
  ui/index.html          live dashboard (GET /), fed by /feed and /state

demo/                  testnet demo and checks. The agents here are scripted, not autonomous
examples/              a paid weather API and an agent paying it
spp/deployments.json   our SPP pool, in the SPP CLI's deployment format
docs/                  the x402 scheme binding spec
```

---

## Run it

Requirements: Rust with `wasm32v1-none`, the `stellar` CLI, Node 23.6+. The operator and the demo run TypeScript directly; only the SDK is compiled, and the npm scripts below do that for you.

```bash
cargo test                      # 76 vault tests + 5 token tests
stellar contract build

npm install                     # workspace: sdk, operator, demo
npm test                        # builds the SDK, then 29 tests (sdk 5, operator 24)

AUTO_SETTLE=0 npm start         # ledger on :8787; needs .env (below)
npm run demo                    # scenes 0-6 on testnet
node demo/check-x402.ts         # x402 v2 wire format, refusals, replay, spend controls
# dashboard: http://localhost:8787
```

`npm run build` compiles the SDK on its own; the demo and check scripts import the built package, so run it once after changing `sdk/`.

`.env` at the repo root, never committed:

```
OPERATOR_SEED=<32-byte hex>     # the operator's voucher-acceptance key
RELAYER_SECRET=<S…>             # optional: enables the /relay endpoints for private entry
```

Environment variables: `PORT`, `ROUND_MS`, `MAX_PAIRS`, `MAX_UNSETTLED`, `MAX_RECIPIENT_UNSETTLED`, `AUTO_SETTLE`, `PUBLIC_URL`, `OPERATOR_ONLY`, `LEDGER_LOG`, `RELAY_MAX_FEE`, `RELAY_PER_HOUR`.

Private entry (scene 6 and `check-private.ts`) needs the SPP CLI in `spp/bin/` and its circuits in `spp/circuits/`, both gitignored:

```bash
git clone https://github.com/NethermindEth/stellar-private-payments && cd stellar-private-payments
cargo build --release -p stellar-private-payments-cli    # copy target/release/spp to spp/bin/ (tested at 10ffa0e)
# circuits: the circuits-v0.4 tarball, unpacked into spp/circuits/
# spp/circuits/circuits.json holds the sha256 of every artifact
node demo/check-private.ts
```

---

## What is verified

| Layer | How |
|---|---|
| Contract | 76 tests: signatures, domain separation, netting fixed point, stale vouchers, exit, withdrawal nonces, TTL |
| Payload equality | Vectors frozen from the live contract; the SDK is compared byte for byte |
| Ledger rules | 24 tests including property tests over random histories: every prefix is solvent, withdrawals never over-approve, settled amounts never go backwards. Both dangerous withdrawal mistakes are caught by mutation |
| Restart | `restart-check.ts`: state after a restart matches state before it |
| x402 | `check-x402.ts`: wire format, refusal paths, replay, spend controls, foreign vault rejection |
| Withdrawals | `check-withdraw.ts`: instant path, batch-waiting path, forged request, replayed request, operator endpoints closed from the network |
| Triggers | `check-triggers.ts`: capacity, recipient value, total value |
| Escape hatch | `check-exit.ts`: exit, refusal of new vouchers, withdrawal after the delay |
| Private entry | `check-private.ts`: no wallet address in any of the fresh address's transactions, 0 XLM, relayer refuses nine malformed shapes |
| The published package | Installed from npm into an empty project, joins the vault and pays a service over x402 |

---

## Deployed addresses

Testnet, from `deployments.json`:

| What | Address |
|---|---|
| Vault | [`CA73IV5D…I76IGJ`](https://stellar.expert/explorer/testnet/contract/CA73IV5DC37ERBOQ4UIB7L7D67TFPC5JABZJT45FDDMXNPLFAFI76IGJ) |
| Token (RTUSD, SEP-41 test token) | [`CBXCYC6Q…E2WA`](https://stellar.expert/explorer/testnet/contract/CBXCYC6QC2V2CTAE2U44LMYO2WBLIR7MU7K4YI737OKKQZAJJ4LFE2WA) |
| SPP pool (ours) | [`CAVLB3J4…Q2OW`](https://stellar.expert/explorer/testnet/contract/CAVLB3J4I5EPWAFWZ6O464DNPMK523TCNTSECN3XGLUNPGAXTYZ3Q2OW) |

Earlier vaults are kept under `legacy_hubs` so old logs stay readable.

---

## Roadmap

- **Operator bond.** Today a bad acceptance is provable but not compensated. A bonded operator would make it payable.
- **Key rotation.** `join` is once. A stolen voucher key means exiting and re-entering with a new address.
- **Several operators.** Ordering needs one place, so more than one means a consensus protocol between them, and a way to pay across vaults.
- **Automatic payout above a threshold**, so a recipient that never joins still sees tokens in its own wallet without anyone pushing.
- **Mainnet and USDC.** The vault takes any SEP-41 token; the test token exists because Circle's testnet faucet has no API.
- **Upstream the x402 binding** (issue #3341).
- **Privacy inside the vault.** Entry is private today; payments inside are not.

---

## Honest notes

- **There is an operator, on purpose.** Ordering needs one place. It can censor and it can go down. It cannot steal and it cannot lock.
- **Recipients trust the operator on solvency.** If it accepts an unbacked voucher through a bug, the recipient bears the loss. The ledger is public and every voucher is signed, so the mistake is provable, but nothing compensates it yet.
- **Entry can be private, payments inside are not.** The operator sees who pays whom, and settled pairs are visible on chain.
- **In escape mode netting can need ordering.** With the operator down, recipients settle one by one, and in a cycle one may have to wait for another.
- **The x402 binding is not upstream.** It follows the v2 interfaces and runs with the official packages, but the Stellar `batch-settlement` binding is ours.
- **Testnet only, and no audit.** This is hackathon code, written in two days.

MIT
