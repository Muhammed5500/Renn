# Ölçülmüş sınırlar (ADIM L)

19 Eylül 2026, Stellar testnet (Protocol 28), kasa `CANRTUBN...BUCQ4M`.
Ölçüm: `ledger/scripts/limits.ts`. `settle_batch` simülasyonu, her fişte iki
`ed25519_verify` (ödeyen + operatör). Simülasyon deterministik.

## Parti başına çift sayısı

| Çift (fiş) | Talimat | Yazma | İşlem boyutu | Ücret, yeni çiftler |
|---:|---:|---:|---:|---:|
| 1 | 2,15 M | 484 B | 0,7 KB | 0,031 XLM |
| 10 | 15,3 M | 2,9 KB | 4,9 KB | 0,191 XLM |
| 40 | 62,9 M | 9,4 KB | 18,8 KB | 0,755 XLM |
| 100 | 177,6 M | 22,5 KB | 46,7 KB | 1,885 XLM |
| 150 | 292,5 M | 33,4 KB | 69,9 KB | 2,827 XLM |
| **190** | **395,8 M** | 42,1 KB | 88,4 KB | 3,582 XLM |
| 200 | aşıldı | | | `Budget, ExceededLimit` |

**Tek işlemde en fazla ~190 çift.** Sınırı talimat bütçesi (400 M) belirliyor,
işlem boyutu değil. Fiş başına ~1,95 M talimat.

Defterin varsayılan `MAX_PAIRS` değeri **150** (bütçenin ~%75'i).

Bir çift, bir partide kaç ödeme içerirse içersin tek fiştir. 150 çiftlik bir
parti binlerce ödemeyi kapatabilir.

## Ücret: yeni çift ile tekrar eden çift

Aynı 40 çift, iki parti arka arkaya:

| | 40 çiftin ücreti | Çift başına |
|---|---:|---:|
| İlk uzlaşma (yeni depolama kayıtları) | 0,756 XLM | 0,0189 XLM |
| Aynı çiftler tekrar (kayıtlar var) | **0,036 XLM** | **0,0009 XLM** |

İlk uzlaşmadaki ücretin neredeyse tamamı yeni kayıtların (çift sayacı, alıcı
bakiyesi) 30 günlük kirası. Tek seferlik bir maliyet.

## Karşılaştırma (dikkatli kullan)

Araştırmada mainnet'te ölçülen bir x402 `exact` ödemesi: 23.579 stroop
(0,0024 XLM). Aynı ölçümdeki dolar karşılığı $0,000411.

| | XLM |
|---|---:|
| x402, ödeme başına | 0,0024 |
| Gölge defter, tekrar eden çift, **parti başına** | 0,0009 |
| Gölge defter, yeni çift, ilk kez | 0,0189 |

Yani tekrar eden bir çiftte, partide **tek ödeme** olsa bile maliyet x402'nin
altında. Ödeme sayısı arttıkça fark ödeme sayısıyla orantılı büyüyor. Yeni bir
çiftin ilk uzlaşması ise yaklaşık 8 x402 ödemesi kadar tutuyor.

**Sunumda:** "ucuz" deme, bu sayıları söyle. Testnet ücretleri mainnet'le aynı
ağ ayarlarına dayanıyor ama mainnet'te ölçülmedi, bunu da söyle.

## Ölçülmeyenler

- Mainnet ücreti.
- Ödeyen sayısı arttıkça sabit nokta döngüsünün tur sayısı. Defter önek parti
  kurduğu için döngü pratikte tek turda bitiyor (hiç eleme yok).
- Olay boyutu sınırı (190 çiftte sorun çıkmadı).
