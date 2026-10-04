## Backup i odzyskiwanie po awarii

Buzzdrop służy do krótkotrwałego przekazywania sekretów i plików. Przesyłki są tymczasowe: utratę nieodebranej przesyłki rozwiązujemy przez ponowne wysłanie.

**Zalecana polityka wdrożenia: nie backupować magazynu przesyłek**, w szczególności serwerowych sekretów H i weryfikatorów haseł. Wyłączenie musi obejmować także snapshoty maszyn i wolumenów. Stara kopia mogłaby zachować usunięty sekret, a jej przywrócenie — ponownie umożliwić próbę odbioru.

Po awarii wymagającej odtworzenia magazynu uruchamiamy usługę z pustym magazynem przesyłek, odizolowując poprzednią instancję. Stare linki pozostają nieskuteczne; nieodebrane treści trzeba wysłać ponownie z nowymi sekretami i linkami. Zwykły restart z zachowanym, aktualnym magazynem nie wymaga kasowania przesyłek.

Kod, konfigurację oraz ewentualne konta i rozliczenia można odtwarzać niezależnie. Brak backupu przesyłek ogranicza ryzyko odzyskania H i cofnięcia stanu jednorazowości; nie gwarantuje braku wszelkich wycieków ani nie usuwa wcześniej istniejących kopii sekretów.
