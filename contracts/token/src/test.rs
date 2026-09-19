#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::Address as _, Env};

fn setup(e: &Env) -> TestTokenClient<'_> {
    let admin = Address::generate(e);
    let id = e.register(
        TestToken,
        (
            admin,
            String::from_str(e, "Test USD"),
            String::from_str(e, "TUSD"),
        ),
    );
    TestTokenClient::new(e, &id)
}

#[test]
fn test_mint_and_balance() {
    let e = Env::default();
    e.mock_all_auths();
    let t = setup(&e);
    let u = Address::generate(&e);
    t.mint(&u, &1_000_0000000);
    assert_eq!(t.balance(&u), 1_000_0000000);
}

#[test]
fn test_transfer_moves_balance() {
    let e = Env::default();
    e.mock_all_auths();
    let t = setup(&e);
    let a = Address::generate(&e);
    let b = Address::generate(&e);
    t.mint(&a, &100);
    t.transfer(&a, &b, &40);
    assert_eq!(t.balance(&a), 60);
    assert_eq!(t.balance(&b), 40);
}

#[test]
fn test_transfer_insufficient_fails() {
    let e = Env::default();
    e.mock_all_auths();
    let t = setup(&e);
    let a = Address::generate(&e);
    let b = Address::generate(&e);
    t.mint(&a, &10);
    assert_eq!(
        t.try_transfer(&a, &b, &40),
        Err(Ok(TokenError::InsufficientBalance))
    );
}

#[test]
fn test_decimals_is_seven() {
    let e = Env::default();
    let t = setup(&e);
    assert_eq!(t.decimals(), 7);
}

#[test]
fn test_transfer_from_uses_allowance() {
    let e = Env::default();
    e.mock_all_auths();
    let t = setup(&e);
    let a = Address::generate(&e);
    let s = Address::generate(&e);
    let b = Address::generate(&e);
    t.mint(&a, &100);
    t.approve(&a, &s, &50, &1000);
    t.transfer_from(&s, &a, &b, &30);
    assert_eq!(t.balance(&b), 30);
    assert_eq!(t.allowance(&a, &s), 20);
}
