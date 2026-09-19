// ADIM D2 kabul kriterleri. Ag yok, saniyeler icinde biter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LedgerCore, type VoucherIn, type Ctx, type BatchItem } from "../src/core.ts";

const U = 10_000_000n; // 1 birim, 7 ondalik

const ctx = (): Ctx => ({ verifySig: (v) => v.sig === "ok" });

/** Kayitli, bakiyeli katilimcilar. */
function world(balances: Record<string, bigint>): LedgerCore {
  const l = new LedgerCore();
  for (const [x, b] of Object.entries(balances)) {
    l.setSigner(x, `pub-${x}`);
    if (b > 0n) l.deposited(x, b);
  }
  return l;
}

/** Ayni ciftin bir sonraki fisi: kumulatif = kabul edilen + tutar. */
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

// ================= karsiliksiz cek =================

test("karsiliksiz_cek: kasasi bos olan odeyemez", () => {
  const l = world({ E: 0n, D: 5n * U });
  assert.equal(reason(pay(l, "E", "D", 3n * U)), "insufficient_spendable");
  assert.equal(l.spendable("D"), 5n * U, "D'nin parasi degismedi");
});

test("cift_soz: ayni 10 iki kisiye verilemez", () => {
  const l = world({ A: 10n * U, B: 0n, C: 0n });
  assert.equal(reason(pay(l, "A", "B", 10n * U)), "accepted");
  assert.equal(reason(pay(l, "A", "C", 10n * U)), "insufficient_spendable");
  assert.equal(l.spendable("A"), 0n);
});

// ================= dolasim =================

test("dairesel_artis: para donup gelince tekrar harcanabilir", () => {
  const l = world({ A: 10n * U, B: 0n, C: 0n });
  pay(l, "A", "B", 2n * U);
  assert.equal(l.spendable("A"), 8n * U);
  pay(l, "B", "C", 2n * U);
  pay(l, "C", "A", 2n * U);
  assert.equal(l.spendable("A"), 10n * U, "A'nin harcanabiliri geri geldi");
  assert.equal(l.spendable("B"), 0n);
  assert.equal(l.spendable("C"), 0n);
});

test("gelen_aninda_sayilir: B hic yatirmadan A'dan aldigini harcar", () => {
  const l = world({ A: 10n * U, B: 0n, C: 0n });
  pay(l, "A", "B", 2n * U);
  assert.equal(reason(pay(l, "B", "C", 2n * U)), "accepted");
  assert.equal(reason(pay(l, "B", "C", 1n)), "insufficient_spendable");
});

test("sybil_dongusu: bos iki hesap birbirine kredi uretemez", () => {
  const l = world({ E: 0n, E2: 0n });
  assert.equal(reason(pay(l, "E", "E2", 1000n * U)), "insufficient_spendable");
  assert.equal(reason(pay(l, "E2", "E", 1000n * U)), "insufficient_spendable");
});

/** Sahne 1: A'nin 20'si, kucuk ve donusumlu odemelerle 270 birim borcu tasiyor. */
test("sahne_1: A 20 ile A->B 100, B->C 90, C->A 80", () => {
  const l = world({ A: 20n * U, B: 0n, C: 0n });
  for (let i = 0; i < 100; i++) {
    assert.equal(reason(pay(l, "A", "B", U)), "accepted", `tur ${i} A->B`);
    if (i < 90) assert.equal(reason(pay(l, "B", "C", U)), "accepted", `tur ${i} B->C`);
    if (i < 80) assert.equal(reason(pay(l, "C", "A", U)), "accepted", `tur ${i} C->A`);
    assert.ok(l.spendable("A") >= 0n);
  }
  assert.equal(l.accepted("A", "B"), 100n * U);
  assert.equal(l.accepted("B", "C"), 90n * U);
  assert.equal(l.accepted("C", "A"), 80n * U);
  assert.equal(l.spendable("A"), 0n);
  assert.equal(l.spendable("B"), 10n * U);
  assert.equal(l.spendable("C"), 10n * U);
});

test("sahne_1_ters_sira: once 100 odemeye kalkarsa ret, dogru olan bu", () => {
  const l = world({ A: 20n * U, B: 0n, C: 0n });
  assert.equal(reason(pay(l, "A", "B", 100n * U)), "insufficient_spendable");
});

// ================= diger retler =================

test("kayitsiz, kendine ve imzasi bozuk fis", () => {
  const l = world({ A: 100n * U });
  assert.equal(reason(pay(l, "Z", "A", U)), "not_joined");
  assert.equal(reason(pay(l, "A", "A", U)), "self_payment");
  const bad = l.accept({ payer: "A", recipient: "B", cumulative: U, sig: "sahte" }, ctx());
  assert.equal(bad.ok ? "accepted" : bad.reason, "bad_signature");
});

test("cikan_odeyen_ret", () => {
  const l = world({ A: 100n * U, B: 0n });
  l.markExiting("A");
  assert.equal(reason(pay(l, "A", "B", U)), "exiting");
});

test("kumulatif_monoton: esit ve dusuk kumulatif ret", () => {
  const l = world({ A: 100n * U, B: 0n });
  pay(l, "A", "B", 5n * U);
  const same = l.accept({ payer: "A", recipient: "B", cumulative: 5n * U, sig: "ok" }, ctx());
  const lower = l.accept({ payer: "A", recipient: "B", cumulative: 4n * U, sig: "ok" }, ctx());
  assert.equal(same.ok ? "" : same.reason, "stale");
  assert.equal(lower.ok ? "" : lower.reason, "stale");
});

// ================= parti =================

/** Kontratin settle_batch'inin birebir kopyasi: sabit nokta, elenenleri dondurur. */
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

test("parti_kesme: onek, cift basina en son kumulatif", () => {
  const l = world({ A: 100n * U, B: 0n, C: 0n });
  pay(l, "A", "B", U); // seq 1
  pay(l, "A", "B", U); // seq 2
  pay(l, "A", "C", U); // seq 3
  pay(l, "B", "C", U); // seq 4
  const b = l.cutBatch(2)!;
  assert.equal(b.items.length, 2);
  assert.equal(b.uptoSeq, 3, "ucuncu cift (B->C) sigmadi, onek seq 3'te bitti");
  assert.deepEqual(
    b.items.map((i) => [i.payer, i.recipient, i.cumulative]),
    [["A", "B", 2n * U], ["A", "C", U]],
  );
});

test("ucustaki_parti: harcanabilir hic degismiyor, basarisizlikta geri donuyor", () => {
  const l = world({ A: 20n * U, B: 0n, C: 0n });
  pay(l, "A", "B", 5n * U);
  pay(l, "B", "C", 3n * U);
  const snap = () => ["A", "B", "C"].map((x) => l.spendable(x));
  const before = snap();

  const b = l.cutBatch(100)!;
  l.markInflight(b);
  assert.deepEqual(snap(), before, "ucusta");
  assert.equal(reason(pay(l, "A", "C", 1n * U)), "accepted", "ucustayken kabul devam");
  const mid = snap();

  l.batchFailed();
  assert.deepEqual(snap(), mid, "basarisizlikta ayni");

  l.markInflight(l.cutBatch(100)!);
  l.batchSettled();
  assert.deepEqual(snap(), mid, "uzlasinca ayni");
  assert.equal(l.balance("A"), 14n * U);
  assert.equal(l.entries.length, 0);
});

test("reconcile: disaridan uzlastirilmis fis kayittan duser", () => {
  const l = world({ A: 20n * U, B: 0n });
  pay(l, "A", "B", 5n * U);
  // alici kacis yolunda kendi fisini settle_one ile uzlastirdi
  l.reconcile(new Map([["A", 15n * U], ["B", 5n * U]]), new Map([["A|B", 5n * U]]));
  assert.equal(l.entries.length, 0);
  assert.equal(l.spendable("A"), 15n * U);
  assert.equal(l.spendable("B"), 5n * U);
});

// ================= cekim ayirma =================

test("cekim_ayirma: ayrilan harcanamaz, sure dolunca serbest", () => {
  const l = world({ A: 10n * U, B: 0n });
  assert.equal(l.reserve("A", 6n * U, 2000), null);
  assert.equal(l.spendable("A"), 4n * U);
  assert.equal(reason(pay(l, "A", "B", 5n * U)), "insufficient_spendable");
  assert.equal(l.reserve("A", 5n * U, 2000), "insufficient_spendable");
  l.expireReservations(2001);
  assert.equal(l.spendable("A"), 10n * U);
});

test("cekim_gerceklesti: bakiye ve ayirma birlikte duser", () => {
  const l = world({ A: 10n * U });
  l.reserve("A", 6n * U, 2000);
  l.withdrawn("A", 6n * U);
  assert.equal(l.balance("A"), 4n * U);
  assert.equal(l.spendable("A"), 4n * U);
  assert.equal(l.reservations.length, 0);
});

// ================= ONEK OZELLIGI (ASLA GEVSETME) =================

/** Tekrarlanabilir rastgelelik. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("onek_ozelligi: 5 ajan, 2000 islem, her onek odenebilir", () => {
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
    for (const x of agents) assert.ok(l.spendable(x) >= 0n, `islem ${i}: ${x} eksiye dustu`);
  }
  assert.ok(accepted > 300, `yeterince kabul olmali (${accepted})`);

  // her onek icin: cift basina onekteki son kumulatif, herkes icin bal0 + net >= 0
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
      assert.ok((bal0.get(x) ?? 0n) + (net.get(x) ?? 0n) >= 0n, `onek ${s}: ${x} odenemez`);
    }
  }
});

test("onek_ozelligi_partilerle: araya partiler girince kontrat kimseyi elemiyor", () => {
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
      assert.equal(skipped.size, 0, `parti ${batches}: kontrat ${[...skipped]} eleyecekti`);
      l.markInflight(b);
      if (r() < 0.2) l.batchFailed();
      else l.batchSettled();
      batches++;
    }
    for (const x of agents) {
      assert.ok(l.spendable(x) >= 0n);
      assert.ok(l.balance(x) >= 0n, `${x} zincir bakiyesi eksi`);
    }
  }
  assert.ok(batches > 50, `yeterince parti (${batches})`);
});
