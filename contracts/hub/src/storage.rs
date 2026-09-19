use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::types::{Config, Scope};

/// KURAL: uzlasma icin kritik hicbir veri gecici (temporary) depolamaya
/// yazilmaz. Gecici veri silinince geri gelmez.
///
/// v3.3: makbuz, tur dizini, olgunlasma ve bekleyen kapsam anahtarlari KALKTI.
#[contracttype]
pub enum DataKey {
    /// instance
    Config,
    /// persistent: ham ed25519 acik anahtari
    Signer(Address),
    /// persistent: ic bakiye
    Balance(Address),
    /// persistent: kapsam (defter okur, zincir uygulamaz)
    Scope(Address),
    /// persistent: (payer, recipient) kumulatif
    Paid(Address, Address),
    /// persistent: exit_start ledger'i
    ExitAt(Address),
    /// persistent: operator onayli cekimlerin sayaci
    WithdrawNonce(Address),
}

pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const BUMP_THRESHOLD: u32 = 25 * DAY_IN_LEDGERS;

fn bump(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_AMOUNT);
}

fn get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(e: &Env, k: &DataKey) -> Option<V> {
    e.storage().persistent().get(k)
}

fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(e: &Env, k: DataKey, v: &V) {
    e.storage().persistent().set(&k, v);
    bump(e, &k);
}

// ---------- config ----------

pub fn get_config(e: &Env) -> Result<Config, Error> {
    e.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)
}

pub fn set_config(e: &Env, cfg: &Config) {
    e.storage().instance().set(&DataKey::Config, cfg);
    e.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

// ---------- signer ----------

pub fn get_signer(e: &Env, who: &Address) -> Option<BytesN<32>> {
    get(e, &DataKey::Signer(who.clone()))
}

pub fn set_signer(e: &Env, who: &Address, key: &BytesN<32>) {
    put(e, DataKey::Signer(who.clone()), key);
}

// ---------- bakiye ----------

pub fn get_balance(e: &Env, who: &Address) -> i128 {
    get(e, &DataKey::Balance(who.clone())).unwrap_or(0)
}

pub fn set_balance(e: &Env, who: &Address, amount: i128) {
    put(e, DataKey::Balance(who.clone()), &amount);
}

// ---------- kapsam ----------

pub fn get_scope(e: &Env, who: &Address) -> Option<Scope> {
    get(e, &DataKey::Scope(who.clone()))
}

pub fn set_scope(e: &Env, who: &Address, s: &Scope) {
    put(e, DataKey::Scope(who.clone()), s);
}

// ---------- cift bazli kumulatif ----------

pub fn get_paid(e: &Env, payer: &Address, recipient: &Address) -> i128 {
    get(e, &DataKey::Paid(payer.clone(), recipient.clone())).unwrap_or(0)
}

pub fn set_paid(e: &Env, payer: &Address, recipient: &Address, amount: i128) {
    put(e, DataKey::Paid(payer.clone(), recipient.clone()), &amount);
}

// ---------- cikis ----------

pub fn get_exit_at(e: &Env, who: &Address) -> Option<u32> {
    get(e, &DataKey::ExitAt(who.clone()))
}

pub fn set_exit_at(e: &Env, who: &Address, at: u32) {
    put(e, DataKey::ExitAt(who.clone()), &at);
}

// ---------- cekim onayi sayaci ----------

pub fn get_withdraw_nonce(e: &Env, who: &Address) -> u64 {
    get(e, &DataKey::WithdrawNonce(who.clone())).unwrap_or(0)
}

pub fn set_withdraw_nonce(e: &Env, who: &Address, n: u64) {
    put(e, DataKey::WithdrawNonce(who.clone()), &n);
}

/// Izinsiz TTL uzatma. Bir katilimcinin kalici anahtarlarina dokunur.
/// Cift bazli `Paid` anahtarlari her uzlasmada zaten uzatiliyor.
pub fn touch(e: &Env, who: &Address) {
    e.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
    for k in [
        DataKey::Signer(who.clone()),
        DataKey::Balance(who.clone()),
        DataKey::Scope(who.clone()),
        DataKey::ExitAt(who.clone()),
        DataKey::WithdrawNonce(who.clone()),
    ] {
        if e.storage().persistent().has(&k) {
            bump(e, &k);
        }
    }
}
