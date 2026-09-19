//! Exit and withdrawal. THREE PATHS, DON'T MIX THEM UP:
//!
//! | Path | Who | Condition |
//! |---|---|---|
//! | `withdraw_approved` | registered participant  | operator approval. INSTANT, can be partial |
//! | `withdraw` (exit)   | registered participant  | exit_start + exit_delay. ESCAPE HATCH, no operator |
//! | `withdraw` (free)   | unregistered recipient  | none. What it received is final, no reason to wait |
//! | `payout`            | unregistered recipient  | permissionless push, the money still goes to its owner |
//!
//! Why a registered participant cannot withdraw INSTANTLY without the
//! operator: it may have signed vouchers that are not settled yet. The
//! operator knows them and settles them before approving. Without the
//! operator, exit_delay gives the recipients that time.
//!
//! INVARIANT: `settle_*` keeps working AFTER an exit is announced. Do NOT add
//! a check that blocks it.
//!
//! SPP RULE (plan section 11, item 5): the money ALWAYS goes to `who`. Do NOT
//! add an alternative address parameter.

use soroban_sdk::{symbol_short, token, Address, BytesN, Env, Symbol};

use crate::errors::Error;
use crate::events;
use crate::storage as st;
use crate::voucher;

/// Exit announcement. Starts the countdown.
/// When the shadow ledger sees this event it stops accepting the payer's
/// vouchers and settles the pending ones right away.
pub fn exit_start(e: &Env, who: &Address) -> Result<(), Error> {
    if st::get_exit_at(e, who).is_some() {
        return Ok(()); // calling again is harmless; the countdown must not move
    }
    let at = e.ledger().sequence();
    st::set_exit_at(e, who, at);
    events::ExitStarted {
        who: who.clone(),
        at_ledger: at,
    }
    .publish(e);
    Ok(())
}

fn send(e: &Env, who: &Address, amount: i128, path: Symbol) -> Result<i128, Error> {
    let cfg = st::get_config(e)?;
    let b = st::get_balance(e, who);
    let t = token::TokenClient::new(e, &cfg.token);
    t.transfer(&e.current_contract_address(), who, &amount);
    st::set_balance(e, who, b - amount);
    events::Withdrawn {
        who: who.clone(),
        amount,
        path,
    }
    .publish(e);
    Ok(amount)
}

/// INSTANT withdrawal approved by the operator. Registered participants only.
pub fn withdraw_approved(
    e: &Env,
    who: &Address,
    amount: i128,
    valid_until: u32,
    op_sig: &BytesN<64>,
) -> Result<i128, Error> {
    if st::get_signer(e, who).is_none() {
        return Err(Error::NotJoined); // unregistered recipients use withdraw
    }
    if amount <= 0 {
        return Err(Error::BadAmount);
    }
    if e.ledger().sequence() > valid_until {
        return Err(Error::ApprovalExpired);
    }
    let nonce = st::get_withdraw_nonce(e, who);
    voucher::verify_withdraw(e, who, amount, nonce, valid_until, op_sig)?;
    if amount > st::get_balance(e, who) {
        return Err(Error::ExceedsBalance);
    }
    st::set_withdraw_nonce(e, who, nonce + 1);
    send(e, who, amount, symbol_short!("approved"))
}

/// Withdrawal without the operator, the whole balance.
/// Unregistered recipient: immediately. Registered participant:
/// exit_start + exit_delay.
pub fn withdraw(e: &Env, who: &Address) -> Result<i128, Error> {
    let b = st::get_balance(e, who);
    if b == 0 {
        return Err(Error::EmptyBalance);
    }
    if st::get_signer(e, who).is_none() {
        return send(e, who, b, symbol_short!("free"));
    }
    let cfg = st::get_config(e)?;
    let exit_at = st::get_exit_at(e, who).ok_or(Error::NotExiting)?;
    if e.ledger().sequence() < exit_at + cfg.exit_delay {
        return Err(Error::NotWithdrawable);
    }
    send(e, who, b, symbol_short!("exit"))
}

/// PASSIVE RECIPIENT. Permissionless, pushes the money to its owner. A
/// recipient can receive money with nothing set up, as just a wallet address.
/// Does not work for registered participants: it would bypass the exit gate.
pub fn payout(e: &Env, who: &Address) -> Result<i128, Error> {
    if st::get_signer(e, who).is_some() {
        return Err(Error::NotPushable);
    }
    let b = st::get_balance(e, who);
    if b == 0 {
        return Err(Error::EmptyBalance);
    }
    send(e, who, b, symbol_short!("pushed"))
}
