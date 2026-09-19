#![cfg(test)]
//! ADIM R4 - cekim, uc yol.

use super::*;
use crate::test::*;
use soroban_sdk::testutils::Address as _;

fn now(f: &Fix) -> u32 {
    f.e.ledger().sequence()
}

// ================= operator onayli, aninda =================

#[test]
fn test_withdraw_approved_instant() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    let until = now(&f) + 60;
    let sig = f.approval(&p, 100, until);
    assert_eq!(f.hub.withdraw_approved(&p, &100, &until, &sig), 100);
    assert_eq!(f.token.balance(&p), 100, "exit_start yok, bekleme yok");
    assert_eq!(f.hub.balance_of(&p), 0);
    assert_eq!(f.hub.exit_at_of(&p), None);
}

#[test]
fn test_withdraw_approved_partial() {
    let f = setup();
    let (p, _) = f.payer(1, 10);
    let until = now(&f) + 60;
    let sig = f.approval(&p, 4, until);
    f.hub.withdraw_approved(&p, &4, &until, &sig);
    assert_eq!(f.hub.balance_of(&p), 6);
    assert_eq!(f.token.balance(&p), 4);
    assert_eq!(f.hub.withdraw_nonce_of(&p), 1);
}

/// Ayni onay ikinci kez kullanilamaz: nonce artti, imza artik tutmuyor.
#[test]
#[should_panic]
fn test_withdraw_approval_replay_fails() {
    let f = setup();
    let (p, _) = f.payer(1, 10);
    let until = now(&f) + 60;
    let sig = f.approval(&p, 4, until);
    f.hub.withdraw_approved(&p, &4, &until, &sig);
    f.hub.withdraw_approved(&p, &4, &until, &sig);
}

#[test]
fn test_withdraw_approval_expired_fails() {
    let f = setup();
    let (p, _) = f.payer(1, 10);
    let until = now(&f) + 5;
    let sig = f.approval(&p, 4, until);
    f.advance(6);
    assert_eq!(
        f.hub.try_withdraw_approved(&p, &4, &until, &sig),
        Err(Ok(Error::ApprovalExpired))
    );
}

/// A'nin onayiyla B cekemez.
#[test]
#[should_panic]
fn test_withdraw_approval_for_other_who_fails() {
    let f = setup();
    let (a, _) = f.payer(1, 10);
    let (b, _) = f.payer(2, 10);
    let until = now(&f) + 60;
    let sig = f.approval(&a, 4, until);
    f.hub.withdraw_approved(&b, &4, &until, &sig);
}

/// Onaydaki tutar degistirilemez.
#[test]
#[should_panic]
fn test_withdraw_approval_amount_tamper_fails() {
    let f = setup();
    let (p, _) = f.payer(1, 10);
    let until = now(&f) + 60;
    let sig = f.approval(&p, 4, until);
    f.hub.withdraw_approved(&p, &10, &until, &sig);
}

#[test]
fn test_withdraw_approval_exceeds_balance_fails() {
    let f = setup();
    let (p, _) = f.payer(1, 10);
    let until = now(&f) + 60;
    let sig = f.approval(&p, 11, until);
    assert_eq!(
        f.hub.try_withdraw_approved(&p, &11, &until, &sig),
        Err(Ok(Error::ExceedsBalance))
    );
}

#[test]
fn test_withdraw_approved_rejects_unjoined() {
    let f = setup();
    let r = f.funded(10);
    f.hub.deposit(&r, &10);
    let until = now(&f) + 60;
    let sig = f.approval(&r, 5, until);
    assert_eq!(
        f.hub.try_withdraw_approved(&r, &5, &until, &sig),
        Err(Ok(Error::NotJoined))
    );
}

/// Onay tek basina para cekmeye yetmez, sahibinin imzasi da lazim.
/// Operator bir onay imzalasa bile parayi kimseye gonderemez.
#[test]
fn test_withdraw_approved_requires_owner_auth() {
    let f = setup();
    let (p, _) = f.payer(1, 10);
    let until = now(&f) + 60;
    let sig = f.approval(&p, 10, until);
    f.e.set_auths(&[]);
    assert!(f.hub.try_withdraw_approved(&p, &10, &until, &sig).is_err());
    assert_eq!(f.hub.balance_of(&p), 10);
}

// ================= kayitsiz alici =================

/// Aldigi para kesin, bekletmek icin sebep yok.
#[test]
fn test_pure_recipient_withdraws_anytime() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 40));
    assert_eq!(f.hub.withdraw(&r), 40, "ayni ledger'da, pencere yok");
    assert_eq!(f.token.balance(&r), 40);
}

#[test]
fn test_payout_pushes_to_pure_recipient() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 40));
    f.e.set_auths(&[]); // ucuncu bir adres, hic imza yok
    assert_eq!(f.hub.payout(&r), 40);
    assert_eq!(f.token.balance(&r), 40, "para sahibine gitti");
}

#[test]
fn test_payout_rejects_registered_payer() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    assert_eq!(f.hub.try_payout(&p), Err(Ok(Error::NotPushable)));
}

#[test]
fn test_payout_empty_fails() {
    let f = setup();
    let r = Address::generate(&f.e);
    assert_eq!(f.hub.try_payout(&r), Err(Ok(Error::EmptyBalance)));
}

// ================= kacis yolu (operatorsuz) =================

#[test]
fn test_payer_must_exit_or_be_approved() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    assert_eq!(f.hub.try_withdraw(&p), Err(Ok(Error::NotExiting)));
}

#[test]
fn test_payer_withdraw_before_exit_delay_fails() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    f.hub.exit_start(&p);
    f.advance(EXIT_DELAY - 1);
    assert_eq!(f.hub.try_withdraw(&p), Err(Ok(Error::NotWithdrawable)));
}

/// Operator cokse de para sizin. ASLA GEVSETME.
#[test]
fn test_exit_path_after_delay() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    f.hub.exit_start(&p);
    f.advance(EXIT_DELAY);
    assert_eq!(f.hub.withdraw(&p), 100);
    assert_eq!(f.token.balance(&p), 100);
}

/// Cikis ilan edildi, sure dolmadi, uzlasma hala geciyor.
/// Odeyen cikis ilan ederek borcundan kacamaz. ASLA GEVSETME.
#[test]
fn test_settle_still_works_after_exit_start() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let v = f.voucher(&p, &k, &r, 30);
    f.hub.exit_start(&p);
    f.advance(EXIT_DELAY / 2);
    assert_eq!(f.hub.settle_one(&r, &v), 30);
    f.advance(EXIT_DELAY);
    assert_eq!(f.hub.withdraw(&p), 70, "sadece kalan");
}

#[test]
fn test_exit_start_is_idempotent() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    f.hub.exit_start(&p);
    let at = f.hub.exit_at_of(&p);
    f.advance(30);
    f.hub.exit_start(&p);
    assert_eq!(f.hub.exit_at_of(&p), at, "sayac ilerlemedi");
}

#[test]
fn test_second_withdraw_fails() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    f.hub.exit_start(&p);
    f.advance(EXIT_DELAY);
    f.hub.withdraw(&p);
    assert_eq!(f.hub.try_withdraw(&p), Err(Ok(Error::EmptyBalance)));
}

// ================= alinan para kesin =================

/// B'ye odeme uzlasti. Kontratin hicbir acik fonksiyonu B'nin imzasi
/// olmadan B'nin toplam varligini (kasa + cuzdan) azaltamiyor.
/// v3.3'te geri alma yok; defterin gelen parayi aninda harcanabilir
/// saymasi buna dayaniyor. ASLA GEVSETME.
#[test]
fn test_received_money_is_final() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let (b, _kb) = f.payer(2, 0); // kayitli: hem odeyen hem alan
    f.hub.settle_one(&b, &f.voucher(&p, &k, &b, 40));
    let total = |f: &Fix| f.hub.balance_of(&b) + f.token.balance(&b);
    assert_eq!(total(&f), 40);

    let attacker = Address::generate(&f.e);
    let until = now(&f) + 60;
    let approval = f.approval(&b, 40, until);
    f.e.set_auths(&[]);

    // B'nin imzasi olmadan: cekim, onayli cekim, cikis
    assert!(f.hub.try_withdraw(&b).is_err());
    assert!(f.hub.try_withdraw_approved(&b, &40, &until, &approval).is_err());
    assert!(f.hub.try_exit_start(&b).is_err());
    // payout kayitli katilimciyi itemez
    assert!(f.hub.try_payout(&b).is_err());
    // B adina sahte fis: B'nin anahtari olmadan imza tutmaz
    let forged = f.voucher(&b, &Key::new(99), &attacker, 40);
    assert!(f.hub.try_settle_one(&attacker, &forged).is_err());

    assert_eq!(total(&f), 40, "B'nin parasi yerinde");
    assert_eq!(f.hub.balance_of(&attacker), 0);
}
