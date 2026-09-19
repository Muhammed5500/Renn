use soroban_sdk::{contracttype, Address, BytesN, Map, Vec};

/// Kurulum ayarlari. Instance storage'da.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// SEP-41 token. ARAYUZDUR - kodda bu adrese dair hicbir varsayim olmayacak.
    /// SPP eklentisinin sonradan eklenebilmesi buna bagli (plan par.11, madde 1).
    pub token: Address,
    /// Golge defterin (operatorun) ham ed25519 acik anahtari. Kontrat, bu
    /// anahtarin kabul imzasi olmayan fisi kabul etmez; defter atlanamaz.
    pub operator: BytesN<32>,
    /// Kayitli katilimcinin operatorsuz cekimi (KACIS YOLU) icin bekleme,
    /// ledger cinsinden. Operatorun ya da alicilarin bekleyen fisleri
    /// uzlastirmasina zaman tanir.
    pub exit_delay: u32,
}

// NOT: imzalanan yukler STRUCT degil TUPLE. Tanimlari ve gerekcesi
// voucher.rs dosyasinin basinda.

/// Zincir disindan gelen fis. IKI IMZA tasir.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Voucher {
    pub payer: Address,
    pub recipient: Address,
    /// Bu CIFT icin bugune kadarki toplam. Her yeni fis bir oncekinin
    /// yerine gecer. Tekrar kullanimi bu sayac engeller.
    pub cumulative: i128,
    /// payer'in kayitli commitment_key'i ile, "batchv3" yuku uzerinde.
    pub sig: BytesN<64>,
    /// Operatorun kabul imzasi, "acceptv1" yuku uzerinde.
    pub op_sig: BytesN<64>,
}

/// Odeyenin kendi ajanina koydugu sinirlar.
///
/// v3.3: ZINCIRDE UYGULANMAZ. Golge defter her fisi kabul etmeden once bunu
/// okur ve uygular. Zincirde tutulmasinin sebebi seffaflik ve odeyenin ana
/// anahtariyla dogrulanmis olmasi.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Scope {
    /// BOS = acik mod: herkese odenebilir.
    /// DOLU = izin listesi + alici basina KUMULATIF tavan.
    pub limits: Map<Address, i128>,
    /// Defterin turu (demo 30 sn) basina bu odeyenin toplam harcama tavani.
    pub max_per_round: i128,
    /// Bu ledger'dan sonra defter bu odeyenin fisini kabul etmez.
    pub expires_ledger: u32,
}

/// settle_batch sonucu.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettleOutcome {
    /// Uygulanan toplam fark.
    pub total: i128,
    /// Uygulanan fis sayisi.
    pub settled: u32,
    /// v3.3: eski ya da zaten uzlasmis oldugu icin ATLANAN fis sayisi.
    /// Parti bunlar yuzunden dusmez.
    pub stale: u32,
    /// Odemesi karsiliksiz kalan payer'lar. Defter onek parti kurdugu surece
    /// BOS kalir; dolu gelmesi defterde bir hata demektir.
    pub skipped: Vec<Address>,
}
