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

test("tetikleyici_ozeti: cift sayisi fis sayisi degil, tutar ve en buyuk alici", () => {
  const l = world({ A: 100n * U, B: 50n * U, C: 0n, D: 0n });
  for (let i = 0; i < 50; i++) pay(l, "A", "C", U); // 50 fis, TEK cift
  pay(l, "A", "D", 3n * U);
  pay(l, "B", "C", 7n * U);
  const s = l.unsettledSummary();
  assert.equal(l.entries.length, 52, "52 fis");
  assert.equal(s.pairs, 3, "ama 3 cift: A-C, A-D, B-C");
  assert.equal(s.total, 60n * U);
  assert.equal(s.topRecipient, "C");
  assert.equal(s.topRecipientAmount, 57n * U);
  l.markInflight(l.cutBatch(100)!);
  assert.equal(l.unsettledSummary().pairs, 3, "ucustaki parti hala uzlasmamis sayilir");
  l.batchSettled();
  assert.deepEqual(l.unsettledSummary(), { pairs: 0, total: 0n, topRecipient: null, topRecipientAmount: 0n });
});

test("reconcile_monoton: geride kalan RPC'den gelen eski paid okumasi yok sayilir", () => {
  const l = world({ A: 20n * U, B: 0n });
  pay(l, "A", "B", 5n * U);
  l.markInflight(l.cutBatch(100)!);
  l.batchSettled(); // zincirde paid(A,B) = 5
  pay(l, "A", "B", 3n * U); // uzlasmamis 3 daha
  const before = l.spendable("A");
  // eski dugum partiden ONCEKI durumu dondurdu: paid 0
  l.reconcile(new Map(), new Map([["A|B", 0n]]));
  assert.equal(l.paid("A", "B"), 5n * U, "zincirde odenen geri dusmedi");
  assert.equal(l.spendable("A"), before, "harcanabilir sisirilmedi");
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

test("cekim_partisiz: kendi parasi hemen onaylanir", () => {
  // Kasada 20, Mehmet'e 5 soz verdi (uzlasmadi). 15 serbest.
  const l = world({ A: 20n * U, M: 0n });
  pay(l, "A", "M", 5n * U);
  assert.equal(l.withdrawableNow("A"), 15n * U);
  assert.equal(l.reserve("A", 15n * U, 2000), null);
  assert.equal(l.canApprove("A"), true, "parti gerekmiyor");
  assert.equal(l.reserve("A", 1n, 2000), "insufficient_spendable", "15'ten fazlasi yok");
  // cekim zincirde gerceklesti: kasada 5 kaldi, Mehmet'in fisi hala odenebilir
  l.withdrawn("A", 15n * U);
  const b = l.cutBatch(100)!;
  assert.equal(contractSkips(l.balances, b.items, (x, y) => l.paid(x, y)).size, 0);
});

test("cekim_gelen_para: gelmemis para icin olagan parti beklenir", () => {
  // A'nin kasasi 0, C ona 10 soz verdi. Harcanabilir 10, ama zincirde 0.
  const l = world({ A: 0n, C: 10n * U });
  pay(l, "C", "A", 10n * U);
  assert.equal(l.spendable("A"), 10n * U);
  assert.equal(l.withdrawableNow("A"), 0n);
  assert.equal(l.reserve("A", 10n * U, 2000), null, "ayrilabilir");
  assert.equal(l.canApprove("A"), false, "henuz imzalanamaz");
  assert.equal(reason(pay(l, "A", "C", 1n)), "insufficient_spendable", "ayrilan para harcanamaz");
  l.markInflight(l.cutBatch(100)!);
  l.batchSettled();
  assert.equal(l.canApprove("A"), true, "olagan partiden sonra imzalanabilir");
});

test("cekim_karisik: 20 kasada, 5 giden, 10 gelen", () => {
  const l = world({ A: 20n * U, M: 0n, C: 10n * U });
  pay(l, "A", "M", 5n * U);
  pay(l, "C", "A", 10n * U);
  assert.equal(l.spendable("A"), 25n * U);
  assert.equal(l.withdrawableNow("A"), 15n * U, "Can'in 10'u henuz hesapta degil");
  l.reserve("A", 25n * U, 2000);
  assert.equal(l.canApprove("A"), false);
});

test("cekim_ozelligi: partisiz ve parti bekleyen cekimler kontrata kimseyi eletmiyor", () => {
  const agents = ["A", "B", "C", "D", "E"];
  const r = rng(99);
  const start: Record<string, bigint> = {};
  for (const x of agents) start[x] = BigInt(20 + Math.floor(r() * 30)) * U;
  const l = world(start);
  const waiting: { who: string; amt: bigint }[] = [];
  let direct = 0;
  let afterBatch = 0;
  let batches = 0;

  // Sunucunun kurali: onay ancak canApprove dogruyken imzalanir. Imzalanan
  // cekim zincirde gerceklesir; kontrat amount <= bakiye ister.
  const execute = (who: string, amt: bigint) => {
    assert.ok(l.balance(who) >= amt, `${who}: kontrat ExceedsBalance verirdi`);
    l.withdrawn(who, amt);
  };

  for (let i = 0; i < 6000; i++) {
    const p = agents[Math.floor(r() * 5)];
    let q = agents[Math.floor(r() * 5)];
    if (q === p) q = agents[(agents.indexOf(p) + 1) % 5];
    const roll = r();
    if (roll < 0.05) {
      // para yatirma (Deposited olayi): cekimler sistemi bosaltmasin
      l.deposited(p, BigInt(5 + Math.floor(r() * 20)) * U);
    } else if (roll < 0.25) {
      // bazen tam sinir (withdrawableNow), bazen harcanabilirin tamami, bazen rastgele
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
      assert.equal(skipped.size, 0, `islem ${i}: kontrat ${[...skipped]} eleyecekti`);
      l.markInflight(b);
      l.batchSettled();
      batches++;
      // olagan partiden sonra bekleyen onaylar
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
      assert.ok(l.balance(x) >= 0n, `${x} zincir bakiyesi eksi`);
    }
  }
  assert.ok(direct > 20, `partisiz cekim sayisi (${direct})`);
  assert.ok(afterBatch > 10, `parti sonrasi cekim sayisi (${afterBatch})`);
  assert.ok(batches > 30, `parti sayisi (${batches})`);
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
