---
name: excalidraw-json
description: Describes the JSON structure of .excalidraw files. Use when creating, editing, or parsing Excalidraw files programmatically, or when the user asks about Excalidraw JSON schema, element types, or file format.
---

# Struktura JSON plików Excalidraw

Plik `.excalidraw` to prawidłowy JSON. Główny obiekt ma pola: `type`, `version`, `source`, `elements`, `appState`, `files`.

## Root (główny obiekt)

| Pole | Typ | Opis |
|------|-----|------|
| `type` | string | Zawsze `"excalidraw"` |
| `version` | number | Wersja schematu (np. `2`) |
| `source` | string | Np. `"https://excalidraw.com"` |
| `elements` | array | Tablica elementów (kształty, tekst, strzałki) |
| `appState` | object | Stan aplikacji (tło, siatka itd.) |
| `files` | object | Dane obrazów dla elementów `image`; zwykle `{}` |

**appState** (minimalnie):
- `gridSize` (number), `viewBackgroundColor` (hex, np. `"#ffffff"`)

---

## Wspólne pola elementów (elements[].*)

Każdy element w `elements` ma m.in.:

| Pole | Typ | Opis |
|------|-----|------|
| `id` | string | Unikalny identyfikator (np. nanoid lub czytelny) |
| `type` | string | `"rectangle"` \| `"text"` \| `"arrow"` \| `"ellipse"` \| `"diamond"` |
| `x`, `y` | number | Pozycja (px) |
| `width`, `height` | number | Wymiary (px) |
| `angle` | number | Obrót (radiany), zwykle `0` |
| `strokeColor` | string | Kolor obrysu (hex) |
| `backgroundColor` | string | Kolor wypełnienia (hex lub `"transparent"`) |
| `fillStyle` | string | Np. `"solid"` |
| `strokeWidth` | number | Grubość linii |
| `roughness` | number | „Ręczny” styl, zwykle `1` |
| `opacity` | number | 0–100 |
| `groupIds` | array | Zazwyczaj `[]` |
| `frameId` | string \| null | Id ramki, zwykle `null` |
| `roundness` | object \| null | Zaokrąglenie; dla prostokąta `{ "type": 3 }` |
| `seed` | number | Ziarno stylu |
| `version` | number | Wersja elementu |
| `versionNonce` | number | Nonce |
| `isDeleted` | boolean | `false` |
| `boundElements` | array \| null | Odniesienia do strzałek itd. |
| `updated` | number | Timestamp lub liczba |
| `link` | string \| null | Link, zwykle `null` |
| `locked` | boolean | `false` |

---

## type: "rectangle"

Prostokąt. Wspólne pola + brak dodatkowych obowiązkowych.

- `roundness`: `null` (proste rogi) lub `{ "type": 3 }` (zaokrąglone).
- `boundElements`: opcjonalnie `[{ "id": "arrow-id", "type": "arrow" }]` gdy do ramki są przypięte strzałki.

---

## type: "text"

Tekst. Wspólne pola +:

| Pole | Typ | Opis |
|------|-----|------|
| `text` | string | Wyświetlana treść (może zawierać `\n`) |
| `originalText` | string | To samo co `text` |
| `fontSize` | number | Rozmiar (px) |
| `fontFamily` | number | 1 = Normal/Helvetica, 2 = Virgil, 3 = Cascadia, 4 = Assistant |
| `textAlign` | string | `"left"` \| `"center"` \| `"right"` |
| `verticalAlign` | string | `"top"` \| `"middle"` \| `"bottom"` |
| `containerId` | string \| null | Id prostokąta, w którym jest tekst (tekst w ramce) |
| `lineHeight` | number | Np. `1.25` |
| `baseline` | number | Linia bazowa (px) |

**Tekst w ramce:** ustaw `containerId` na `id` prostokąta. W tablicy `elements` umieść ten tekst **przed** elementem prostokąta.

---

## type: "arrow"

Strzałka. Wspólne pola +:

| Pole | Typ | Opis |
|------|-----|------|
| `points` | array | Tablica `[[x0,y0], [x1,y1], ...]` współrzędnych względem (x,y) elementu |
| `lastCommittedPoint` | array \| null | Ostatni punkt; często `null` |
| `startBinding` | object \| null | `{ "elementId": "id-prostokąta", "focus": 0, "gap": 1 }` |
| `endBinding` | object \| null | Jak wyżej – element na końcu strzałki |
| `startArrowhead` | string \| null | Np. `null` |
| `endArrowhead` | string \| null | `"arrow"` dla grotu |

- `width` i `height` wynikają z bounding box punktów (np. prosta strzałka: `points: [[0,0], [78,0]]` → width 78, height 0).
- Aby strzałka łączyła dwa prostokąty, ustaw `startBinding.elementId` i `endBinding.elementId` na ich `id`. Odpowiednie prostokąty powinny mieć w `boundElements` odniesienie do tej strzałki.

---

## Kolejność elementów

- Elementy **wewnątrz** ramki (teksty z `containerId`) umieszczaj **przed** elementem prostokąta-ramki.
- Dla poprawnego renderowania ramek (frames) w Excalidraw: najpierw dzieci ramki, potem ramka.

---

## Przykład minimalnego pliku

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "id": "text-1",
      "type": "text",
      "x": 20,
      "y": 20,
      "width": 120,
      "height": 24,
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": null,
      "seed": 1,
      "version": 1,
      "versionNonce": 1,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false,
      "text": "Etykieta",
      "fontSize": 16,
      "fontFamily": 1,
      "textAlign": "left",
      "verticalAlign": "top",
      "containerId": null,
      "originalText": "Etykieta",
      "lineHeight": 1.25,
      "baseline": 14
    },
    {
      "id": "box-1",
      "type": "rectangle",
      "x": 10,
      "y": 10,
      "width": 140,
      "height": 44,
      "angle": 0,
      "strokeColor": "#1971c2",
      "backgroundColor": "#a5d8ff",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": { "type": 3 },
      "seed": 2,
      "version": 1,
      "versionNonce": 1,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false
    }
  ],
  "appState": {
    "gridSize": 20,
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
```

W tym projekcie przy tworzeniu/edycji diagramów stosuj też reguły z `.cursor/rules/excalidraw.mdc` (paleta kolorów, font, styl architect, tekst w ramce).
