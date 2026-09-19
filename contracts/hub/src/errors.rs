use soroban_sdk::contracterror;

/// Hata kodlari. Numaralar PLAN-golge-defter.md par.4'ten birebir alindi.
///
/// OLU olarak isaretli olanlar eski mimarilerden kalma. Numaralari KAYDIRMA,
/// yerinde birak - disaridaki her sey (defter, SDK, demo) bu numaralara bagli.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// exit_delay == 0
    BadConfig = 1,
    // NotFunder = 2,            OLU (v1)
    // NotArbiter = 3,           OLU (v1)
    // NotRecipient = 4,         OLU (v2)
    /// delta <= 0 (settle_one). settle_batch'te hata degil, fis atlanir.
    StaleVoucher = 5,
    /// odeyenin bakiyesi delta'yi karsilamiyor (settle_one)
    InsufficientBalance = 6,
    EmptyBatch = 7,
    // DuplicateRecipient = 8,   OLU (v2)
    // NoReceipt = 9,            OLU (v3.3: makbuz yok)
    // WindowPassed = 10,        OLU (v3.3: itiraz yok)
    // AlreadyDisputed = 11,     OLU (v3.3: itiraz yok)
    // AlreadyResolved = 12,     OLU (v2)
    // NotClosing = 13,          OLU (v2)
    // TooEarly = 14,            OLU (v2)
    // OpenDispute = 15,         OLU (v3.2)
    NotInitialized = 16,
    // MixedEpoch = 17,          OLU (v3.3: tur yok)
    // ReceiptExists = 18,       OLU (v3.3: makbuz yok)
    /// kacis yolunda exit_delay dolmadi
    NotWithdrawable = 19,
    // NoScope = 20,             OLU (v3.3.1: kapsam kaldirildi)
    // NoViolation = 21,         OLU (v3.3: itiraz yok)
    // BadOpening = 22,          gizlilik, yok
    EmptyBalance = 23,
    /// payer kayitli degil
    NotJoined = 24,
    AlreadyJoined = 25,
    /// kayitli katilimci exit_start cagirmadan operatorsuz cekmeye calisti
    NotExiting = 26,
    SelfPayment = 27,
    /// ayni (payer, recipient) partide iki kez
    DuplicatePair = 28,
    // BadEpoch = 29,            OLU (v3.3: tur yok)
    // InsufficientBond = 30,    OLU (v3.3: teminat yok)
    /// kayitli katilimci payout ile itilemez
    NotPushable = 31,
    // OverCommitted = 32,       OLU (v3.3: odeme gucu defterde)
    // OverRecipientCap = 33,    OLU (v3.3: kapsam defterde)
    // Exiting = 34,             OLU (v3.3.1: kapsam kaldirildi)
    /// v3.3: tutar <= 0 ya da tasma
    BadAmount = 35,
    /// v3.3: cekim onayinin suresi (valid_until) gecti
    ApprovalExpired = 36,
    /// v3.3: onayli cekim tutari bakiyeden buyuk
    ExceedsBalance = 37,
}
