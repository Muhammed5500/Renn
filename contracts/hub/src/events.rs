//! Olaylar.
//!
//! CAP-86 UYARISI (Protocol 28): degeri bos olan alanlar artik yayinlanmiyor.
//! Event testlerini alan ADINA gore yaz, pozisyona gore degil.
//!
//! Golge defter `Joined`, `Deposited`, `ExitStarted`, `Withdrawn` ve `Settled`
//! olaylarini dinliyor. Alan adlarini DEGISTIRME.
//!
//! v3.3: makbuz yok, kayit bu olaylardan okunur.

use soroban_sdk::{contractevent, Address, BytesN, Symbol};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Joined {
    #[topic]
    pub who: Address,
    pub key: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub who: Address,
    pub amount: i128,
    pub balance: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub payer: Address,
    #[topic]
    pub recipient: Address,
    pub amount: i128,
    pub cumulative: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchSettled {
    pub total: i128,
    pub settled: u32,
    pub stale: u32,
    pub skipped: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExitStarted {
    #[topic]
    pub who: Address,
    pub at_ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub who: Address,
    pub amount: i128,
    /// approved = operator onayli, exit = kacis yolu,
    /// free = kayitsiz alici, pushed = izinsiz payout
    pub path: Symbol,
}
