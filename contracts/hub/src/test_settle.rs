#![cfg(test)]
//! ADIM R3 - uzlasma ve coktan coga netlestirme.

use super::*;
use crate::test::*;
use soroban_sdk::{testutils::Address as _, vec, Vec};

// ================= tek fis =================

#[test]
fn test_settle_moves_internal_balance() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    assert_eq!(f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 100)), 100);
    assert_eq!(f.hub.balance_of(&p), 400);
    assert_eq!(f.hub.balance_of(&r), 100);
    assert_eq!(f.hub.paid_between(&p, &r), 100);
}

#[test]
fn test_settle_does_not_transfer_tokens() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 100));
    assert_eq!(f.token.balance(&f.hub_addr), 500, "kasa kipirdamadi");
    assert_eq!(f.token.balance(&r), 0, "alicinin cuzdanina bir sey gitmedi");
}

#[test]
fn test_second_voucher_moves_delta() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 100));
    assert_eq!(f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 250)), 150);
    assert_eq!(f.hub.balance_of(&r), 250);
}

#[test]
fn test_replay_same_voucher_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    let v = f.voucher(&p, &k, &r, 100);
    f.hub.settle_one(&r, &v);
    assert_eq!(f.hub.try_settle_one(&r, &v), Err(Ok(Error::StaleVoucher)));
}

#[test]
fn test_lower_cumulative_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 100));
    assert_eq!(
        f.hub.try_settle_one(&r, &f.voucher(&p, &k, &r, 60)),
        Err(Ok(Error::StaleVoucher))
    );
}

#[test]
fn test_self_payment_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    assert_eq!(
        f.hub.try_settle_one(&p, &f.voucher(&p, &k, &p, 10)),
        Err(Ok(Error::SelfPayment))
    );
}

/// p1->r ve p2->r sayaclari birbirinden bagimsiz.
#[test]
fn test_pair_isolation() {
    let f = setup();
    let (p1, k1) = f.payer(1, 500);
    let (p2, k2) = f.payer(2, 500);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p1, &k1, &r, 100));
    assert_eq!(f.hub.settle_one(&r, &f.voucher(&p2, &k2, &r, 100)), 100);
    assert_eq!(f.hub.balance_of(&r), 200);
}

#[test]
fn test_insufficient_balance_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 50);
    let r = Address::generate(&f.e);
    assert_eq!(
        f.hub.try_settle_one(&r, &f.voucher(&p, &k, &r, 100)),
        Err(Ok(Error::InsufficientBalance))
    );
    assert_eq!(f.hub.balance_of(&p), 50);
    assert_eq!(f.hub.balance_of(&r), 0);
    assert_eq!(f.hub.paid_between(&p, &r), 0);
}

#[test]
fn test_anyone_can_settle() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    let v = f.voucher(&p, &k, &r, 100);
    let stranger = Address::generate(&f.e);
    f.e.set_auths(&[]);
    f.hub.settle_one(&stranger, &v);
    assert_eq!(f.hub.balance_of(&r), 100);
}

/// 10.000 ledger once imzalanmis fis hala gecerli. v3.2'de fis tur
/// numarasi tasiyordu ve ~60 sn sonra oluyordu (onceki analizde 5 numara).
#[test]
fn test_old_voucher_still_settles() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    let v = f.voucher(&p, &k, &r, 100);
    f.advance(10_000);
    assert_eq!(f.hub.settle_one(&r, &v), 100);
}

// ================= coktan coga netlestirme =================

#[test]
fn test_batch_settles_all() {
    let f = setup();
    f.unlimited();
    let rs: [Address; 8] = core::array::from_fn(|_| Address::generate(&f.e));
    let mut vs: Vec<Voucher> = Vec::new(&f.e);
    let mut payers = Vec::new(&f.e);
    for i in 0..5u8 {
        let (p, k) = f.payer(10 + i, 1000);
        payers.push_back(p.clone());
        for j in 0..8usize {
            if (i as usize + j) % 2 == 0 {
                vs.push_back(f.voucher(&p, &k, &rs[j], 10 * (i as i128 + 1)));
            }
        }
    }
    let out = f.hub.settle_batch(&rs[0], &vs);
    assert_eq!(out.settled, vs.len());
    assert_eq!(out.stale, 0);
    assert_eq!(out.skipped.len(), 0);
    // her odeyen 4 aliciya (i+1)*10 odedi
    for i in 0..5u32 {
        let p = payers.get_unchecked(i);
        assert_eq!(f.hub.balance_of(&p), 1000 - 4 * 10 * (i as i128 + 1));
    }
    assert_eq!(f.token.balance(&f.hub_addr), 5000, "kasa kipirdamadi");
}

/// SUNUMUN DEMOSU (Sahne 1). A->B 100, B->C 90, C->A 80.
/// A'nin kasasinda SADECE 20 var, B ve C'nin hic yok. Parti geciyor.
/// ASLA GEVSETME.
#[test]
fn test_circular_debt_nets() {
    let f = setup();
    let (a, ka) = f.payer(1, 20);
    let (b, kb) = f.payer(2, 0);
    let (c, kc) = f.payer(3, 0);
    let vs = vec![
        &f.e,
        f.voucher(&a, &ka, &b, 100),
        f.voucher(&b, &kb, &c, 90),
        f.voucher(&c, &kc, &a, 80),
    ];
    let out = f.hub.settle_batch(&a, &vs);
    assert_eq!(out.settled, 3);
    assert_eq!(out.skipped.len(), 0);
    assert_eq!(out.total, 270);
    assert_eq!(f.hub.balance_of(&a), 0);
    assert_eq!(f.hub.balance_of(&b), 10);
    assert_eq!(f.hub.balance_of(&c), 10);
    assert_eq!(f.token.balance(&f.hub_addr), 20, "270 birim borc, 0 token hareketi");
}

/// Karsiliksiz bir odeyen partiyi dusurmez, sadece kendi fisleri elenir.
#[test]
fn test_insolvent_payer_skipped_only() {
    let f = setup();
    let (p1, k1) = f.payer(1, 100);
    let (p2, k2) = f.payer(2, 100);
    let (p3, k3) = f.payer(3, 10);
    let r1 = Address::generate(&f.e);
    let r3 = Address::generate(&f.e);
    let vs = vec![
        &f.e,
        f.voucher(&p1, &k1, &r1, 50),
        f.voucher(&p2, &k2, &r1, 50),
        f.voucher(&p3, &k3, &r3, 999),
    ];
    let out = f.hub.settle_batch(&r1, &vs);
    assert_eq!(out.skipped, vec![&f.e, p3.clone()]);
    assert_eq!(out.settled, 2);
    assert_eq!(f.hub.balance_of(&r1), 100);
    assert_eq!(f.hub.balance_of(&r3), 0, "p3'un alicisi kredilendirilmedi");
    assert_eq!(f.hub.balance_of(&p3), 10);
}

/// C elenince A da odeyemez hale geliyor. Iki turda sabit noktaya variyor.
#[test]
fn test_cascade_skip() {
    let f = setup();
    let (a, ka) = f.payer(1, 0);
    let (c, kc) = f.payer(3, 0); // hic parasi yok
    let (d, kd) = f.payer(4, 50);
    let b = Address::generate(&f.e);
    let e2 = Address::generate(&f.e);
    let vs = vec![
        &f.e,
        f.voucher(&c, &kc, &a, 100), // C karsiliksiz
        f.voucher(&a, &ka, &b, 100), // A, C'den gelecek parayla odeyecekti
        f.voucher(&d, &kd, &e2, 50), // bagimsiz, gecmeli
    ];
    let out = f.hub.settle_batch(&b, &vs);
    assert_eq!(out.skipped.len(), 2);
    assert!(out.skipped.contains(&a) && out.skipped.contains(&c));
    assert_eq!(out.settled, 1);
    assert_eq!(f.hub.balance_of(&b), 0);
    assert_eq!(f.hub.balance_of(&e2), 50);
}

#[test]
fn test_batch_duplicate_pair_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    let vs = vec![&f.e, f.voucher(&p, &k, &r, 10), f.voucher(&p, &k, &r, 20)];
    assert_eq!(f.hub.try_settle_batch(&r, &vs), Err(Ok(Error::DuplicatePair)));
}

#[test]
fn test_batch_empty_fails() {
    let f = setup();
    let r = Address::generate(&f.e);
    assert_eq!(
        f.hub.try_settle_batch(&r, &Vec::new(&f.e)),
        Err(Ok(Error::EmptyBatch))
    );
}

/// Imza hatasi hala parti geneli: bu partiyi kuranin hatasi.
#[test]
#[should_panic]
fn test_batch_rejects_bad_signature() {
    let f = setup();
    let (p1, k1) = f.payer(1, 500);
    let (p2, k2) = f.payer(2, 500);
    let r = Address::generate(&f.e);
    let mut bad = f.voucher(&p2, &k2, &r, 10);
    bad.sig = k1.sign_hash(&f.e, &f.hub.voucher_hash(&p2, &r, &10));
    let vs = vec![&f.e, f.voucher(&p1, &k1, &r, 10), bad];
    f.hub.settle_batch(&r, &vs);
}

/// Bir alici kendi fisini parti gitmeden once `settle_one` ile uzlastiriyor.
/// v3.2'de bu butun partiyi dusururdu (onceki analizde 4 numara). Artik
/// o fis atlaniyor, geri kalan parti geciyor. ASLA GEVSETME.
#[test]
fn test_batch_skips_stale_voucher() {
    let f = setup();
    let (p1, k1) = f.payer(1, 500);
    let (p2, k2) = f.payer(2, 500);
    let r1 = Address::generate(&f.e);
    let r2 = Address::generate(&f.e);
    let v1 = f.voucher(&p1, &k1, &r1, 100);
    let v2 = f.voucher(&p2, &k2, &r2, 70);

    f.hub.settle_one(&r1, &v1); // one gecme

    let out = f.hub.settle_batch(&r2, &vec![&f.e, v1, v2]);
    assert_eq!(out.stale, 1);
    assert_eq!(out.settled, 1);
    assert_eq!(out.total, 70);
    assert_eq!(f.hub.balance_of(&r1), 100, "iki kez odenmedi");
    assert_eq!(f.hub.balance_of(&r2), 70);
}

#[test]
fn test_batch_all_stale_ok() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    let v = f.voucher(&p, &k, &r, 100);
    f.hub.settle_one(&r, &v);
    let out = f.hub.settle_batch(&r, &vec![&f.e, v]);
    assert_eq!(out.settled, 0);
    assert_eq!(out.stale, 1);
    assert_eq!(f.hub.balance_of(&r), 100);
}

/// Kabul sirasinin oneki: A once B'den aliyor, sonra C'ye oduyor.
/// A'nin kasasi 0, ama ayni partide aldigi parayla odeyebiliyor.
#[test]
fn test_incoming_in_same_batch_pays_outgoing() {
    let f = setup();
    let (a, ka) = f.payer(1, 0);
    let (b, kb) = f.payer(2, 30);
    let c = Address::generate(&f.e);
    let vs = vec![&f.e, f.voucher(&b, &kb, &a, 30), f.voucher(&a, &ka, &c, 30)];
    let out = f.hub.settle_batch(&c, &vs);
    assert_eq!(out.skipped.len(), 0);
    assert_eq!(f.hub.balance_of(&a), 0);
    assert_eq!(f.hub.balance_of(&c), 30);
}

#[test]
fn test_no_token_transfer_in_large_batch() {
    let f = setup();
    f.unlimited();
    let mut vs: Vec<Voucher> = Vec::new(&f.e);
    for i in 0..5u8 {
        let (p, k) = f.payer(10 + i, 1000);
        for _ in 0..8 {
            let r = Address::generate(&f.e);
            vs.push_back(f.voucher(&p, &k, &r, 5));
        }
    }
    let before = f.token.balance(&f.hub_addr);
    let out = f.hub.settle_batch(&Address::generate(&f.e), &vs);
    assert_eq!(out.settled, 40);
    assert_eq!(f.token.balance(&f.hub_addr), before);
}
