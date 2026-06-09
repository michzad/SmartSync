# SmartSync — TODO

## Ustalenia (zaimplementowane v1.5.0)

| # | Decyzja | Status |
|---|---------|--------|
| 1 | Kolumny dat: **TEXT** + format `yyyy-MM-dd HH:mm:ss` | done |
| 2 | **Execute**: jeden przycisk **Sync** = check + sync (`runCheckAndSync`) | done (v1.5.1) |
| 3 | **Sync Schedule**: jeden harmonogram, bez max age | done |
| 4 | `last_sync_datetime` — tylko po udanym sync | done |
| 5 | UI: jeden harmonogram, bez „Add schedule” | done |

---

## UI / UX (v1.5.x)

### Execute — hint (spójny z innymi `?`)
- [x] Tekst w `help-icon`, nie osobny akapit
- [x] Treść: Check obejmuje **wszystkie** źródła z `urls`; mechanizm zależy od stanu daty:
  - brak `last_modified_datetime` → bezpośredni odczyt z Drive (`Files.get`)
  - jest data → batch lista plików zmienionych od `last_check_datetime`
  - Sync (jedna komenda) → check, potem kopia danych dla oznaczonych wierszy

### Sync Schedule
- [x] Usunąć **Run now** — harmonogram włącza się przez **Active + Save Changes** (`updateCheckSchedule`)
- [x] Hint przy Active: zapis wymagany do utworzenia/usunięcia triggera

### Data Ranges
- [x] Zwijane karty (`<details>`) — zwinięte pokazują tylko nazwę tabeli (lub `(unnamed)`)

---

## Logika Check (backend — do weryfikacji)

Check powinien przechodzić **wszystkie** wiersze `urls`; różnica to tylko sposób pobrania daty:
- [ ] Potwierdzić w `performCheck`: iteracja po wszystkich wierszach (bez pomijania wierszy z datą spoza listy zmian)
- [ ] Wiersz z datą poza listą zmian → zachować istniejącą datę (bez wywołania API)

---

## Pozostałe

- [ ] Testy ręczne: Check, Sync po Check, Schedule (Save + Active), błąd Drive API
- [x] `clasp push` po zmianach UI
