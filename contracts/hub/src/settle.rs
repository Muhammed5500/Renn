//! Settlement and many-to-many netting.
//!
//! THE MOST IMPORTANT RULE: settlement makes NO TOKEN TRANSFER. Only the
//! internal balance book changes. The contract's token balance does not move
//! by a single unit.

use soroban_sdk::{Address, Env, Map, Vec};

use crate::errors::Error;
use crate::events;
use crate::storage as st;
use crate::types::{SettleOutcome, Voucher};
use crate::voucher;

/// Applies a verified voucher. Does NOT check the balance, the caller does.
fn apply_one(e: &Env, v: &Voucher, delta: i128) {
    let bp = st::get_balance(e, &v.payer);
    let br = st::get_balance(e, &v.recipient);

    // <-- NO TOKEN TRANSFER, only the book
    st::set_balance(e, &v.payer, bp - delta);
    st::set_balance(e, &v.recipient, br + delta);
    st::set_paid(e, &v.payer, &v.recipient, v.cumulative);

    events::Settled {
        payer: v.payer.clone(),
        recipient: v.recipient.clone(),
        amount: delta,
        cumulative: v.cumulative,
    }
    .publish(e);
}

/// The new delta the voucher brings. <= 0 means the voucher is stale or already settled.
fn delta_of(e: &Env, v: &Voucher) -> Result<i128, Error> {
    let paid = st::get_paid(e, &v.payer, &v.recipient);
    v.cumulative.checked_sub(paid).ok_or(Error::BadAmount)
}

// ================= single voucher =================

/// This is also how a recipient settles its own voucher alone in escape mode.
pub fn settle_one(e: &Env, v: &Voucher) -> Result<i128, Error> {
    if v.payer == v.recipient {
        return Err(Error::SelfPayment);
    }
    voucher::verify(e, v)?;

    let delta = delta_of(e, v)?;
    if delta <= 0 {
        return Err(Error::StaleVoucher);
    }
    if st::get_balance(e, &v.payer) < delta {
        return Err(Error::InsufficientBalance);
    }
    apply_one(e, v, delta);

    events::BatchSettled {
        total: delta,
        settled: 1,
        stale: 0,
        skipped: 0,
    }
    .publish(e);
    Ok(delta)
}

// ================= many-to-many netting =================

/// Three passes: verification, netting to a fixed point, application.
///
/// ATOMICITY IS PER PAYER, NOT PER BATCH. An unbacked payer does not fail the
/// batch, only its own vouchers are dropped. Because the shadow ledger builds
/// each batch as a PREFIX of its acceptance order, normally nobody is
/// dropped; the loop stays as a safety net.
///
/// v3.3: A STALE VOUCHER DOES NOT FAIL THE BATCH, IT IS SKIPPED. Otherwise any
/// recipient in the batch could settle its own voucher with `settle_one` a
/// second earlier and sabotage the whole batch.
///
/// A bad signature, SelfPayment and DuplicatePair STILL fail the whole batch:
/// they are mistakes of whoever built the batch and cannot be triggered from
/// outside afterwards.
pub fn settle_batch(e: &Env, vs: &Vec<Voucher>) -> Result<SettleOutcome, Error> {
    if vs.is_empty() {
        return Err(Error::EmptyBatch);
    }

    // ---------- 1. VERIFICATION ----------
    // Changes nothing. A bad signature fails the whole batch.
    let n = vs.len();
    let mut deltas: Vec<i128> = Vec::new(e);
    let mut seen: Map<(Address, Address), bool> = Map::new(e);
    let mut stale: u32 = 0;

    for v in vs.iter() {
        if v.payer == v.recipient {
            return Err(Error::SelfPayment);
        }
        let pair = (v.payer.clone(), v.recipient.clone());
        if seen.contains_key(pair.clone()) {
            return Err(Error::DuplicatePair);
        }
        seen.set(pair, true);

        // signature: panics on failure, the whole batch fails
        voucher::verify(e, &v)?;

        let d = delta_of(e, &v)?;
        if d <= 0 {
            stale += 1;
            deltas.push_back(0); // 0 = skip
        } else {
            deltas.push_back(d);
        }
    }

    // ---------- 2. NETTING, TO A FIXED POINT ----------
    //
    // A participant can pay with money received IN THE SAME BATCH. A holds 20,
    // owes B 100, is owed 80 by C: its net debt is 20, it can pay.
    // But if C is dropped, A can no longer pay either. The loop catches this.
    //
    // It terminates because every round drops at least one payer.
    let mut bad: Map<Address, bool> = Map::new(e);
    let mut active: Vec<bool> = Vec::new(e);
    for i in 0..n {
        active.push_back(deltas.get_unchecked(i) > 0);
    }

    loop {
        let mut net: Map<Address, i128> = Map::new(e);
        for i in 0..n {
            if !active.get_unchecked(i) {
                continue;
            }
            let v = vs.get_unchecked(i);
            let d = deltas.get_unchecked(i);
            net.set(v.payer.clone(), net.get(v.payer.clone()).unwrap_or(0) - d);
            net.set(
                v.recipient.clone(),
                net.get(v.recipient.clone()).unwrap_or(0) + d,
            );
        }

        let mut newly_bad = false;
        for (who, delta_net) in net.iter() {
            if st::get_balance(e, &who) + delta_net < 0 {
                bad.set(who, true);
                newly_bad = true;
            }
        }
        if !newly_bad {
            break;
        }

        // REBUILD the active set. If a dropped payer's vouchers stayed active
        // the loop would never end.
        let mut any_active = false;
        for i in 0..n {
            let v = vs.get_unchecked(i);
            let ok = deltas.get_unchecked(i) > 0 && !bad.contains_key(v.payer.clone());
            active.set(i, ok);
            any_active |= ok;
        }
        if !any_active {
            break;
        }
    }

    // ---------- 3. APPLICATION ----------
    let mut total: i128 = 0;
    let mut settled: u32 = 0;
    for i in 0..n {
        if !active.get_unchecked(i) {
            continue;
        }
        let d = deltas.get_unchecked(i);
        apply_one(e, &vs.get_unchecked(i), d);
        total += d;
        settled += 1;
    }

    let mut skipped: Vec<Address> = Vec::new(e);
    for (who, _) in bad.iter() {
        skipped.push_back(who);
    }

    events::BatchSettled {
        total,
        settled,
        stale,
        skipped: skipped.len(),
    }
    .publish(e);

    Ok(SettleOutcome {
        total,
        settled,
        stale,
        skipped,
    })
}
