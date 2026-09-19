#![cfg(test)]
//! STEP R2 - three payloads and two signatures. THE HEART OF THE PROJECT.

use super::*;
use crate::test::*;
use ed25519_dalek::Signer as _;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    xdr::ToXdr,
    Bytes, BytesN, Env, String,
};

// ---------- payload ----------

#[test]
fn test_preimage_is_deterministic() {
    let f = setup();
    let (p, _k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    assert_eq!(
        f.hub.voucher_preimage(&p, &r, &200_000),
        f.hub.voucher_preimage(&p, &r, &200_000)
    );
}

#[test]
fn test_preimage_changes_with_every_field() {
    let f = setup();
    let (p1, _) = f.payer(1, 100);
    let (p2, _) = f.payer(2, 100);
    let r1 = Address::generate(&f.e);
    let r2 = Address::generate(&f.e);

    let base = f.hub.voucher_preimage(&p1, &r1, &200_000);
    assert_ne!(base, f.hub.voucher_preimage(&p2, &r1, &200_000), "payer");
    assert_ne!(base, f.hub.voucher_preimage(&p1, &r2, &200_000), "recipient");
    assert_ne!(base, f.hub.voucher_preimage(&p1, &r1, &200_001), "cumulative");

    let w = f.hub.withdraw_preimage(&p1, &10, &0, &5000);
    assert_ne!(w, f.hub.withdraw_preimage(&p2, &10, &0, &5000), "who");
    assert_ne!(w, f.hub.withdraw_preimage(&p1, &11, &0, &5000), "amount");
    assert_ne!(w, f.hub.withdraw_preimage(&p1, &10, &1, &5000), "nonce");
    assert_ne!(w, f.hub.withdraw_preimage(&p1, &10, &0, &5001), "valid_until");
}

/// Voucher and acceptance carry the SAME fields. Only the domain separator tells them apart.
#[test]
fn test_preimage_kinds_differ() {
    let f = setup();
    let (p, _) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let v = f.hub.voucher_preimage(&p, &r, &10);
    let a = f.hub.accept_preimage(&p, &r, &10);
    assert_ne!(v, a);
    assert_ne!(f.hub.voucher_hash(&p, &r, &10), f.hub.accept_hash(&p, &r, &10));
}

/// The off-chain side must produce these tuples exactly. If the structure
/// changes this test breaks and says why. The ledger's payload.ts must match.
#[test]
fn test_preimages_match_independent_construction() {
    let f = setup();
    let (p, _k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let net = f.e.ledger().network_id();

    let voucher = (
        symbol_short!("batchv3"),
        net.clone(),
        f.hub_addr.clone(),
        p.clone(),
        r.clone(),
        200_000i128,
    )
        .to_xdr(&f.e);
    assert_eq!(f.hub.voucher_preimage(&p, &r, &200_000), voucher, "voucher tuple");
    let vh: BytesN<32> = f.e.crypto().sha256(&voucher).into();
    assert_eq!(f.hub.voucher_hash(&p, &r, &200_000), vh);

    let accept = (
        symbol_short!("acceptv1"),
        net.clone(),
        f.hub_addr.clone(),
        p.clone(),
        r.clone(),
        200_000i128,
    )
        .to_xdr(&f.e);
    assert_eq!(f.hub.accept_preimage(&p, &r, &200_000), accept, "acceptance tuple");

    let withdraw = (
        symbol_short!("withdrv1"),
        net,
        f.hub_addr.clone(),
        p.clone(),
        50i128,
        3u64,
        9000u32,
    )
        .to_xdr(&f.e);
    assert_eq!(f.hub.withdraw_preimage(&p, &50, &3, &9000), withdraw, "withdrawal tuple");
}

// ---------- payer signature ----------

#[test]
fn test_valid_signature_passes() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    f.hub.verify_voucher(&f.voucher(&p, &k, &r, 40));
}

#[test]
#[should_panic]
fn test_forged_signature_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let mut v = f.voucher(&p, &k, &r, 40);
    v.sig = BytesN::from_array(&f.e, &[9u8; 64]);
    f.hub.verify_voucher(&v);
}

/// A p1 voucher signed with p2's key is rejected.
/// THIS TEST IS THE PROJECT'S LIFELINE: otherwise anyone could sign anyone's debt.
#[test]
#[should_panic]
fn test_wrong_key_fails() {
    let f = setup();
    let (p1, _k1) = f.payer(1, 100);
    let (_p2, k2) = f.payer(2, 100);
    let r = Address::generate(&f.e);
    f.hub.verify_voucher(&f.voucher(&p1, &k2, &r, 40));
}

#[test]
fn test_unregistered_payer_fails() {
    let f = setup();
    let p = f.funded(100);
    let r = Address::generate(&f.e);
    let v = f.voucher(&p, &Key::new(1), &r, 40);
    assert_eq!(f.hub.try_verify_voucher(&v), Err(Ok(Error::NotJoined)));
}

#[test]
#[should_panic]
fn test_amount_tamper_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let mut v = f.voucher(&p, &k, &r, 40);
    v.cumulative = 90;
    f.hub.verify_voucher(&v);
}

#[test]
#[should_panic]
fn test_payer_tamper_fails() {
    let f = setup();
    let (p1, k1) = f.payer(1, 100);
    let (p2, _) = f.payer(2, 100);
    let r = Address::generate(&f.e);
    let mut v = f.voucher(&p1, &k1, &r, 40);
    v.payer = p2;
    f.hub.verify_voucher(&v);
}

#[test]
#[should_panic]
fn test_recipient_tamper_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let mut v = f.voucher(&p, &k, &r, 40);
    v.recipient = Address::generate(&f.e);
    f.hub.verify_voucher(&v);
}

/// A second vault with the same token, operator and payer key.
/// A voucher for the first must not pass on the second.
#[test]
#[should_panic]
fn test_cross_contract_replay_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let v = f.voucher(&p, &k, &r, 40);

    let hub2_addr = f.e.register(Hub, (f.token_addr.clone(), f.op.pubkey(&f.e), EXIT_DELAY));
    let hub2 = HubClient::new(&f.e, &hub2_addr);
    hub2.join(&p, &k.pubkey(&f.e));
    hub2.verify_voucher(&v);
}

#[test]
#[should_panic]
fn test_cross_network_replay_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let v = f.voucher(&p, &k, &r, 40);
    f.e.ledger().set_network_id([42u8; 32]);
    f.hub.verify_voucher(&v);
}

/// A v3.2 voucher (batchv2 + epoch) is invalid in v3.3.
#[test]
#[should_panic]
fn test_v2_domain_rejected() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let old = (
        symbol_short!("batchv2"),
        f.e.ledger().network_id(),
        f.hub_addr.clone(),
        p.clone(),
        r.clone(),
        40i128,
        0u64,
    )
        .to_xdr(&f.e);
    let h: BytesN<32> = f.e.crypto().sha256(&old).into();
    let mut v = f.voucher(&p, &k, &r, 40);
    v.sig = k.sign_hash(&f.e, &h);
    f.hub.verify_voucher(&v);
}

/// Signing the raw XDR instead of the hash: the most common JS mistake.
#[test]
#[should_panic]
fn test_signing_raw_xdr_instead_of_hash_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let raw: Bytes = f.hub.voucher_preimage(&p, &r, &40);
    let mut buf = [0u8; 1024];
    let n = raw.len() as usize;
    raw.copy_into_slice(&mut buf[..n]);
    let mut v = f.voucher(&p, &k, &r, 40);
    v.sig = BytesN::from_array(&f.e, &k.0.sign(&buf[..n]).to_bytes());
    f.hub.verify_voucher(&v);
}

// ---------- operator signature: the ledger cannot be bypassed ----------

/// A voucher that did not go through the ledger. THIS TEST PROVES THE LEDGER CANNOT BE BYPASSED.
#[test]
#[should_panic]
fn test_voucher_without_operator_sig_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let mut v = f.voucher(&p, &k, &r, 40);
    v.op_sig = BytesN::from_array(&f.e, &[0u8; 64]);
    f.hub.verify_voucher(&v);
}

/// An "acceptance" from another key (fake ledger).
#[test]
#[should_panic]
fn test_other_operator_key_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    f.hub.verify_voucher(&f.voucher_by(&p, &k, &r, 40, &Key::new(201)));
}

/// The ledger accepted 10; the payer cannot write 40 and reuse that acceptance.
#[test]
#[should_panic]
fn test_operator_sig_for_other_voucher_fails() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let small = f.voucher(&p, &k, &r, 10);
    let mut v = f.voucher(&p, &k, &r, 40);
    v.op_sig = small.op_sig;
    f.hub.verify_voucher(&v);
}

// ---------- domain separation ----------
//
// Worst case: the operator's key is the SAME as a payer's key. Without the
// separator one payload's signature would pass for the other.

fn op_as_payer(f: &Fix) -> Address {
    let p = f.funded(100);
    f.hub.join(&p, &f.op.pubkey(&f.e));
    f.hub.deposit(&p, &100);
    p
}

/// The operator cannot present its own acceptance signature as a payer signature.
/// NEVER RELAX THIS.
#[test]
#[should_panic]
fn test_accept_sig_not_valid_as_payer_sig() {
    let f = setup();
    let p = op_as_payer(&f);
    let r = Address::generate(&f.e);
    let acc = f.op.sign_hash(&f.e, &f.hub.accept_hash(&p, &r, &40));
    let v = Voucher {
        payer: p,
        recipient: r,
        cumulative: 40,
        sig: acc.clone(),
        op_sig: acc,
    };
    f.hub.verify_voucher(&v);
}

#[test]
#[should_panic]
fn test_payer_sig_not_valid_as_accept_sig() {
    let f = setup();
    let p = op_as_payer(&f);
    let r = Address::generate(&f.e);
    let sig = f.op.sign_hash(&f.e, &f.hub.voucher_hash(&p, &r, &40));
    let v = Voucher {
        payer: p,
        recipient: r,
        cumulative: 40,
        sig: sig.clone(),
        op_sig: sig,
    };
    f.hub.verify_voucher(&v);
}

#[test]
#[should_panic]
fn test_withdraw_sig_not_valid_as_accept_sig() {
    let f = setup();
    let (p, k) = f.payer(1, 100);
    let r = Address::generate(&f.e);
    let mut v = f.voucher(&p, &k, &r, 40);
    v.op_sig = f.op.sign_hash(&f.e, &f.hub.withdraw_hash(&p, &40, &0, &u32::MAX));
    f.hub.verify_voucher(&v);
}

#[test]
fn test_both_sigs_pass_on_fresh_env() {
    // Independent of setup(): the same keys also work in a fresh Env.
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let token_addr = e.register(
        testtoken::TestToken,
        (admin, String::from_str(&e, "T"), String::from_str(&e, "T")),
    );
    let op = Key::new(OP_SEED);
    let hub_addr = e.register(Hub, (token_addr, op.pubkey(&e), EXIT_DELAY));
    let hub = HubClient::new(&e, &hub_addr);
    let p = Address::generate(&e);
    let k = Key::new(3);
    hub.join(&p, &k.pubkey(&e));
    let r = Address::generate(&e);
    let v = Voucher {
        payer: p.clone(),
        recipient: r.clone(),
        cumulative: 7,
        sig: k.sign_hash(&e, &hub.voucher_hash(&p, &r, &7)),
        op_sig: op.sign_hash(&e, &hub.accept_hash(&p, &r, &7)),
    };
    hub.verify_voucher(&v);
}
