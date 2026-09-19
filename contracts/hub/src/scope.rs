//! Kapsam: odeyenin kendi ajanina koydugu sinirlar.
//!
//! v3.3: SADECE KAYIT. Aninda gecerli, gecikme yok, zincirde uygulanmaz.
//! Golge defter her fisi kabul etmeden once okur ve uygular (plan par.3.2).
//!
//! Neden zincirde tutuluyor: seffaflik (defterin kararlari herkesce kontrol
//! edilebilir) ve odeyenin ana anahtariyla dogrulanmis olmasi.
//!
//! Neden gecikme yok: v3.2'de kapsam uzlasmada zincirde kontrol ediliyordu,
//! daraltma kabul edilmis fisi gecersiz kilabiliyordu. Artik uzlasma kapsama
//! bakmiyor; daraltma sadece YENI fisleri etkiliyor.

use soroban_sdk::{Address, Env};

use crate::errors::Error;
use crate::events;
use crate::storage as st;
use crate::types::Scope;

pub fn set_scope(e: &Env, who: &Address, s: &Scope) -> Result<(), Error> {
    if s.max_per_round < 0 {
        return Err(Error::BadConfig);
    }
    for (_, cap) in s.limits.iter() {
        if cap < 0 {
            return Err(Error::BadConfig);
        }
    }
    // Cikis ilan edildiyse yeni kapsam konamaz. Eskisi SILINMEZ.
    if st::get_exit_at(e, who).is_some() {
        return Err(Error::Exiting);
    }
    st::set_scope(e, who, s);
    events::ScopeSet {
        who: who.clone(),
        max_per_round: s.max_per_round,
        expires_ledger: s.expires_ledger,
    }
    .publish(e);
    Ok(())
}
