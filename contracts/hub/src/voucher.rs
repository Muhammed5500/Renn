//! Uc imza yuku. PROJENIN KALBI, ACELE ETME.
//!
//! Hepsi ayni kalip: `sha256( XDR( tuple ) )`, uzerinde ed25519.
//!
//! | Yuk   | Tuple                                                          | Imzalayan |
//! |-------|----------------------------------------------------------------|-----------|
//! | Fis   | ("batchv3",  network_id, hub, payer, recipient, cumulative)    | odeyen    |
//! | Kabul | ("acceptv1", network_id, hub, payer, recipient, cumulative)    | operator  |
//! | Cekim | ("withdrv1", network_id, hub, who, amount, nonce, valid_until) | operator  |
//!
//! | Alan | Engelledigi saldiri |
//! |---|---|
//! | domain ayraci | Bir yukun imzasinin baska bir yuk sanilmasi. Fis ve kabul AYNI alanlari tasiyor, ayrac olmasa operatorun kabul imzasi fis imzasi yerine gecerdi |
//! | network_id | Testnet imzasinin mainnet'te kullanilmasi |
//! | hub | Ayni config'le dagitilmis ikinci kontratta tekrar kullanim |
//! | payer | Baskasinin fisinin senin borcunmus gibi islenmesi |
//! | recipient | Fisin baska aliciya yonlendirilmesi |
//! | cumulative | Tutar oynatma. Tekrar kullanimi da bu sayac engelliyor |
//! | nonce | Ayni cekim onayinin iki kez kullanilmasi |
//! | valid_until | Eski bir onayin gunler sonra kullanilmasi |
//!
//! v3.3: fisten `epoch` KALKTI. Tekrar kullanimi kumulatif sayac engelliyor,
//! tur alaninin guvenlik gorevi yoktu ve fisin 60 saniyede olmesine yol
//! aciyordu. `batchv2` -> `batchv3` ayraci v3.2 fislerini gecersiz kilar.
//!
//! YAPI BIR TUPLE, STRUCT DEGIL. Tuple ScVec olarak kodlanir; struct ScMap
//! olur ve JS tarafinda anahtar siralamasini birebir tutturmak zorundasin.
//!
//! NEDEN AUTH ENTRY DEGIL HAM IMZA (SPEC-imza-yuku.md par.1):
//! 1. Yetki kaydinin omru ag ayarindaki max_entry_ttl ile sinirli (~180 gun).
//! 2. Yetki kaydi tek cagri agacina baglanir ve tuketilir; bizim fisimiz
//!    defalarca yerine yenisi gecen kumulatif bir beyan.

use soroban_sdk::{symbol_short, xdr::ToXdr, Address, Bytes, BytesN, Env, Symbol};

use crate::errors::Error;
use crate::storage as st;
use crate::types::Voucher;

fn pair_preimage(
    e: &Env,
    domain: Symbol,
    payer: &Address,
    recipient: &Address,
    cumulative: i128,
) -> Bytes {
    (
        domain,
        e.ledger().network_id(),
        e.current_contract_address(),
        payer.clone(),
        recipient.clone(),
        cumulative,
    )
        .to_xdr(e)
}

/// Odeyenin imzaladigi HAM BAYTLAR (hash'ten once).
pub fn voucher_preimage(e: &Env, payer: &Address, recipient: &Address, cumulative: i128) -> Bytes {
    pair_preimage(e, symbol_short!("batchv3"), payer, recipient, cumulative)
}

/// Operatorun kabul imzasinin HAM BAYTLARI.
pub fn accept_preimage(e: &Env, payer: &Address, recipient: &Address, cumulative: i128) -> Bytes {
    pair_preimage(e, symbol_short!("acceptv1"), payer, recipient, cumulative)
}

/// Operatorun cekim onayinin HAM BAYTLARI.
pub fn withdraw_preimage(
    e: &Env,
    who: &Address,
    amount: i128,
    nonce: u64,
    valid_until: u32,
) -> Bytes {
    (
        symbol_short!("withdrv1"),
        e.ledger().network_id(),
        e.current_contract_address(),
        who.clone(),
        amount,
        nonce,
        valid_until,
    )
        .to_xdr(e)
}

fn hash(e: &Env, b: &Bytes) -> BytesN<32> {
    e.crypto().sha256(b).into()
}

pub fn voucher_hash(e: &Env, payer: &Address, recipient: &Address, cumulative: i128) -> BytesN<32> {
    hash(e, &voucher_preimage(e, payer, recipient, cumulative))
}

pub fn accept_hash(e: &Env, payer: &Address, recipient: &Address, cumulative: i128) -> BytesN<32> {
    hash(e, &accept_preimage(e, payer, recipient, cumulative))
}

pub fn withdraw_hash(
    e: &Env,
    who: &Address,
    amount: i128,
    nonce: u64,
    valid_until: u32,
) -> BytesN<32> {
    hash(e, &withdraw_preimage(e, who, amount, nonce, valid_until))
}

/// Fisin IKI imzasini da dogrular: once odeyenin, sonra operatorun.
///
/// DIKKAT: `ed25519_verify` basarisiz olursa Result dondurmez, PANIKLER.
/// Testlerde `should_panic` kullan.
pub fn verify(e: &Env, v: &Voucher) -> Result<(), Error> {
    let key = st::get_signer(e, &v.payer).ok_or(Error::NotJoined)?;
    let op = st::get_config(e)?.operator;

    let msg = voucher_hash(e, &v.payer, &v.recipient, v.cumulative);
    e.crypto().ed25519_verify(&key, &Bytes::from(msg), &v.sig);

    let acc = accept_hash(e, &v.payer, &v.recipient, v.cumulative);
    e.crypto().ed25519_verify(&op, &Bytes::from(acc), &v.op_sig);
    Ok(())
}

/// Operatorun cekim onayini dogrular. Basarisizlikta PANIKLER.
pub fn verify_withdraw(
    e: &Env,
    who: &Address,
    amount: i128,
    nonce: u64,
    valid_until: u32,
    op_sig: &BytesN<64>,
) -> Result<(), Error> {
    let op = st::get_config(e)?.operator;
    let msg = withdraw_hash(e, who, amount, nonce, valid_until);
    e.crypto().ed25519_verify(&op, &Bytes::from(msg), op_sig);
    Ok(())
}
