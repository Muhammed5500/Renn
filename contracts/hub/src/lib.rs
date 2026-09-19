#![no_std]
//! Golge Defter - Coktan Coga, Anlik Ajan Odemeleri
//!
//! Ajanlar birbirine aninda oduyor. Kimse kasasindaki paradan fazlasini
//! harcayamiyor. Butun ag tek islemde kapaniyor.
//!
//! Bu kontrat KASA: parayi tutar, iki imzali fisleri netlestirir, ic
//! bakiyeleri gunceller. Harcanabilir bakiyeyi ve kapsami zincir disindaki
//! golge defter (operator) uygular. Kontrat, operatorun kabul imzasi olmayan
//! fisi kabul etmez; defter atlanamaz.
//!
//! Operator para CALAMAZ (fis odeyenin imzasini istiyor, cekim sahibinin
//! imzasini) ve parayi KILITLEYEMEZ (exit_start kacis yolu operatorsuz).
//!
//! Plan: `Son 2 Plan/PLAN-golge-defter.md` v3.3.

use soroban_sdk::{contract, contractimpl, token, Address, Bytes, BytesN, Env, Vec};

mod errors;
mod events;
mod exit;
mod scope;
mod settle;
mod storage;
mod types;
mod voucher;

pub use errors::Error;
pub use types::*;

use storage as st;

#[contract]
pub struct Hub;

#[contractimpl]
impl Hub {
    // ================= kurulum ve kayit =================

    pub fn __constructor(
        e: Env,
        token: Address,
        operator: BytesN<32>,
        exit_delay: u32,
    ) -> Result<(), Error> {
        if exit_delay == 0 {
            return Err(Error::BadConfig);
        }
        st::set_config(
            &e,
            &Config {
                token,
                operator,
                exit_delay,
            },
        );
        Ok(())
    }

    /// Katilimci kendi fis imzalama anahtarini kaydeder.
    ///
    /// `commitment_key` bir Stellar adresi degil, ham 32 baytlik ed25519 acik
    /// anahtari. Sicak anahtar: calinirsa saldirgan, defterin kabul ettigi
    /// kadar (kapsam ve harcanabilir bakiye) harcayabilir. Acik modda bu
    /// saldirganin kendi adresine odeme demek; isimli mod izin listesiyle
    /// sinirlar. Anahtar dondurme YOK (NOTLAR.md).
    ///
    /// SADECE ODEYEN OLACAKLAR icin gerekli. Saf alici join etmez.
    pub fn join(e: Env, who: Address, commitment_key: BytesN<32>) -> Result<(), Error> {
        who.require_auth();
        if st::get_signer(&e, &who).is_some() {
            return Err(Error::AlreadyJoined);
        }
        st::set_signer(&e, &who, &commitment_key);
        events::Joined {
            who,
            key: commitment_key,
        }
        .publish(&e);
        Ok(())
    }

    /// Token'i kontrata ceker, ic bakiyeyi artirir.
    ///
    /// JOIN SARTI YOK. Kasa paranin nereden geldigini sormaz; SPP eklentisinin
    /// sonradan eklenebilmesi buna bagli (plan par.11, madde 2).
    pub fn deposit(e: Env, who: Address, amount: i128) -> Result<(), Error> {
        who.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let cfg = st::get_config(&e)?;
        let t = token::TokenClient::new(&e, &cfg.token);
        t.transfer(&who, &e.current_contract_address(), &amount);

        let nb = st::get_balance(&e, &who)
            .checked_add(amount)
            .ok_or(Error::BadAmount)?;
        st::set_balance(&e, &who, nb);
        events::Deposited {
            who,
            amount,
            balance: nb,
        }
        .publish(&e);
        Ok(())
    }

    /// Odeyenin kendi ajanina koydugu sinirlar. SADECE KAYIT, aninda gecerli.
    /// Golge defter okur ve uygular, zincir uygulamaz.
    pub fn set_scope(e: Env, who: Address, s: Scope) -> Result<(), Error> {
        who.require_auth();
        scope::set_scope(&e, &who, &s)
    }

    // ================= uzlasma (izinsiz) =================

    /// Tek fis. Izin gerektirmez, caller sadece ucreti odeyen taraf.
    /// Kacis yolunda alici kendi kabul edilmis fisini boyle uzlastirir.
    pub fn settle_one(e: Env, caller: Address, v: Voucher) -> Result<i128, Error> {
        let _ = caller;
        settle::settle_one(&e, &v)
    }

    /// Coktan coga netlestirme. Izin gerektirmez.
    /// Eski fis partiyi dusurmez, atlanir. Imza hatasi hala parti geneli.
    pub fn settle_batch(
        e: Env,
        caller: Address,
        vs: Vec<Voucher>,
    ) -> Result<SettleOutcome, Error> {
        let _ = caller;
        settle::settle_batch(&e, &vs)
    }

    // ================= cikis ve cekim =================

    /// Cikis ilani. Kapsami SILMEZ, sadece yeni kapsam konmasini engeller.
    /// Uzlasma bu sure boyunca CALISMAYA DEVAM EDER.
    pub fn exit_start(e: Env, who: Address) -> Result<(), Error> {
        who.require_auth();
        exit::exit_start(&e, &who)
    }

    /// Operator onayli ANINDA cekim. Kismi olabilir. Sadece kayitli katilimci.
    pub fn withdraw_approved(
        e: Env,
        who: Address,
        amount: i128,
        valid_until: u32,
        op_sig: BytesN<64>,
    ) -> Result<i128, Error> {
        who.require_auth();
        exit::withdraw_approved(&e, &who, amount, valid_until, &op_sig)
    }

    /// Operatorsuz cekim, butun bakiye.
    /// Kayitsiz alici: aninda. Kayitli katilimci: exit_start + exit_delay.
    pub fn withdraw(e: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        exit::withdraw(&e, &who)
    }

    /// PASIF ALICI. Izinsiz, parayi sahibine iter. Sadece kayitsiz alici.
    pub fn payout(e: Env, who: Address) -> Result<i128, Error> {
        exit::payout(&e, &who)
    }

    /// Izinsiz. Bir katilimcinin kalici kayitlarinin omrunu uzatir.
    pub fn extend_ttl(e: Env, who: Address) {
        st::touch(&e, &who);
    }

    // ================= okuma =================

    pub fn config(e: Env) -> Result<Config, Error> {
        st::get_config(&e)
    }

    pub fn balance_of(e: Env, who: Address) -> i128 {
        st::get_balance(&e, &who)
    }

    pub fn paid_between(e: Env, payer: Address, recipient: Address) -> i128 {
        st::get_paid(&e, &payer, &recipient)
    }

    pub fn signer_of(e: Env, who: Address) -> Option<BytesN<32>> {
        st::get_signer(&e, &who)
    }

    pub fn scope_of(e: Env, who: Address) -> Option<Scope> {
        st::get_scope(&e, &who)
    }

    /// Cikis ilan edildi mi. Defter bunu gorunce odeyeni kabul etmeyi keser.
    pub fn exit_at_of(e: Env, who: Address) -> Option<u32> {
        st::get_exit_at(&e, &who)
    }

    /// Bir sonraki cekim onayinin tasimasi gereken nonce.
    pub fn withdraw_nonce_of(e: Env, who: Address) -> u64 {
        st::get_withdraw_nonce(&e, &who)
    }

    // ================= imza yukleri (hata ayiklama + SDK) =================
    //
    // Zincir disi taraf (defter, SDK) ayni baytlari uretmek ZORUNDA.
    // Imza tutmuyorsa once buradaki ham baytlarla karsilastir.

    pub fn voucher_preimage(e: Env, payer: Address, recipient: Address, cumulative: i128) -> Bytes {
        voucher::voucher_preimage(&e, &payer, &recipient, cumulative)
    }

    pub fn accept_preimage(e: Env, payer: Address, recipient: Address, cumulative: i128) -> Bytes {
        voucher::accept_preimage(&e, &payer, &recipient, cumulative)
    }

    pub fn withdraw_preimage(
        e: Env,
        who: Address,
        amount: i128,
        nonce: u64,
        valid_until: u32,
    ) -> Bytes {
        voucher::withdraw_preimage(&e, &who, amount, nonce, valid_until)
    }

    pub fn voucher_hash(e: Env, payer: Address, recipient: Address, cumulative: i128) -> BytesN<32> {
        voucher::voucher_hash(&e, &payer, &recipient, cumulative)
    }

    pub fn accept_hash(e: Env, payer: Address, recipient: Address, cumulative: i128) -> BytesN<32> {
        voucher::accept_hash(&e, &payer, &recipient, cumulative)
    }

    pub fn withdraw_hash(
        e: Env,
        who: Address,
        amount: i128,
        nonce: u64,
        valid_until: u32,
    ) -> BytesN<32> {
        voucher::withdraw_hash(&e, &who, amount, nonce, valid_until)
    }

    /// Fisin iki imzasini dogrular. Gecersizse PANIKLER.
    /// Alici hizmeti vermeden once simule ederek kontrol edebilir.
    pub fn verify_voucher(e: Env, v: Voucher) -> Result<(), Error> {
        voucher::verify(&e, &v)
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_voucher;
#[cfg(test)]
mod test_settle;
#[cfg(test)]
mod test_exit;
