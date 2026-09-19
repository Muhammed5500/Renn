# Bilinçli sadeleştirmeler ve bilinen sınırlar

Plan: `Son 2 Plan/PLAN-golge-defter.md` v3.3, §10.

## Kapsam dışı bırakılanlar

| Konu | Durum | Neden |
|---|---|---|
| Mekanik itiraz / geri alma | Kaldırıldı (v3.2'de vardı) | Defter karşılıksız fişi baştan kabul etmiyor. Karşılığı olan ama sahibinin istemediği bir ödeme ise ajanın ve cüzdanın sorunu (bkz. kapsam satırı). |
| Operatör teminatı | Yok | Operatörün hatası kanıtlanabilir (defter açık, fişler imzalı) ama tazmin eden bir mekanizma yok. Yol haritası. |
| Parti başına tek operatör imzası | Yok | Şu an her fişte ayrı kabul imzası var (fiş başına iki `ed25519_verify`). Sınır 190 çift, yeterli. İhtiyaç olursa ilk iyileştirme. |
| Birden fazla operatör | Yok | Sıra tek bir yer gerektiriyor. Birden fazla operatör bir uzlaşı protokolü demek. |
| Anahtar döndürme | Yok | `join` tek seferlik. Sıcak fiş anahtarı çalınırsa katılımcı `exit_start` ile çıkıp yeni adresle girmek zorunda. |
| Kapsam / tavanlar (izin listesi, alıcı ve tur tavanı, süre) | Kaldırıldı (v3.3.1) | Ajanın kandırılması veya anahtarının çalınması cüzdanın işi, ödeme rayının değil. Ray sadece olmayan paranın harcanamamasını garanti ediyor. Harcama politikası alanı da zaten doymuş. |
| Defter içi gizlilik | Yok | Girişte gizlilik var (SPP, README "Private entry"). Kasa içinde operatör kimin kime ödediğini görüyor, uzlaşan çiftler zincirde görünüyor. Kaan (SDF): zincir dışı kısmın gizliliğe gömülmesine gerek yok. |

## v3.2'den taşınan not

v3.2'deki `test_guarantee_and_circular_netting_are_exclusive` testi şunu
gösteriyordu: zincirdeki ödeme gücü değişmezi (tavanların toplamı ≤ bakiye),
dairesel netleştirmeyle aynı anda sağlanamıyor. A'nın 20'si varken B'ye 100
tavan veremez, oysa Sahne 1 tam olarak bunu istiyor. v3.3'ün çıkış noktası bu:
ödeme gücünü zincirde tavanla değil, defterde harcanabilir bakiyeyle takip et.
Gelen para anında sayıldığı için dairesel borç çalışıyor, önek parti sayesinde
zincirde kimse elenmiyor.

## Bilinen sınırlar

- **Kaçış yolunda sıra.** Operatör çökerse alıcılar fişlerini `settle_one` ile
  tek tek uzlaştırır. Dairesel borçta biri, diğerinin önce uzlaşmasını beklemek
  zorunda kalabilir (`InsufficientBalance`, sonra tekrar dene).
- **Operatör `exit_delay` içinde uzlaştırmalı.** Bir ödeyen `exit_start` çağırınca
  defter onu kabul etmeyi keser ve hemen parti gönderir. Defter `exit_delay`
  (demo: 60 ledger) boyunca kapalı kalırsa ödeyen parasını çekebilir, o durumda
  uzlaşmamış fişleri karşılıksız kalır.
- **Çekim ayırmaları.** Defter yeniden başlatılırsa süresi dolmamış ayırmalar
  log'dan geri yüklenir. Süresi dolanlar serbest kalır.
- **RPC olay saklama.** Testnet RPC olayları sınırlı süre saklıyor. Defter olay
  imlecini log'a yazıyor, uzun süre kapalı kalırsa kaçırdığı olaylar için
  adresleri zincirden tazelemek gerekir (`POST /track`).
- **Ücret ölçümleri testnet.** Mainnet'te ölçülmedi (`LIMITS.md`).
- **Geride kalan RPC düğümü.** Testnet RPC birden fazla düğüm. Parti ya da
  çekimden sonra geride kalan bir düğüm eski bakiyeyi döndürürse defter bir
  ödeyenin parasını fazla sanabilirdi. Önlem: zincir istemcisi gördüğü en yüksek
  ledger'ı taban tutar, daha eski durumdan okuyan simülasyonu reddedip tekrar
  dener; çekirdekte zincirde ödenen tutar asla geri düşmez
  (`reconcile_monoton` testi). Bu koruma testlerde hiç tetiklenmedi, yani
  sorunun sıklığı ölçülmedi.
- **Parti tetikleyicisi istendiği ana kadarkini gönderir.** Parti uçuştayken
  gelen fişler kendi tetikleyicisini bekler. Önceki halinde döngü yeni fişleri
  de alıp yoğun trafikte durmadan parti gönderebiliyordu.
- **SPP yatırmaları sırayla.** Aynı havuza aynı anda iki yatırma: ikisi de aynı
  ağaç durumuna göre hazırlandığı için biri zincirde reddediliyor (paralel
  denemede görüldü). Script'ler sırayla yatırıyor.
- **Relayer tek hesap.** SPP çekiminde kaynak relayer, sıra numarasını o kullanıyor.
  Aynı anda bir hesap açma isteği gelirse biri sıra çakışmasıyla düşer, tekrar
  denenmeli. Fee-bump sıra numarası kullanmıyor.
- **Relayer IP görüyor.** Aynı IP'den gelen çekim imzası ve hesap açma isteği
  zincir dışında ilişkilendirilebilir. Zincirdeki bağlantı kopuk.
- **SPP havuzu bizim, doğrulayıcı ve ASP paylaşımlı.** Havuz kontratı SPP'nin
  resmi wasm'ı (hash ff8743f9…), bizim token için kuruldu, sadece engel listesi
  politikası. ASP üyelik ağacına kimseyi eklemek gerekmiyor. Doğrulayıcı ve ASP
  kontratları SPP'nin testnet kurulumu; güvenilir kurulum yerel test kurulumu,
  denetlenmemiş.
