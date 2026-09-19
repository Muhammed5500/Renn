#![cfg(test)]
//! STEP R4 - withdrawal, three paths.

use super::*;
use crate::test::*;
use soroban_sdk::testutils::Address as _;

fn now(f: &Fix) -> u32 {
    f.e.ledger().sequence()
}

// ================= approved by the operator, instant =================

#[test]
fn test_withdraw_approved_instant() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    let until = now(&f) + 60;
    let sig = f.approval(&p, 100, until);
    assert_eq!(f.hub.withdraw_approved(&p, &100, &until, &sig), 100);
    assert_eq!(f.token.balance(&p), 100, "no exit_start, no wait");
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

/// The same approval cannot be used twice: the nonce moved on, the signature no longer matches.
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

/// B cannot withdraw with A's approval.
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

/// The amount in the approval cannot be changed.
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

/// The approval alone is not enough to withdraw, the owner's signature is also needed.
/// Even if the operator signs an approval, it cannot send the money to anyone.
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

// ================= unregistered recipient =================

/// What it received is final, no reason to make it wait.
#[test]
fn test_pure_recipient_withdraws_anytime() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 40));
    assert_eq!(f.hub.withdraw(&r), 40, "in the same ledger, no window");
    assert_eq!(f.token.balance(&r), 40);
}

#[test]
fn test_payout_pushes_to_pure_recipient() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 40));
    f.e.set_auths(&[]); // a third address, no signature at all
    assert_eq!(f.hub.payout(&r), 40);
    assert_eq!(f.token.balance(&r), 40, "the money went to its owner");
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

// ================= escape hatch (no operator) =================

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

/// Even if the operator goes down, the money is yours. NEVER RELAX THIS.
#[test]
fn test_exit_path_after_delay() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    f.hub.exit_start(&p);
    f.advance(EXIT_DELAY);
    assert_eq!(f.hub.withdraw(&p), 100);
    assert_eq!(f.token.balance(&p), 100);
}

/// Exit announced, delay not over, settlement still goes through.
/// A payer cannot escape its debt by announcing an exit. NEVER RELAX THIS.
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
    assert_eq!(f.hub.withdraw(&p), 70, "only what is left");
}

#[test]
fn test_exit_start_is_idempotent() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    f.hub.exit_start(&p);
    let at = f.hub.exit_at_of(&p);
    f.advance(30);
    f.hub.exit_start(&p);
    assert_eq!(f.hub.exit_at_of(&p), at, "the countdown did not move");
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

// ================= received money is final =================

/// A payment to B settled. No public function of the contract can reduce
/// B's total holdings (vault + wallet) without B's signature.
/// v3.3 has no clawback; the ledger counting incoming money as spendable
/// right away depends on this. NEVER RELAX THIS.
#[test]
fn test_received_money_is_final() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let (b, _kb) = f.payer(2, 0); // registered: both payer and recipient
    f.hub.settle_one(&b, &f.voucher(&p, &k, &b, 40));
    let total = |f: &Fix| f.hub.balance_of(&b) + f.token.balance(&b);
    assert_eq!(total(&f), 40);

    let attacker = Address::generate(&f.e);
    let until = now(&f) + 60;
    let approval = f.approval(&b, 40, until);
    f.e.set_auths(&[]);

    // without B's signature: withdraw, approved withdraw, exit
    assert!(f.hub.try_withdraw(&b).is_err());
    assert!(f.hub.try_withdraw_approved(&b, &40, &until, &approval).is_err());
    assert!(f.hub.try_exit_start(&b).is_err());
    // payout cannot push a registered participant
    assert!(f.hub.try_payout(&b).is_err());
    // forged voucher in B's name: without B's key the signature does not verify
    let forged = f.voucher(&b, &Key::new(99), &attacker, 40);
    assert!(f.hub.try_settle_one(&attacker, &forged).is_err());

    assert_eq!(total(&f), 40, "B's money is intact");
    assert_eq!(f.hub.balance_of(&attacker), 0);
}
