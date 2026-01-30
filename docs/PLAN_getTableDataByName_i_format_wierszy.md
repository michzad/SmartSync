# Plan: getTableDataByName – miejsca użycia i proponowane zmiany

## 1. Gdzie funkcja **jest** używana

| Plik | Miejsce | Opis |
|------|--------|------|
| **Main.js** | ok. 52 | `urlData = getTableDataByName(settings.controlTableName, settings.maxApiRetries)` – odczyt tabeli kontrolnej (urls). Zwraca tablicę obiektów (wiersz = obiekt z kluczami = nazwy kolumn). Main.js waliduje wymagane kolumny (`h.id`, `h.last_mod`, `h.last_upd`) i używa `row[h.id]`, `row[h.last_mod]`, `row[h.last_upd]`, `row._rowIndex`. **Użycie poprawne.** |

---

## 2. Gdzie funkcja **mogłaby** być używana (i propozycje)

### 2.1 SyncEngine.js – `fetchSmartTargetState`

- **Obecnie:** Pobiera dane arkuszy przez `Sheets.Spreadsheets.Values.batchGet` z zakresem **`"!A:Z"`** (hardcoded). Dla arkuszy z >26 kolumnami dane są ucięte, co powoduje błąd „header consistency failed”.
- **Propozycja:**  
  - Rozszerzyć `getTableDataByName` w Helpers.js o opcjonalne parametry: `ssId`, `meta` (odpowiedź `Sheets.Spreadsheets.get`), aby można było wywołać ją z SyncEngine bez ponownego pobierania metadanych.  
  - W `fetchSmartTargetState` dla każdego `sheetName` z konfiguracji:  
    - jeśli arkusz ma **named table** – użyć rozszerzonej `getTableDataByName(ssId, sheetName, meta)` (lub nazwy tabeli, w zależności od API) i zapisać w `state.values` **tablicę obiektów** (jak dziś zwraca getTableDataByName).  
    - jeśli **brak** named table – fallback: pobrać zakres `"!A:" + columnToLetter(grid.columnCount)` i zapisać **tablicę tablic** (obecne zachowanie).  
  - Dzięki temu arkusze z tabelami mają pełną liczbę kolumn i spójne nagłówki; reszta pozostaje bez zmian.

### 2.2 Configuration.js – `getDataRangesConfig` / `checkComponentStatus`

- **getDataRangesConfig:** Buduje konfigurację wyłącznie z `settings.dataRanges` (bez odczytu z arkusza). **Nie ma sensu** używać `getTableDataByName` – brak tabeli do odczytu po nazwie.
- **checkComponentStatus:** Sprawdza istnienie arkusza i poprawność wiersza nagłówkowego (np. control / logs). Odczytuje `getRange(1,1,1,lastCol).getValues()[0]`. Teoretycznie można by użyć `getTableDataByName` dla arkusza „urls”/„logs”, ale: (a) status potrzebuje tylko nagłówka, (b) wymagałoby to spójnej konfiguracji nazw tabel. **Propozycja:** zostawić bez zmian (prosty odczyt wiersza 1).

### 2.3 Helpers.js – `updateTimestampInTable`

- Ustawia jedną komórkę (timestamp) wg nazwy nagłówka. Korzysta z `sheet.getRange(1,1,1,lastCol).getValues()[0]` i `indexOf(targetHeader)`. **Nie potrzebuje** pełnych danych tabeli; wystarczy wykrycie indeksu kolumny. **Brak zmiany.**

### 2.4 SyncEngine.js – `readAndTrimSourceData`

- Czyta **źródła** (inne spreadsheet’y) po **zakresach** z konfiguracji (`cfg.range`), nie po nazwie tabeli w docelowym arkuszu. **getTableDataByName** dotyczy aktywnego/docelowego arkusza i tabel po nazwie. **Brak zmiany.**

---

## 3. Miejsca, które **muszą** obsłużyć oba formaty danych

Po wprowadzeniu punktu 2.1 w `state.values` mogą występować:
- **tablica obiektów** (wiersz = `{ Source_ID, kolumna2, ... }`) – gdy dane z named table przez `getTableDataByName`,
- **tablica tablic** (wiersz = `[id, v2, ...]`) – fallback lub arkusze bez tabeli.

### 3.1 Main.js – `buildSyncQueue`

- **Obecnie:** `var data = targetState.values.get(sheetName) || [];` potem `data[j][0]` traktowane jako Source_ID (zakłada tablicę tablic).
- **Propozycja:** Przy budowaniu `destIds` dla każdego wiersza `data[j]` (j ≥ 1) obsłużyć oba formaty:  
  - jeśli `data[j]` jest obiektem i ma własność `Source_ID` → użyć `data[j].Source_ID` (lub `data[j]['Source_ID']`),  
  - w przeciwnym razie → `data[j][0]` (obecne zachowanie).  
  Np. pomocnicza funkcja `getSourceIdFromRow(row)` zwracająca `(row && typeof row === 'object' && !Array.isArray(row) && row.Source_ID != null) ? String(row.Source_ID) : (row && row[0] != null ? String(row[0]) : null)` i użycie jej w pętli.

### 3.2 SyncEngine.js – `processTableDataSync`

- **Obecnie:** Zakłada `currentData = targetState.values.get(sheetName)` jako tablicę tablic; `headers = currentData[0]`; walidacja „pierwsza kolumna = Source_ID” i ścisła kolejność nagłówków.
- **Propozycja (już w planie obiektowym):**  
  - Na początku wykryć format: czy `currentData[0]` to tablica (nagłówek jako tablica), czy `currentData[0]` to obiekt (pierwszy wiersz danych jako obiekt).  
  - **Jeśli tablica obiektów:**  
    - wymagane kolumny: `Source_ID` + wszystkie z `sourceRows[0]`;  
    - sprawdzić, że każdy wiersz ma te klucze;  
    - zdefiniować **kolejność** kolumn do zapisu: `['Source_ID', ...sourceRows[0]]`;  
    - przekonwertować `currentData` na tablicę tablic (nagłówek + wiersze w tej kolejności) i dalej używać istniejącej logiki.  
  - **Jeśli tablica tablic:** bez zmian – obecna walidacja nagłówka i dalsze przetwarzanie.

---

## 4. Podsumowanie zadań

1. **Helpers.js** – Rozszerzyć `getTableDataByName(targetTableName, maxRetries, ssId?, meta?)`: gdy podane `ssId` (i opcjonalnie `meta`), używać ich zamiast `SpreadsheetApp.getActiveSpreadsheet()` i ponownego `Sheets.Spreadsheets.get`. Zachować zwracanie tablicy obiektów lub `null`/`[]`.
2. **SyncEngine.js** – W `fetchSmartTargetState`: dla każdego arkusza z konfiguracji próbować pobrać dane przez rozszerzoną `getTableDataByName` (jeśli arkusz ma named table); w przeciwnym razie fallback `A:columnToLetter(grid.columnCount)`. Zapis w `state.values`: albo tablica obiektów, albo tablica tablic.
3. **Main.js** – W `buildSyncQueue`: przy zbieraniu `destIds` z `targetState.values` obsłużyć oba formaty wiersza (obiekt z `Source_ID` vs tablica z `[0]`), np. przez `getSourceIdFromRow(row)`.
4. **SyncEngine.js** – W `processTableDataSync`: na wejściu rozpoznać format `currentData`; dla tablicy obiektów – walidacja po nazwach kolumn, ustalenie kolejności, konwersja na tablicę tablic; dalej bez zmian.

Po tych zmianach funkcja `getTableDataByName` będzie używana spójnie (kontrola + docelowe arkusze z tabelami), a wszystkie odczyty `targetState.values` będą obsługiwać oba formaty wierszy.
