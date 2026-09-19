//! Uzlasma ve coktan coga netlestirme.
//!
//! EN ONEMLI KURAL: uzlasmada HIC TOKEN TRANSFERI YOK. Sadece ic bakiye
//! defteri degisir. Kontratin token bakiyesi bir kurus kipirdamaz.

use soroban_sdk::{Address, Env, Map, Vec};

use crate::errors::Error;
use crate::events;
use crate::storage as st;
use crate::types::{SettleOutcome, Voucher};
use crate::voucher;

/// Dogrulanmis bir fisin uygulanmasi. Bakiye kontrolu YAPMAZ, cagiran yapar.
fn apply_one(e: &Env, v: &Voucher, delta: i128) {
    let bp = st::get_balance(e, &v.payer);
    let br = st::get_balance(e, &v.recipient);

    // <-- TOKEN TRANSFERI YOK, sadece defter
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

/// Fisin yeni getirdigi fark. <= 0 ise fis eski ya da zaten uzlasmis.
fn delta_of(e: &Env, v: &Voucher) -> Result<i128, Error> {
    let paid = st::get_paid(e, &v.payer, &v.recipient);
    v.cumulative.checked_sub(paid).ok_or(Error::BadAmount)
}

// ================= tek fis =================

/// Kacis yolunda alicinin kendi fisini tek basina uzlastirmasi da bu.
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

// ================= coktan coga netlestirme =================

/// Uc gecisli: dogrulama, sabit noktaya kadar netlestirme, uygulama.
///
/// ATOMIKLIK ODEYEN BASINA, PARTI BASINA DEGIL. Karsiliksiz bir odeyen
/// partiyi dusurmez, sadece kendi fisleri elenir. Golge defter partiyi kabul
/// sirasinin bir ONEKI olarak kurdugu icin normalde kimse elenmez; dongu bir
/// guvenlik agi olarak duruyor.
///
/// v3.3: ESKI FIS PARTIYI DUSURMEZ, ATLANIR. Yoksa partideki herhangi bir
/// alici kendi fisini bir saniye once `settle_one` ile uzlastirip butun
/// partiyi sabote edebilirdi.
///
/// Imza hatasi, SelfPayment ve DuplicatePair ise HALA parti geneli: bunlar
/// partiyi kuranin hatasi, sonradan disaridan tetiklenemez.
pub fn settle_batch(e: &Env, vs: &Vec<Voucher>) -> Result<SettleOutcome, Error> {
    if vs.is_empty() {
        return Err(Error::EmptyBatch);
    }

    // ---------- 1. DOGRULAMA ----------
    // Hicbir sey degistirmeden. Imza hatasi butun partiyi dusurur.
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

        // imza: basarisizsa panikler, butun parti duser
        voucher::verify(e, &v)?;

        let d = delta_of(e, &v)?;
        if d <= 0 {
            stale += 1;
            deltas.push_back(0); // 0 = atla
        } else {
            deltas.push_back(d);
        }
    }

    // ---------- 2. NETLESTIRME, SABIT NOKTAYA KADAR ----------
    //
    // Bir katilimci AYNI PARTIDE aldigi parayla odeyebilir. A'nin 20 birimi
    // var, B'ye 100 borclu, C'den 80 alacakli: net borcu 20, odeyebilir.
    // Ama C elenirse A da odeyemez hale gelir. Dongu bunu yakalar.
    //
    // Her tur en az bir payer eledigi icin sonlanir.
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

        // aktifi YENIDEN KUR. Elenen payer'in fisleri aktifte kalirsa
        // dongu sonsuza gider.
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

    // ---------- 3. UYGULAMA ----------
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
