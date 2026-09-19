# Deliberate simplifications and known limits

Plan: `../PLAN-renn.md` (outside the repo) v3.3, §10.

## Left out of scope

| Topic | Status | Why |
|---|---|---|
| Mechanical dispute / reversal | Removed (existed in v3.2) | The ledger never accepts an unbacked voucher in the first place. A backed payment that its owner did not want is a problem for the agent and its wallet (see the scope row). |
| Operator bond | None | An operator mistake is provable (the ledger is public, vouchers are signed), but nothing compensates it. Roadmap. |
| One operator signature per batch | None | Today every voucher carries its own acceptance signature (two `ed25519_verify` per voucher). The limit is 190 pairs, which is enough. First improvement if needed. |
| More than one operator | None | Ordering needs one place. Several operators means a consensus protocol. |
| Key rotation | None | `join` is one-time. If a hot voucher key is stolen, the participant has to leave with `exit_start` and come back with a new address. |
| Scope / caps (allowlist, recipient and round caps, expiry) | Removed (v3.3.1) | An agent being tricked or having its key stolen is the wallet's job, not the payment rail's. The rail only guarantees that money that isn't there cannot be spent. Spending policy is also a crowded space already. |
| Privacy inside the ledger | None | Entry can be private (SPP, README "Private entry"). Inside the vault the operator sees who pays whom, and settled pairs are visible on chain. Kaan (SDF): the off-chain part does not need to be wrapped in a privacy layer. |

## Note carried over from v3.2

The v3.2 test `test_guarantee_and_circular_netting_are_exclusive` showed that
an on-chain solvency invariant (sum of caps ≤ balance) cannot hold together
with circular netting. With 20, A cannot give B a cap of 100, yet Scene 1
needs exactly that. This is where v3.3 starts: track solvency with the
spendable balance in the ledger, not with caps on chain. Incoming money counts
immediately, so circular debt works, and prefix batches mean nobody is dropped
on chain.

## Known limits

- **Ordering in the escape hatch.** If the operator goes down, recipients
  settle their vouchers one by one with `settle_one`. In circular debt one of
  them may have to wait for another to settle first (`InsufficientBalance`,
  then retry).
- **The operator must settle within `exit_delay`.** When a payer calls
  `exit_start`, the ledger stops accepting it and sends a batch right away. If
  the ledger stays down for `exit_delay` (demo: 60 ledgers), the payer can
  withdraw, and its unsettled vouchers are then unbacked.
- **Withdrawal reservations.** If the ledger restarts, unexpired reservations
  are restored from the log. Expired ones are released.
- **RPC event retention.** Testnet RPC keeps events for a limited time. The
  ledger writes its event cursor to the log. If it stays down for long, the
  addresses behind the missed events have to be refreshed from chain
  (`POST /track`).
- **Fee measurements are testnet.** Not measured on mainnet (`LIMITS.md`).
- **Lagging RPC node.** Testnet RPC is several nodes. After a batch or a
  withdrawal, a lagging node could return an old balance and the ledger could
  overestimate a payer's money. Guard: the chain client keeps the highest
  ledger it has seen as a floor and rejects and retries a simulation that
  reads an older state. In the core, the amount paid on chain never goes back
  down (`reconcile_monotonic` test). This guard never fired in the tests, so
  how often the problem happens was not measured.
- **A batch trigger sends only what was accepted before it fired.** Vouchers
  arriving while a batch is in flight wait for their own trigger. Before this,
  the loop also picked up the new vouchers and could keep sending batches
  under heavy traffic.
- **SPP deposits one at a time.** Two deposits into the same pool at the same
  time are built against the same tree state, so one of them is rejected on
  chain (seen when tried in parallel). The scripts deposit one at a time.
- **One relayer account.** In the SPP withdrawal the relayer is the source and
  uses its sequence number. If an account-opening request arrives at the same
  moment, one of them fails on the sequence number and has to be retried.
  Fee-bump does not use a sequence number.
- **The relayer sees IPs.** A withdrawal signature request and an
  account-opening request from the same IP can be linked off chain. The link
  on chain stays broken.
- **The SPP pool is ours, the verifier and ASP are shared.** The pool contract
  is SPP's official wasm (hash ff8743f9…), deployed for our token with a
  blocklist-only policy. Nobody needs to be added to the ASP membership tree.
  The verifier and ASP contracts are SPP's testnet deployment; the trusted
  setup is a local test setup, not audited.
