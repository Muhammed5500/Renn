// STEP D2 acceptance criteria. No network, finishes in seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LedgerCore, type VoucherIn, type Ctx, type BatchItem } from "../src/core.ts";

const U = 10_000_000n; // 1 unit, 7 decimals

const ctx = (): Ctx => ({ verifySig: (v) => v.sig === "ok" });

/** Registered participants with balances. */
function world(balances: Record<string, bigint>): LedgerCore {
  const l = new LedgerCore();
  for (const [x, b] of Object.entries(balances)) {
    l.setSigner(x, `pub-${x}`);
    if (b > 0n) l.deposited(x, b);
  }
  return l;
}

/** The pair's next voucher: cumulative = accepted + amount. */
function pay(l: LedgerCore, payer: string, recipient: string, amount: bigint, c = ctx()) {
  const v: VoucherIn = {
    payer,
    recipient,
    cumulative: l.accepted(payer, recipient) + amount,
    sig: "ok",
  };
  const r = l.accept(v, c);
  if (r.ok) r.entry.opSig = "op";
  return r;
}

const reason = (r: ReturnType<typeof pay>) => (r.ok ? "accepted" : r.reason);

// ================= bounced cheque =================

test("bounced_cheque: a payer with an empty vault cannot pay", () => {
  const l = world({ E: 0n, D: 5n * U });
  assert.equal(reason(pay(l, "E", "D", 3n * U)), "insufficient_spendable");
  assert.equal(l.spendable("D"), 5n * U, "D's money did not change");
});

test("double_promise: the same 10 cannot go to two recipients", () => {
  const l = world({ A: 10n * U, B: 0n, C: 0n });
  assert.equal(reason(pay(l, "A", "B", 10n * U)), "accepted");
  assert.equal(reason(pay(l, "A", "C", 10n * U)), "insufficient_spendable");
  assert.equal(l.spendable("A"), 0n);
});

// ================= circulation =================

test("circular_return: money that comes back is spendable again", () => {
  const l = world({ A: 10n * U, B: 0n, C: 0n });
  pay(l, "A", "B", 2n * U);
  assert.equal(l.spendable("A"), 8n * U);
  pay(l, "B", "C", 2n * U);
  pay(l, "C", "A", 2n * U);
  assert.equal(l.spendable("A"), 10n * U, "A's spendable came back");
  assert.equal(l.spendable("B"), 0n);
  assert.equal(l.spendable("C"), 0n);
});

test("incoming_counts_immediately: B spends what it got from A without depositing", () => {
  const l = world({ A: 10n * U, B: 0n, C: 0n });
  pay(l, "A", "B", 2n * U);
  assert.equal(reason(pay(l, "B", "C", 2n * U)), "accepted");
  assert.equal(reason(pay(l, "B", "C", 1n)), "insufficient_spendable");
});

test("sybil_loop: two empty accounts cannot create credit for each other", () => {
  const l = world({ E: 0n, E2: 0n });
  assert.equal(reason(pay(l, "E", "E2", 1000n * U)), "insufficient_spendable");
  assert.equal(reason(pay(l, "E2", "E", 1000n * U)), "insufficient_spendable");
});

/** Scene 1: A's 20 carries 270 units of debt through small alternating payments. */
test("scene_1: A with 20, A->B 100, B->C 90, C->A 80", () => {
  const l = world({ A: 20n * U, B: 0n, C: 0n });
  for (let i = 0; i < 100; i++) {
    assert.equal(reason(pay(l, "A", "B", U)), "accepted", `round ${i} A->B`);
    if (i < 90) assert.equal(reason(pay(l, "B", "C", U)), "accepted", `round ${i} B->C`);
    if (i < 80) assert.equal(reason(pay(l, "C", "A", U)), "accepted", `round ${i} C->A`);
    assert.ok(l.spendable("A") >= 0n);
  }
  assert.equal(l.accepted("A", "B"), 100n * U);
  assert.equal(l.accepted("B", "C"), 90n * U);
  assert.equal(l.accepted("C", "A"), 80n * U);
  assert.equal(l.spendable("A"), 0n);
  assert.equal(l.spendable("B"), 10n * U);
  assert.equal(l.spendable("C"), 10n * U);
});

test("scene_1_reverse_order: paying 100 up front is refused, which is correct", () => {
  const l = world({ A: 20n * U, B: 0n, C: 0n });
  assert.equal(reason(pay(l, "A", "B", 100n * U)), "insufficient_spendable");
});

// ================= other refusals =================

test("unregistered, self-payment and bad-signature vouchers", () => {
  const l = world({ A: 100n * U });
  assert.equal(reason(pay(l, "Z", "A", U)), "not_joined");
  assert.equal(reason(pay(l, "A", "A", U)), "self_payment");
  const bad = l.accept({ payer: "A", recipient: "B", cumulative: U, sig: "forged" }, ctx());
  assert.equal(bad.ok ? "accepted" : bad.reason, "bad_signature");
});

test("exiting_payer_refused", () => {
  const l = world({ A: 100n * U, B: 0n });
  l.markExiting("A");
  assert.equal(reason(pay(l, "A", "B", U)), "exiting");
});

test("cumulative_monotonic: equal and lower cumulatives refused", () => {
  const l = world({ A: 100n * U, B: 0n });
  pay(l, "A", "B", 5n * U);
  const same = l.accept({ payer: "A", recipient: "B", cumulative: 5n * U, sig: "ok" }, ctx());
  const lower = l.accept({ payer: "A", recipient: "B", cumulative: 4n * U, sig: "ok" }, ctx());
  assert.equal(same.ok ? "" : same.reason, "stale");
  assert.equal(lower.ok ? "" : lower.reason, "stale");
});

// ================= batches =================

/** Exact copy of the contract's settle_batch: fixed point, returns the dropped payers. */
function contractSkips(balances: Map<string, bigint>, items: BatchItem[], paid: (p: string, r: string) => bigint) {
  const deltas = items.map((it) => it.cumulative - paid(it.payer, it.recipient));
  const bad = new Set<string>();
  for (;;) {
    const net = new Map<string, bigint>();
    items.forEach((it, i) => {
      if (deltas[i] <= 0n || bad.has(it.payer)) return;
      net.set(it.payer, (net.get(it.payer) ?? 0n) - deltas[i]);
      net.set(it.recipient, (net.get(it.recipient) ?? 0n) + deltas[i]);
    });
    let changed = false;
    for (const [x, n] of net) {
      if ((balances.get(x) ?? 0n) + n < 0n && !bad.has(x)) {
        bad.add(x);
        changed = true;
      }
    }
    if (!changed) return bad;
  }
}

test("batch_cut: prefix, latest cumulative per pair", () => {
  const l = world({ A: 100n * U, B: 0n, C: 0n });
  pay(l, "A", "B", U); // seq 1
  pay(l, "A", "B", U); // seq 2
  pay(l, "A", "C", U); // seq 3
  pay(l, "B", "C", U); // seq 4
  const b = l.cutBatch(2)!;
  assert.equal(b.items.length, 2);
  assert.equal(b.uptoSeq, 3, "the third pair (B->C) did not fit, the prefix ends at seq 3");
  assert.deepEqual(
    b.items.map((i) => [i.payer, i.recipient, i.cumulative]),
    [["A", "B", 2n * U], ["A", "C", U]],
  );
});

test("batch_in_flight: spendable never changes, and is restored on failure", () => {
  const l = world({ A: 20n * U, B: 0n, C: 0n });
  pay(l, "A", "B", 5n * U);
  pay(l, "B", "C", 3n * U);
  const snap = () => ["A", "B", "C"].map((x) => l.spendable(x));
  const before = snap();

  const b = l.cutBatch(100)!;
  l.markInflight(b);
  assert.deepEqual(snap(), before, "in flight");
  assert.equal(reason(pay(l, "A", "C", 1n * U)), "accepted", "acceptance continues while in flight");
  const mid = snap();

  l.batchFailed();
  assert.deepEqual(snap(), mid, "same after failure");

  l.markInflight(l.cutBatch(100)!);
  l.batchSettled();
  assert.deepEqual(snap(), mid, "same after settlement");
  assert.equal(l.balance("A"), 14n * U);
  assert.equal(l.entries.length, 0);
});

test("reconcile: a voucher settled from outside drops out of the records", () => {
  const l = world({ A: 20n * U, B: 0n });
  pay(l, "A", "B", 5n * U);
  // the recipient settled its own voucher with settle_one (escape hatch)
  l.reconcile(new Map([["A", 15n * U], ["B", 5n * U]]), new Map([["A|B", 5n * U]]));
  assert.equal(l.entries.length, 0);
  assert.equal(l.spendable("A"), 15n * U);
  assert.equal(l.spendable("B"), 5n * U);
});

test("trigger_summary: pairs not vouchers, amount and top recipient", () => {
  const l = world({ A: 100n * U, B: 50n * U, C: 0n, D: 0n });
  for (let i = 0; i < 50; i++) pay(l, "A", "C", U); // 50 vouchers, ONE pair
  pay(l, "A", "D", 3n * U);
  pay(l, "B", "C", 7n * U);
  const s = l.unsettledSummary();
  assert.equal(l.entries.length, 52, "52 vouchers");
  assert.equal(s.pairs, 3, "but 3 pairs: A-C, A-D, B-C");
  assert.equal(s.total, 60n * U);
  assert.equal(s.topRecipient, "C");
  assert.equal(s.topRecipientAmount, 57n * U);
  l.markInflight(l.cutBatch(100)!);
  assert.equal(l.unsettledSummary().pairs, 3, "a batch in flight still counts as unsettled");
  l.batchSettled();
  assert.deepEqual(l.unsettledSummary(), { pairs: 0, total: 0n, topRecipient: null, topRecipientAmount: 0n });
});

test("reconcile_monotonic: a stale paid reading from a lagging RPC node is ignored", () => {
  const l = world({ A: 20n * U, B: 0n });
  pay(l, "A", "B", 5n * U);
  l.markInflight(l.cutBatch(100)!);
  l.batchSettled(); // on chain paid(A,B) = 5
  pay(l, "A", "B", 3n * U); // 3 more, unsettled
  const before = l.spendable("A");
  // a stale node returned the state from BEFORE the batch: paid 0
  l.reconcile(new Map(), new Map([["A|B", 0n]]));
  assert.equal(l.paid("A", "B"), 5n * U, "paid on chain did not go back down");
  assert.equal(l.spendable("A"), before, "spendable was not inflated");
});

// ================= withdrawal reservations =================

test("withdrawal_reservation: reserved money cannot be spent, freed on expiry", () => {
  const l = world({ A: 10n * U, B: 0n });
  assert.equal(l.reserve("A", 6n * U, 2000), null);
  assert.equal(l.spendable("A"), 4n * U);
  assert.equal(reason(pay(l, "A", "B", 5n * U)), "insufficient_spendable");
  assert.equal(l.reserve("A", 5n * U, 2000), "insufficient_spendable");
  l.expireReservations(2001);
  assert.equal(l.spendable("A"), 10n * U);
});

test("withdrawal_request_replay: no second reservation with the same nonce", () => {
  const l = world({ A: 10n * U });
  assert.equal(l.reserve("A", 2n * U, 2000, 0n), null);
  assert.equal(l.reserve("A", 2n * U, 2000, 0n), "duplicate_request", "resent request");
  assert.equal(l.spendable("A"), 8n * U, "reserved only once");
});

test("withdrawal_executed: balance and reservation drop together", () => {
  const l = world({ A: 10n * U });
  l.reserve("A", 6n * U, 2000);
  l.withdrawn("A", 6n * U);
  assert.equal(l.balance("A"), 4n * U);
  assert.equal(l.spendable("A"), 4n * U);
  assert.equal(l.reservations.length, 0);
});

test("withdrawal_without_batch: own money is approved immediately", () => {
  // 20 in the vault, 5 promised to Mehmet (unsettled). 15 are free.
  const l = world({ A: 20n * U, M: 0n });
  pay(l, "A", "M", 5n * U);
  assert.equal(l.withdrawableNow("A"), 15n * U);
  assert.equal(l.reserve("A", 15n * U, 2000), null);
  assert.equal(l.canApprove("A"), true, "no batch needed");
  assert.equal(l.reserve("A", 1n, 2000), "insufficient_spendable", "nothing beyond 15");
  // withdrawal executed on chain: 5 left in the vault, Mehmet's voucher is still payable
  l.withdrawn("A", 15n * U);
  const b = l.cutBatch(100)!;
  assert.equal(contractSkips(l.balances, b.items, (x, y) => l.paid(x, y)).size, 0);
});

test("withdrawal_incoming_money: money not yet arrived waits for the regular batch", () => {
  // A's vault is 0, C promised it 10. Spendable is 10, but 0 on chain.
  const l = world({ A: 0n, C: 10n * U });
  pay(l, "C", "A", 10n * U);
  assert.equal(l.spendable("A"), 10n * U);
  assert.equal(l.withdrawableNow("A"), 0n);
  assert.equal(l.reserve("A", 10n * U, 2000), null, "can be reserved");
  assert.equal(l.canApprove("A"), false, "cannot be signed yet");
  assert.equal(reason(pay(l, "A", "C", 1n)), "insufficient_spendable", "reserved money cannot be spent");
  l.markInflight(l.cutBatch(100)!);
  l.batchSettled();
  assert.equal(l.canApprove("A"), true, "can be signed after the regular batch");
});

test("withdrawal_mixed: 20 in the vault, 5 outgoing, 10 incoming", () => {
  const l = world({ A: 20n * U, M: 0n, C: 10n * U });
  pay(l, "A", "M", 5n * U);
  pay(l, "C", "A", 10n * U);
  assert.equal(l.spendable("A"), 25n * U);
  assert.equal(l.withdrawableNow("A"), 15n * U, "C's 10 is not in the account yet");
  l.reserve("A", 25n * U, 2000);
  assert.equal(l.canApprove("A"), false);
});

test("withdrawal_property: direct and batch-waiting withdrawals never make the contract drop anyone", () => {
  const agents = ["A", "B", "C", "D", "E"];
  const r = rng(99);
  const start: Record<string, bigint> = {};
  for (const x of agents) start[x] = BigInt(20 + Math.floor(r() * 30)) * U;
  const l = world(start);
  const waiting: { who: string; amt: bigint }[] = [];
  let direct = 0;
  let afterBatch = 0;
  let batches = 0;

  // The server's rule: an approval is signed only while canApprove is true.
  // A signed withdrawal executes on chain; the contract requires amount <= balance.
  const execute = (who: string, amt: bigint) => {
    assert.ok(l.balance(who) >= amt, `${who}: the contract would return ExceedsBalance`);
    l.withdrawn(who, amt);
  };

  for (let i = 0; i < 6000; i++) {
    const p = agents[Math.floor(r() * 5)];
    let q = agents[Math.floor(r() * 5)];
    if (q === p) q = agents[(agents.indexOf(p) + 1) % 5];
    const roll = r();
    if (roll < 0.05) {
      // deposit (Deposited event): so withdrawals don't drain the system
      l.deposited(p, BigInt(5 + Math.floor(r() * 20)) * U);
    } else if (roll < 0.25) {
      // sometimes the exact limit (withdrawableNow), sometimes all of spendable, sometimes random
      const k = r();
      const amt = k < 0.4 ? l.withdrawableNow(p) : k < 0.7 ? l.spendable(p) : BigInt(1 + Math.floor(r() * 5)) * U;
      if (amt <= 0n || l.reserve(p, amt, 1e9) !== null) continue;
      if (l.canApprove(p)) {
        execute(p, amt);
        direct++;
      } else {
        waiting.push({ who: p, amt });
      }
    } else if (roll < 0.4) {
      const b = l.cutBatch(1 + Math.floor(r() * 6));
      if (!b) continue;
      const skipped = contractSkips(l.balances, b.items, (x, y) => l.paid(x, y));
      assert.equal(skipped.size, 0, `op ${i}: the contract would drop ${[...skipped]}`);
      l.markInflight(b);
      l.batchSettled();
      batches++;
      // approvals waiting for the regular batch
      for (let j = waiting.length - 1; j >= 0; j--) {
        const w = waiting[j];
        if (l.canApprove(w.who)) {
          execute(w.who, w.amt);
          waiting.splice(j, 1);
          afterBatch++;
        }
      }
    } else {
      pay(l, p, q, BigInt(1 + Math.floor(r() * 6)) * U);
    }
    for (const x of agents) {
      assert.ok(l.spendable(x) >= 0n);
      assert.ok(l.balance(x) >= 0n, `${x} on-chain balance negative`);
    }
  }
  assert.ok(direct > 20, `direct withdrawals (${direct})`);
  assert.ok(afterBatch > 10, `withdrawals after a batch (${afterBatch})`);
  assert.ok(batches > 30, `batches (${batches})`);
});

// ================= PREFIX PROPERTY (NEVER RELAX) =================

/** Reproducible randomness. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("prefix_property: 5 agents, 2000 ops, every prefix is payable", () => {
  const agents = ["A", "B", "C", "D", "E"];
  const r = rng(42);
  const start: Record<string, bigint> = {};
  for (const x of agents) start[x] = BigInt(Math.floor(r() * 20)) * U;
  const l = world(start);
  const bal0 = new Map(Object.entries(start));
  const history: { payer: string; recipient: string; cumulative: bigint }[] = [];

  let accepted = 0;
  for (let i = 0; i < 2000; i++) {
    const p = agents[Math.floor(r() * 5)];
    let q = agents[Math.floor(r() * 5)];
    if (q === p) q = agents[(agents.indexOf(p) + 1) % 5];
    const res = pay(l, p, q, BigInt(1 + Math.floor(r() * 8)) * U);
    if (res.ok) {
      accepted++;
      history.push({ payer: p, recipient: q, cumulative: res.entry.cumulative });
    }
    for (const x of agents) assert.ok(l.spendable(x) >= 0n, `op ${i}: ${x} went negative`);
  }
  assert.ok(accepted > 300, `enough acceptances expected (${accepted})`);

  // for every prefix: latest cumulative per pair within it, bal0 + net >= 0 for everyone
  const latest = new Map<string, bigint>();
  for (let s = 0; s < history.length; s++) {
    const h = history[s];
    latest.set(`${h.payer}|${h.recipient}`, h.cumulative);
    const net = new Map<string, bigint>();
    for (const [key, cum] of latest) {
      const [p, q] = key.split("|");
      net.set(p, (net.get(p) ?? 0n) - cum);
      net.set(q, (net.get(q) ?? 0n) + cum);
    }
    for (const x of agents) {
      assert.ok((bal0.get(x) ?? 0n) + (net.get(x) ?? 0n) >= 0n, `prefix ${s}: ${x} cannot pay`);
    }
  }
});

test("prefix_property_with_batches: with batches in between the contract drops nobody", () => {
  const agents = ["A", "B", "C", "D", "E"];
  const r = rng(7);
  const start: Record<string, bigint> = {};
  for (const x of agents) start[x] = BigInt(Math.floor(r() * 15)) * U;
  const l = world(start);

  let batches = 0;
  for (let i = 0; i < 2000; i++) {
    const p = agents[Math.floor(r() * 5)];
    let q = agents[Math.floor(r() * 5)];
    if (q === p) q = agents[(agents.indexOf(p) + 1) % 5];
    pay(l, p, q, BigInt(1 + Math.floor(r() * 6)) * U);

    if (r() < 0.05) {
      const b = l.cutBatch(1 + Math.floor(r() * 6));
      if (!b) continue;
      const skipped = contractSkips(l.balances, b.items, (x, y) => l.paid(x, y));
      assert.equal(skipped.size, 0, `batch ${batches}: the contract would drop ${[...skipped]}`);
      l.markInflight(b);
      if (r() < 0.2) l.batchFailed();
      else l.batchSettled();
      batches++;
    }
    for (const x of agents) {
      assert.ok(l.spendable(x) >= 0n);
      assert.ok(l.balance(x) >= 0n, `${x} on-chain balance negative`);
    }
  }
  assert.ok(batches > 50, `enough batches (${batches})`);
});
