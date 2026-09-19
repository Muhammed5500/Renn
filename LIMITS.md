# Measured limits (step L)

19 September 2026, Stellar testnet (Protocol 28), vault `CANRTUBN...BUCQ4M` (v3.3).
v3.3.1 only removed scope; the settlement code is the same, so the measurements hold.
Measured with `demo/limits.ts`: a `settle_batch` simulation with two
`ed25519_verify` per voucher (payer + operator). The simulation is deterministic.

## Pairs per batch

| Pairs (vouchers) | Instructions | Writes | Tx size | Fee, new pairs |
|---:|---:|---:|---:|---:|
| 1 | 2.15 M | 484 B | 0.7 KB | 0.031 XLM |
| 10 | 15.3 M | 2.9 KB | 4.9 KB | 0.191 XLM |
| 40 | 62.9 M | 9.4 KB | 18.8 KB | 0.755 XLM |
| 100 | 177.6 M | 22.5 KB | 46.7 KB | 1.885 XLM |
| 150 | 292.5 M | 33.4 KB | 69.9 KB | 2.827 XLM |
| **190** | **395.8 M** | 42.1 KB | 88.4 KB | 3.582 XLM |
| 200 | exceeded | | | `Budget, ExceededLimit` |

**At most ~190 pairs in one transaction.** The instruction budget (400 M) sets
the limit, not the transaction size. About 1.95 M instructions per voucher.

The ledger's default `MAX_PAIRS` is **150** (~75% of the budget).

A pair is one voucher per batch, however many payments it contains. A batch of
150 pairs can close thousands of payments.

## Fee: new pair vs. repeated pair

The same 40 pairs, two batches back to back:

| | Fee for 40 pairs | Per pair |
|---|---:|---:|
| First settlement (new storage entries) | 0.756 XLM | 0.0189 XLM |
| Same pairs again (entries exist) | **0.036 XLM** | **0.0009 XLM** |

Almost all of the first settlement's fee is 30 days of rent for the new
entries (pair counter, recipient balance). It is a one-time cost.

## Comparison (use with care)

An x402 `exact` payment measured on mainnet during research: 23,579 stroops
(0.0024 XLM). The dollar value in the same measurement was $0.000411.

| | XLM |
|---|---:|
| x402, per payment | 0.0024 |
| Shadow ledger, repeated pair, **per batch** | 0.0009 |
| Shadow ledger, new pair, first time | 0.0189 |

So for a repeated pair the cost is below x402 even if the batch holds a
**single payment**. The gap grows in proportion to the number of payments. The
first settlement of a new pair costs about as much as 8 x402 payments.

**On stage:** don't say "cheap", say these numbers. Testnet fees rest on the
same network settings as mainnet, but they were not measured on mainnet; say
that too.

## Not measured

- Mainnet fees.
- How the number of rounds of the fixed-point loop grows with more payers. The
  ledger builds prefix batches, so in practice the loop ends in one round (no
  one is dropped).
- The event size limit (no problem at 190 pairs).
