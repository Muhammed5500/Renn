# Bilinçli sadeleştirmeler ve bilinen sınırlar

Plan: `Son 2 Plan/PLAN-golge-defter.md` v3.3, §10.

## Kapsam dışı bırakılanlar

| Konu | Durum | Neden |
|---|---|---|
| Mekanik itiraz / geri alma | Kaldırıldı (v3.2'de vardı) | Defter izni ödeme anında uyguluyor. Kurala aykırı ödeme için iki arıza gerekiyor: ajanın yanlış fiş imzalaması ve defterin onu kaçırması. |
| Operatör teminatı | Yok | Operatörün hatası kanıtlanabilir (defter açık, fişler imzalı) ama tazmin eden bir mekanizma yok. Yol haritası. |
| Parti başına tek operatör imzası | Yok | Şu an her fişte ayrı kabul imzası var (fiş başına iki `ed25519_verify`). Sınır 190 çift, yeterli. İhtiyaç olursa ilk iyileştirme. |
| Birden fazla operatör | Yok | Sıra tek bir yer gerektiriyor. Birden fazla operatör bir uzlaşı protokolü demek. |
| Anahtar döndürme | Yok | `join` tek seferlik. Sıcak fiş anahtarı çalınırsa katılımcı `exit_start` ile çıkıp yeni adresle girmek zorunda. |
| Gizlilik | Yok | Defter açık ve takma adlı. SPP (sınır) kontratta sıfır değişiklik istiyor. Kapalı defter + ZK geçerlilik kanıtı SCF işi. |

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
- **Kapsam zincirde uygulanmıyor.** Bilinçli: zincir kapsamı uzlaşmada kontrol
  etseydi ödeyen, kabulden sonra kapsamını daraltıp kabul edilmiş fişi geçersiz
  kılabilirdi. Kontrat testi: `test_scope_not_enforced_on_chain`.
- **Ücret ölçümleri testnet.** Mainnet'te ölçülmedi (`LIMITS.md`).
