# Scheme: `batch-settlement` on Stellar (Soroban)

Network binding of the x402 `batch-settlement` scheme for `stellar:testnet` and `stellar:pubnet`.
Protocol version: x402 v2. Payment flow: `upfront`.

Status: working reference implementation on testnet, not submitted upstream. Closest upstream discussion: x402 issue #3341 (Stellar has no `batch-settlement` binding).

Reference implementation:

| Part | Path |
|---|---|
| Vault contract (Soroban) | `contracts/hub` |
| Resource server scheme (`SchemeNetworkServer`) | `ledger/src/x402.ts`, `BatchSettlementStellarServer` |
| Client scheme (`SchemeNetworkClient`) | `ledger/src/x402.ts`, `BatchSettlementStellarClient` |
| Facilitator (`/supported`, `/verify`, `/settle`) | `ledger/src/server.ts` |
| Signed payloads | `ledger/src/payload.ts`, byte-identical to `contracts/hub/src/voucher.rs` |
| Compliance check | `ledger/scripts/check-x402.ts` |

## Summary

Payers deposit a SEP-41 token into a shared Soroban vault. Each payment is an off-chain **cumulative voucher** for one (payer, recipient) pair, signed with the payer's registered ed25519 key. The facilitator is an **ordered ledger** (the operator). It accepts a voucher only if the payer's spendable balance covers it, then co-signs it. Accepted vouchers are settled later in batches with a single `settle_batch` transaction that nets all positions and moves no tokens.

Compared to the EVM binding:

- **Shared pool, not per-channel escrow.** One vault holds everyone's deposits. Money received is immediately spendable by the recipient (circulation).
- **Many-to-many netting.** A batch nets debts across all payers and recipients.
- **Operator co-signature.** The vault accepts only vouchers the operator has accepted, so the ordered ledger cannot be bypassed. The operator cannot forge vouchers or move funds.

## `PaymentRequirements`

| Field | Value |
|---|---|
| `scheme` | `"batch-settlement"` |
| `network` | `"stellar:testnet"` or `"stellar:pubnet"` |
| `amount` | Price in atomic units, 7 decimals (`"200000"` = 0.02) |
| `asset` | SEP-41 token contract address (`C...`), the vault's token |
| `payTo` | Recipient address (`G...` or `C...`). Needs no account, no registration |
| `maxTimeoutSeconds` | Any. Vouchers do not expire |
| `extra.hub` | Vault contract address |
| `extra.ledger` | Facilitator (operator) base URL |
| `extra.operator` | Operator ed25519 public key, hex |
| `extra.paymentFlow` | `"upfront"` (added by x402 core) |

`extra.hub`, `extra.ledger` and `extra.operator` come from the facilitator's `/supported` response and are merged by `enhancePaymentRequirements`.

## `PaymentPayload.payload`

```json
{
  "type": "voucher",
  "voucher": {
    "payer": "G...",
    "recipient": "G...",
    "cumulative": "4200000",
    "signature": "<hex ed25519, 64 bytes>"
  }
}
```

`cumulative` is the total the payer has ever committed to this recipient. A new voucher replaces the previous one. The client computes it as `accepted(payer, recipient) + amount`, reading `accepted` from the facilitator (`GET /pair/:payer/:recipient`), so a failed payment never inflates it.

### Signed message

```
voucher:  sha256( XDR( ScVal::Vec[ Symbol("batchv3"),  Bytes(network_id), Address(hub), Address(payer), Address(recipient), I128(cumulative) ] ) )
accept:   sha256( XDR( ScVal::Vec[ Symbol("acceptv1"), Bytes(network_id), Address(hub), Address(payer), Address(recipient), I128(cumulative) ] ) )
withdraw: sha256( XDR( ScVal::Vec[ Symbol("withdrv1"), Bytes(network_id), Address(hub), Address(who), I128(amount), U64(nonce), U32(valid_until) ] ) )
```

`network_id` is `sha256(network passphrase)`. The domain separator keeps a signature for one payload from being valid for another; `voucher` and `accept` carry identical fields otherwise.

Why raw ed25519 and not Soroban authorization entries: an auth entry's expiration is capped by the network's `max_entry_ttl` (about 180 days) and is consumed by one invocation, while a voucher is a cumulative statement that is replaced many times and should not expire.

## Facilitator

### `GET /supported`

```json
{
  "kinds": [{ "x402Version": 2, "scheme": "batch-settlement", "network": "stellar:testnet",
              "extra": { "hub": "C...", "ledger": "https://...", "operator": "<hex>" } }],
  "extensions": [],
  "signers": { "stellar:*": ["G... (operator fee account)"] }
}
```

### `POST /verify` (read-only)

Returns `{ isValid, invalidReason?, payer }`. Checks, in order:

1. `scheme`, `network`, `asset` and `extra.hub` match the facilitator's vault.
2. `paymentPayload.accepted` equals `paymentRequirements` on `scheme`, `network`, `asset`, `amount`, `payTo`.
3. `payload.type == "voucher"`, `voucher.recipient == payTo`.
4. The payer is registered (`join`) and not exiting (`exit_start`).
5. `signature` is valid for the `batchv3` message under the payer's registered key.
6. `cumulative > accepted(payer, recipient)`; `delta = cumulative - accepted`.
7. `delta >= amount` (else `underpaid`).
8. `delta <= spendable(payer)` (else `insufficient_spendable`), where

```
spendable(x) = vault_balance(x) - reserved_withdrawals(x)
             + unsettled_incoming(x) - unsettled_outgoing(x)
```

### `POST /settle` (records the commitment)

Runs the same checks and, if they pass, **accepts** the voucher into the ordered ledger and co-signs it (`acceptv1`). No transaction is sent:

```json
{
  "success": true,
  "payer": "G...",
  "transaction": "",
  "network": "stellar:testnet",
  "amount": "<delta>",
  "extra": { "seq": 901, "cumulative": "...", "operatorSignature": "<hex>", "payerSignature": "<hex>" }
}
```

With the `upfront` flow the resource server calls `/settle` before running its handler; if `success` is false the handler never runs and the client receives a 402 whose `PAYMENT-RESPONSE` carries `errorReason`.

The two signatures in `extra` let the recipient settle the voucher on chain by itself (`settle_one`) if the operator disappears.

## Settlement (value moves later)

The operator periodically sends a **prefix of its acceptance order** to `settle_batch`: for every pair, the latest accepted voucher within the prefix. The vault:

1. Verifies each voucher's payer signature and operator signature. A bad signature reverts the batch.
2. Skips vouchers whose cumulative is not above the pair's settled amount (already settled, for example by the recipient itself). They do not revert the batch.
3. Nets all deltas and applies them to internal balances with a fixed-point loop that would drop an insolvent payer. Because every accepted voucher was checked against all earlier acceptances, every prefix is solvent and the loop never drops anyone.
4. Moves no tokens. The vault's token balance is unchanged by settlement.

One transaction settles any number of payments. About 190 pairs fit in one transaction (400M instruction budget); measurements in `LIMITS.md`.

## Double-spend prevention

- Acceptance is strictly sequential; check and update happen in one synchronous step.
- A voucher is accepted only if the payer's spendable balance covers its delta, counting every earlier acceptance.
- Cumulative amounts are monotonic per pair; replay of an old voucher is a no-op.
- The vault rejects vouchers without the operator's acceptance signature, so a payer cannot settle an unaccepted voucher around the ledger.

## Redemption

| Who | How |
|---|---|
| Registered participant, operator online | `withdraw_approved(who, amount, valid_until, op_sig)`. Instant. The operator signs up to `vault_balance - unsettled_outgoing - reserved`; money still incoming waits for the next regular batch. |
| Registered participant, operator offline | `exit_start`, wait `exit_delay`, `withdraw`. The operator stops accepting the payer's vouchers and settles them on `ExitStarted`. |
| Unregistered recipient | `withdraw` at any time, or anyone calls `payout` to push the balance to the recipient's address. |

Withdrawals always go to the owner's own address.

## Trust model

| The operator CAN | The operator CANNOT |
|---|---|
| Refuse vouchers (censor) | Forge a voucher (needs the payer's key) |
| Refuse a withdrawal approval | Move anyone's funds (withdrawals need the owner's signature and go to the owner) |
| Go offline | Lock funds (`exit_start` works without it) |
| Accept an unbacked voucher through a bug; the recipient bears that loss | Claw back received money (there is no clawback) |

Agent safety (a compromised or misled agent spending what it legitimately holds) is the client's concern. The x402 client's `spendControls` apply as usual.

## Security considerations

- The operator key must be distinct from any payer key; domain separators protect against cross-use anyway (contract tests `test_accept_sig_not_valid_as_payer_sig` and related).
- `network_id` and `hub` in every payload prevent cross-network and cross-contract replay.
- Settlement is permissionless. A stale voucher cannot be used to revert a batch (it is skipped).
- The operator must settle an exiting payer's vouchers within `exit_delay`, or those vouchers may become unbacked.
- Not audited.
