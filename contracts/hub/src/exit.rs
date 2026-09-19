//! Cikis ve cekim. UC YOL, KARISTIRMA:
//!
//! | Yol | Kim | Sart |
//! |---|---|---|
//! | `withdraw_approved` | kayitli katilimci | operator onayi. ANINDA, kismi olabilir |
//! | `withdraw` (exit)   | kayitli katilimci | exit_start + exit_delay. KACIS YOLU, operatorsuz |
//! | `withdraw` (free)   | kayitsiz alici    | yok. Aldigi para kesin, bekletmek icin sebep yok |
//! | `payout`            | kayitsiz alici    | izinsiz itme, para yine sahibine gider |
//!
//! Neden kayitli katilimci operatorsuz ANINDA cekemiyor: imzaladigi ama henuz
//! uzlasmamis fisler olabilir. Operator bunlari bildigi icin onay vermeden
//! once uzlastirir. Operator yoksa exit_delay alicilara bu zamani taniyor.
//!
//! DEGISMEZ: `settle_*` cikis ilan edildikten SONRA da calisir. Bunu engelleyen
//! bir kontrol YAZMA.
//!
//! SPP KURALI (plan par.11, madde 5): para HER ZAMAN `who`'ya gider. Alternatif
//! adres parametresi EKLEME.

use soroban_sdk::{symbol_short, token, Address, BytesN, Env, Symbol};

use crate::errors::Error;
use crate::events;
use crate::storage as st;
use crate::voucher;

/// Cikis ilani. Sayaci baslatir. Kapsami SILMEZ, sadece yenisini engeller.
/// Golge defter bu olayi gorunce odeyeni kabul etmeyi keser ve bekleyen
/// fislerini hemen uzlastirir.
pub fn exit_start(e: &Env, who: &Address) -> Result<(), Error> {
    if st::get_exit_at(e, who).is_some() {
        return Ok(()); // tekrar cagirmak zararsiz, sayac ilerlemesin
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

/// Operator onayli, ANINDA cekim. Sadece kayitli katilimci.
pub fn withdraw_approved(
    e: &Env,
    who: &Address,
    amount: i128,
    valid_until: u32,
    op_sig: &BytesN<64>,
) -> Result<i128, Error> {
    if st::get_signer(e, who).is_none() {
        return Err(Error::NotJoined); // kayitsiz olan withdraw kullanir
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

/// Operatorsuz cekim, butun bakiye.
/// Kayitsiz alici: aninda. Kayitli katilimci: exit_start + exit_delay.
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

/// PASIF ALICI. Izinsiz, parayi sahibine iter. Alici hicbir sey kurmadan,
/// sadece bir cuzdan adresi olarak para alabilir.
/// Kayitli katilimci icin calismaz, cikis kapisini atlatirdi.
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
