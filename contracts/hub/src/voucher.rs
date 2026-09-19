//! The three signed payloads. THE HEART OF THE PROJECT, DON'T RUSH.
//!
//! All follow the same pattern: `sha256( XDR( tuple ) )`, signed with ed25519.
//!
//! | Payload    | Tuple                                                          | Signer   |
//! |------------|----------------------------------------------------------------|----------|
//! | Voucher    | ("batchv3",  network_id, hub, payer, recipient, cumulative)    | payer    |
//! | Acceptance | ("acceptv1", network_id, hub, payer, recipient, cumulative)    | operator |
//! | Withdrawal | ("withdrv1", network_id, hub, who, amount, nonce, valid_until) | operator |
//!
//! | Field | Attack it prevents |
//! |---|---|
//! | domain separator | One payload's signature being taken for another. Voucher and acceptance carry the SAME fields; without the separator the operator's acceptance signature would pass as a voucher signature |
//! | network_id | A testnet signature being used on mainnet |
//! | hub | Reuse on a second contract deployed with the same config |
//! | payer | Someone else's voucher being processed as your debt |
//! | recipient | A voucher being redirected to another recipient |
//! | cumulative | Tampering with the amount. This counter also prevents reuse |
//! | nonce | The same withdrawal approval being used twice |
//! | valid_until | An old approval being used days later |
//!
//! v3.3: `epoch` was REMOVED from the voucher. The cumulative counter prevents
//! reuse; the epoch field had no security role and made vouchers expire in
//! 60 seconds. The `batchv2` -> `batchv3` separator invalidates v3.2 vouchers.
//!
//! THE STRUCTURE IS A TUPLE, NOT A STRUCT. A tuple encodes as an ScVec; a
//! struct becomes an ScMap and the JS side would have to match the key order
//! exactly.
//!
//! WHY A RAW SIGNATURE AND NOT AN AUTH ENTRY (SPEC-imza-yuku.md section 1):
//! 1. An auth entry's lifetime is capped by the network's max_entry_ttl
//!    (~180 days).
//! 2. An auth entry is bound to one call tree and consumed; our voucher is a
//!    cumulative statement that is replaced by a newer one many times.

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

/// The RAW BYTES the payer signs (before hashing).
pub fn voucher_preimage(e: &Env, payer: &Address, recipient: &Address, cumulative: i128) -> Bytes {
    pair_preimage(e, symbol_short!("batchv3"), payer, recipient, cumulative)
}

/// The RAW BYTES of the operator's acceptance signature.
pub fn accept_preimage(e: &Env, payer: &Address, recipient: &Address, cumulative: i128) -> Bytes {
    pair_preimage(e, symbol_short!("acceptv1"), payer, recipient, cumulative)
}

/// The RAW BYTES of the operator's withdrawal approval.
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

/// Verifies BOTH signatures of the voucher: the payer's first, then the operator's.
///
/// CAREFUL: when `ed25519_verify` fails it does not return a Result, it PANICS.
/// Use `should_panic` in tests.
pub fn verify(e: &Env, v: &Voucher) -> Result<(), Error> {
    let key = st::get_signer(e, &v.payer).ok_or(Error::NotJoined)?;
    let op = st::get_config(e)?.operator;

    let msg = voucher_hash(e, &v.payer, &v.recipient, v.cumulative);
    e.crypto().ed25519_verify(&key, &Bytes::from(msg), &v.sig);

    let acc = accept_hash(e, &v.payer, &v.recipient, v.cumulative);
    e.crypto().ed25519_verify(&op, &Bytes::from(acc), &v.op_sig);
    Ok(())
}

/// Verifies the operator's withdrawal approval. PANICS on failure.
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
