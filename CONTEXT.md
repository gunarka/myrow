# CONTEXT.md — Woodrower Trainer

> Briefing für Claude Code (oder jeden anderen, der hier weiterbaut).
> Stand: Mai 2026. Zuletzt aktualisiert: 2026-05-26.

## 1 · Worum geht's

Lokale Webapp, mit der man **Intervall­trainings für ein FTMS-Rudergerät**
(primär: Decathlon Woodrower) entwirft, abspeichert, live durchführt
und im Verlauf auswertet.
Vorlage für die Dashboard-UI war ein Screenshot der Kinomap-App.

Zielgruppe: ein einzelner Nutzer, lokal auf dem eigenen Rechner.
Keine Auth, keine Mandanten, keine Cloud.

## 2 · Architektur (Kurzfassung)

```
                                  Bluetooth LE
                                 ┌─────────────┐
                                 │   Rower     │
                                 │ (FTMS GATT) │
                                 └──────┬──────┘
                                        │ notify on 0x2AD1
                                        │ write   on 0x2AD9 (resistance)
                                        ▼
┌──────────────────────────────────────────────────────────┐
│  server.py  (FastAPI, async)                             │
│    • bleak scanner + GATT client                         │
│    • parse_rower_data()  →  dict                         │
│    • set_resistance()  →  FTMS Control Point write       │
│    • ConnectionManager (WebSocket fan-out)               │
│    • DuckDB CRUD: workouts, sessions, samples            │
│    • Kinomap import (TCX/PWX/CSV/ZIP) via defusedxml     │
└──────────┬───────────────────────────────┬───────────────┘
           │ HTTP / WS                     │ read/write
           ▼                               ▼
  ┌────────────────────┐         ┌──────────────────────┐
  │  index.html (SPA)  │         │  woodrower.duckdb    │
  │   list / editor /  │         └──────────────────────┘
  │   dashboard /      │
  │   history          │
  │   Canvas chart     │
  └────────────────────┘
```

Single-process. Kein Build-Step. Eine eingebettete DuckDB-Datei.

## 3 · Dateien

| Datei                | Zweck                                              | Größe    |
|----------------------|----------------------------------------------------|----------|
| `server.py`          | FastAPI-Backend, FTMS-Parser, WS, DuckDB-Layer     | ~1906 Z  |
| `kinomap_import.py`  | TCX/PWX/CSV/ZIP-Parser für Kinomap-Exporte         | ~486 Z   |
| `index.html`         | SPA-Shell (nur HTML), lädt static/                 | ~446 Z   |
| `static/app.js`      | Gesamte SPA-Logik (alle Views, WS, Canvas-Chart)   | ~2762 Z  |
| `static/style.css`   | Alle CSS-Regeln (inkl. Dark Mode)                  | ~567 Z   |
| `start.sh`           | Venv aktivieren + `python server.py` starten       | –        |
| `config.json`        | BLE-Adresse + Verbindungsparameter des Geräts      | –        |
| `woodrower.duckdb`   | DB-Datei (Workouts, Sessions, Samples)             | wächst   |
| `requirements.txt`   | fastapi, uvicorn, bleak, duckdb, defusedxml, fit-tool, … | 8 Zeilen |
| `README.md`          | Endnutzer-Anleitung                                | –        |
| `CONTEXT.md`         | dieses Dokument                                    | –        |

`ble_test.py` wurde entfernt (war ein interaktives Debug-Tool, nicht mehr im Repo).

## 4 · Datenmodell

### 4.1 · Workout (Plan)

```jsonc
{
  "Pyramide 5×": {
    "start":        { "duration_s": 180, "resistance_pct": 15 },
    "repeat_count": 5,
    "steps": [
      { "duration_s": 60, "resistance_pct": 25 },
      { "duration_s": 30, "resistance_pct": 40 },
      { "duration_s": 60, "resistance_pct": 25 },
      { "duration_s": 60, "resistance_pct": 15 }
    ],
    "end":          { "duration_s": 180, "resistance_pct": 15 }
  }
}
```

**Interpretation der „Wiederholung":** `repeat_count` × `steps` (ein Block
mit beliebig vielen Schritten, der N-mal wiederholt wird). Das matcht das
Muster im Original-Screenshot (blau-grün-orange-grün-blau ×5).

**Einheit der Intensität:** `resistance_pct` (0–100 %). Das Dashboard ruft
beim Segmentwechsel `set_resistance(pct)` auf, das den Wert auf den
Geräte-Widerstands­level umrechnet. Alte Workouts mit `watts`-Schlüssel
werden beim Öffnen im Editor genauso gelesen (`rPct = resistance_pct ?? watts`).

### 4.2 · Session (aufgezeichnetes Training)

Tabelle `sessions` (Aggregate):
`id, workout_name, workout_snapshot, started_at, ended_at, duration_s,
total_distance, avg_power, max_power, avg_spm, avg_pace, avg_hr,
total_energy, completed, max_spm, max_hr, best_pace,
bmr_kcal, exercise_kcal, total_kcal, user_id`.

Tabelle `samples` (1 Zeile pro FTMS-Notify-Paket):
`session_id, t_sec, sample_time, power, spm, pace, distance, hr, energy`.

Aktive Sessions leben in `ActiveSession` im RAM und werden beim
*Pause/Resume/Stop* oder beim Erreichen der `totalSec` finalisiert.
Importierte Kinomap-Sessions setzen `completed=TRUE` und schreiben das
Quellformat in `workout_snapshot`.

### 4.3 · WebSocket-Nachrichten (Server → Browser)

```jsonc
// Verbindungsstatus
{ "type": "status", "connected": true, "address": "AA:BB:..." }
{ "type": "status", "connected": false }

// Aktueller Widerstand (initial + bei jedem Set)
{ "type": "resistance", "level_pct": 50, "simulated": false }

// Live-Werte (kommt pro FTMS-Notify-Paket, ca. 1 Hz)
{
  "type":     "rower",
  "power":    42,     // W                | null wenn nicht im Paket
  "spm":      30.0,   // Schläge/min      | null
  "pace":     130,    // s pro 500 m      | null
  "distance": 1234,   // m gesamt         | null
  "hr":       null,   // bpm              | null
  "energy":   12      // kcal gesamt      | null
}
```

Browser → Server schickt nur Keepalive-Pings; alle echten Aktionen
gehen über REST.

### 4.4 · FTMS Rower Data Characteristic (`0x2AD1`)

Layout siehe Bluetooth FTMS Spec. Parser in `parse_rower_data()` deckt
alle Felder ab:

| Flag-Bit | Feld                      | Typ        | Einheit          |
|----------|---------------------------|------------|------------------|
| –        | stroke_rate               | uint8      | 0.5 / min        |
| –        | stroke_count              | uint16     | Schläge          |
| 0x0001   | More-Data-Flag (steuert die zwei obigen) | | |
| 0x0002   | avg_stroke_rate           | uint8      | 0.5 / min        |
| 0x0004   | total_distance            | uint24     | m                |
| 0x0008   | instantaneous_pace        | uint16     | s / 500 m        |
| 0x0010   | average_pace              | uint16     | s / 500 m        |
| 0x0020   | instantaneous_power       | sint16     | W                |
| 0x0040   | average_power             | sint16     | W                |
| 0x0080   | resistance_level          | sint16     | –                |
| 0x0100   | total_energy + /h + /min  | u16+u16+u8 | kcal             |
| 0x0200   | heart_rate                | uint8      | bpm              |
| 0x0400   | metabolic_equivalent      | uint8      | 0.1              |
| 0x0800   | elapsed_time              | uint16     | s                |
| 0x1000   | remaining_time            | uint16     | s                |

Bit 0 ("More Data") = 1 → `stroke_rate`/`stroke_count` sind in diesem
Paket **nicht** enthalten (Fragmentierung).

### 4.5 · FTMS Control Point (`0x2AD9`)

`set_resistance(level)` schickt zwei Schreibvorgänge:

1. Beim ersten Set einmalig `[0x00]` = *Request Control*.
2. Danach `[0x04, level*10 little-endian sint16]` = *Set Target Resistance Level*.

Faktor 10 entspricht der FTMS-Spec (RES in 0.1-Schritten), Woodrower-
Bereich ist 0..15.

## 5 · HTTP/WS-API

### Workouts

| Methode | Pfad                       | Funktion                          |
|---------|----------------------------|-----------------------------------|
| GET     | `/`                        | SPA ausliefern                    |
| GET     | `/api/workouts`            | alle Trainings als Map            |
| GET     | `/api/workouts/{name}`     | einzelnes Training                |
| PUT     | `/api/workouts/{name}`     | speichern/überschreiben (mit Validation) |
| DELETE  | `/api/workouts/{name}`     | löschen                           |

### Sessions

| Methode | Pfad                          | Funktion                          |
|---------|-------------------------------|-----------------------------------|
| POST    | `/api/sessions/start`         | aktive Session anlegen            |
| POST    | `/api/sessions/{id}/pause`    | pausieren                         |
| POST    | `/api/sessions/{id}/resume`   | fortsetzen                        |
| POST    | `/api/sessions/{id}/stop`     | finalisieren (`completed: bool`)  |
| POST    | `/api/sessions/import`        | Kinomap-Datei/ZIP hochladen       |
| GET     | `/api/sessions?limit=N`       | Liste der abgeschlossenen Sessions |
| GET     | `/api/sessions/{id}`          | Detail inkl. Samples              |
| DELETE  | `/api/sessions/{id}`          | löschen                           |
| PATCH   | `/api/sessions/{id}/energy`   | Energiedaten speichern (`user_id`, `bmr_kcal`, `exercise_kcal`, `total_kcal`) |

### Widerstand & Statistik

| Methode | Pfad                       | Funktion                          |
|---------|----------------------------|-----------------------------------|
| GET     | `/api/resistance`          | aktueller Level + Min/Max         |
| POST    | `/api/resistance`          | Level setzen (Body: `{level_pct}`) |
| GET     | `/api/stats?days=N`        | Heatmap, Totals, Bests            |
| GET     | `/api/stats/trends`        | Zeitreihen + P10/⌀/P90-Bänder + Power-Profil |
| POST    | `/api/shutdown`            | Server sauber beenden (SIGTERM)   |
| WS      | `/ws`                      | Live-Datenstrom (siehe 4.3)       |

### Export

| Methode | Pfad                          | Funktion                                              |
|---------|-------------------------------|-------------------------------------------------------|
| GET     | `/api/export/csv?ids=1,2,…`   | Sessions als CSV (Übersichtstabelle, BOM für Excel)   |
| GET     | `/api/export/json?ids=1,2,…`  | Sessions als JSON (inkl. Samples)                     |
| GET     | `/api/export/tcx?ids=1,2,…`   | Sessions als TCX; mehrere → ZIP                       |
| GET     | `/api/export/fit?ids=1,2,…`   | Sessions als FIT; mehrere → ZIP                       |

`ids` ist eine kommagetrennte Liste von Session-IDs. Ohne Parameter werden alle Sessions exportiert. Einzel-Export liefert die Datei direkt; Multi-Export liefert ein ZIP-Archiv.

### BLE-Verwaltung

| Methode | Pfad                    | Funktion                                          |
|---------|-------------------------|---------------------------------------------------|
| GET     | `/api/ble/config`       | gespeicherte BLE-Adresse + Verbindungsparameter   |
| PUT     | `/api/ble/config`       | BLE-Adresse + Parameter speichern                 |
| POST    | `/api/ble/connect`      | Verbindungsaufbau zum Rower anstoßen              |
| POST    | `/api/ble/disconnect`   | Verbindung trennen                                |
| POST    | `/api/ble/scan`         | BLE-Scan starten, Geräteliste zurückgeben         |

## 6 · Wichtige Designentscheidungen

### 6.1 · `bleak` statt `pyftms`
`pyftms` erfordert Python 3.12+. Um auch ältere Pythons (3.9-3.11) zu
unterstützen und keinen Auto-Update-Schmerz zu haben, wird direkt
gegen `bleak` programmiert und die eine relevante Characteristic
selbst geparst. Trade-off: ~80 Zeilen mehr Code, dafür viel breitere
Kompatibilität. **Nicht zurück auf `pyftms` migrieren.**

### 6.2 · Canvas statt Chart.js
Die Plan-Balken müssen pro Segment eine eigene Breite (Dauer) und
Farbe (Intensitäts­zone) haben, plus dünne Roterepräsentation jeder
Ruder­bewegung. Mit Chart.js wären floating bars + mixed types + zweite
Achse plus benutzerdefinierte Segmentfarben deutlich komplexer als die
~70 Zeilen Canvas-Code in `drawChart()`. **Nicht ohne Grund umstellen.**

### 6.3 · DuckDB statt SQLite
Embedded, single-file, gleiche Bedienung wie SQLite – aber Aggregate
(siehe `db_stats()`, `db_finalise_session()`) gehen mit DuckDB
deutlich kompakter und schneller, weil Spaltenformat und Window-
Funktionen native sind. Kein Server-Prozess, kein Setup.
`workouts.json` bleibt als Legacy-Quelle für die einmalige Migration.

### 6.4 · Keine Frameworks im Frontend
Vanilla JS, ein File, keine Toolchain. Wenn das hier mal mehr als
vier Views wird, ist Migration zu Preact/Svelte sinnvoll – aber erst
dann.

### 6.5 · `resistance_pct` als Plan-Intensität
Der Workout-Editor speichert pro Schritt einen `resistance_pct`-Wert
(0–100 %). Beim Segmentwechsel ruft das Dashboard `set_resistance(pct)`
auf, das intern auf den gerätespezifischen Widerstands­level umrechnet.
Die Live-Anzeige zeigt weiterhin Watt (direkt vom FTMS-Notify), aber der
Plan steuert nur den Widerstand — keine Watt-Ziel-Kurve.

### 6.6 · defusedxml + ZIP-Bomb-Guard für Kinomap-Import
Uploads stammen *technisch* von Dritten (Datei aus Kinomap), die
Datei wird gegen den lokalen Prozess geparst. `defusedxml` (statt
`xml.etree`) schließt XXE / Billion-Laughs / Quadratic-Blowup, und
`info.file_size` wird vor dem Entpacken geprüft (ZIP-Bombe). Limits
in `kinomap_import.py`: 32 MiB pro Eintrag, 64 MiB gesamt, 200 000
Samples. Server-Endpoint cappt zusätzlich auf 20 MiB Upload.

### 6.7 · CSS/JS als separate Static-Dateien
`index.html` enthält nur noch das HTML-Gerüst; sämtlicher JS-Code liegt in
`static/app.js`, alle Stile in `static/style.css`. Der Cache-Buster ist als
Query-String am `<script>`-Tag (`?v=YYYYMMDD`-Suffix) eingebaut — bei
JS-Änderungen dort inkrementieren. **Kein Build-Step, keine Toolchain.**

### 6.8 · Benutzerprofile in localStorage
Die App unterstützt mehrere Nutzerprofile (Name, Gewicht, Größe, Geburtsdatum,
Geschlecht, Wirkungsgrad). Diese werden im Browser-`localStorage` (`wr_users`,
`wr_active_user`) gehalten — **nicht** auf dem Server. Beim Session-Stop wird
`user_id` + Kaloriendaten per `PATCH /api/sessions/{id}/energy` in die DB
geschrieben, damit der Verlauf dem richtigen Nutzer zugeordnet bleibt.

### 6.10 · TCX/FIT-Export
Sessions werden serverseitig aus den DB-Daten (`sessions` + `samples`) gebaut,
ohne eine externe Datei zu cachen.
- **TCX**: handgefertigtes XML (kein externer Generator). Rowing Sport-Type,
  eine Lap pro Session, Trackpoints aus den `samples`.
- **FIT**: `fit-tool>=0.9` (lazy import → kein Startup-Overhead wenn nicht genutzt).
  Schreibt FileId, Session, Lap, Records und ActivityMessage.
Mehrere Sessions werden on-the-fly in ein ZIP gepackt (kein Tempfile auf Disk).

**Nicht auf einen Streaming-Response umstellen**, solange die Dateigrößen
im einstelligen MB-Bereich bleiben — der einfachere `Response(content=bytes)` reicht.

### 6.9 · Loopback-Default
`uvicorn` bindet auf `127.0.0.1`, weil es keine Auth gibt. Wer im LAN
hosten will, setzt `WOODROWER_HOST=0.0.0.0` bewusst — der Server logt
beim Start eine entsprechende Warnung.

## 7 · Conventions

- Code-Kommentare und Docstrings auf Englisch.
- UI-Strings und README auf Deutsch (Nutzer ist DE-sprachig).
- Python: Type Hints, `from __future__ import annotations`, kein
  externer Linter konfiguriert – beim Editieren am Stil orientieren.
  `asyncio.get_running_loop()` statt `get_event_loop()` (Py 3.10+).
- Frontend: 2-Space-Einrückung, vanilla `addEventListener`/`onclick`,
  `$()` / `$$()` als jQuery-light Helpers.
- Keine Build-Tools hinzufügen.

## 8 · Setup & Run

```bash
pip install -r requirements.txt

# echter Rower (Bluetooth) – bequem mit venv-Aktivierung:
./start.sh

# oder direkt:
python server.py

# UI-Test ohne Hardware
WOODROWER_SIM=1 python server.py   # Win: set WOODROWER_SIM=1 && ...

# vom Tablet aus zugreifen wollen (Risiko: kein Auth!):
WOODROWER_HOST=0.0.0.0 python server.py

# anderen Port:
WOODROWER_PORT=9000 python server.py

# → http://localhost:8000  (oder dein konfigurierter Port)
```

Während die App läuft, darf die Decathlon-Coach-App nicht parallel mit
dem Rower verbunden sein – BLE erlaubt nur einen Client.

### Debug-Snippets

Geräte sichtbar?
```bash
python -c "import asyncio; from bleak import BleakScanner; \
print(asyncio.run(BleakScanner.discover(timeout=10)))"
```

BLE-Verbindungsparameter live beobachten (während ble_test.py läuft):
```bash
sudo btmon 2>&1 | grep -i "connection\|interval\|latency\|supervision"
```

Parser-Round-trip (kein Bluetooth nötig):
```bash
python - <<'PY'
import struct, re
src = open('server.py').read()
exec(re.search(r'def parse_rower_data.*?(?=\n(?:async )?def )', src, re.DOTALL).group(0))
flags = 0x0004 | 0x0020
pkt = struct.pack('<H', flags) + struct.pack('<B', 60) + struct.pack('<H', 1234) \
      + bytes([0xE8, 0x03, 0x00]) + struct.pack('<h', 42)
print(parse_rower_data(pkt))
PY
```

Kinomap-Import lokal testen:
```bash
curl -F "file=@deine_kinomap_datei.zip" http://localhost:8000/api/sessions/import
```

## 9 · Offene Punkte / TODO

### Bekannte Limitierungen
- **Kein separater HR-Sensor.** HR kommt nur, wenn das Rudergerät
  selbst HR über FTMS reicht. Brustgurt direkt zu abonnieren wäre eine
  Erweiterung (Heart Rate Service `0x180D`, Char `0x2A37`).
- **BLE-Verbindungszeit:** Der erste Verbindungsaufbau dauert 12–20 s,
  weil BlueZ nach dem HCI-Connect die Connection Parameters mit dem
  Gerät aushandelt (zwei L2CAP-Runden, dann PPCP-Lesen). Das ist
  BlueZ-seitig bedingt und lässt sich durch Setzen von
  `MinConnectionInterval=8`, `MaxConnectionInterval=10`,
  `ConnectionLatency=0`, `ConnectionSupervisionTimeout=400` in
  `/etc/bluetooth/main.conf` auf ~2–3 s reduzieren. Die Werte für den
  Woodrower stehen bereits in `config.json` unter `ble_conn_params`
  (zur Dokumentation, derzeit nicht automatisch angewendet, da BlueZ
  5.85 `SetConnectionParameters` via D-Bus nicht exportiert).
- **Reconnect-Verhalten** bei kurzem BLE-Aussetzer: `real_rower_task`
  verbindet nach jedem Disconnect neu (5 s Pause). Ein Scan-Warmup vor
  jedem Connect-Versuch stabilisiert den BlueZ-Cache.
- **Auto-Resistance.** Aktuell setzt nur der Nutzer den Widerstand;
  der Plan-Step könnte theoretisch automatisch passende RES-Stufen
  schreiben — nicht implementiert, würde Mapping Watt→RES brauchen
  (pro Gerät anders).
- **Mehrere parallele Browser-Tabs** auf demselben Dashboard können
  beide Start/Stop drücken; der Server lässt nur eine aktive Session
  zu (409 sonst), aber die UI synchronisiert sich nicht aktiv.

### Nicht implementiert, aber nice
- Audio-Cues 3-2-1 zum Segmentwechsel.
- Mobile-Layout der Dashboard-Top-Leiste (Distanz + Zeit untereinander
  auf schmalen Screens).
- "Letzten Stand fortsetzen"-Button auf der Liste.
- Workouts duplizieren.
- CSV-Export einzelner Sessions (Samples liegen in der DB).

## 10 · Tests

Aktuell **keine** automatisierten Tests. Bei nicht-trivialen Änderungen
am Parser oder am Workout-Modell sollten welche dazu.

Sinnvolle erste Tests:
- `parse_rower_data()` mit Pakten aus echtem Capture (am besten ein
  paar aus Wireshark/nRF Connect sammeln).
- `expandWorkout()` (JS) – Roundtrip Workout-Definition → flat
  segments → Total-Dauer.
- `kinomap_import.import_bytes()` mit dem mitgelieferten Beispiel-ZIP.
- E2E: simulated mode hochfahren, WS-Client connecten, prüfen dass
  Nachrichten kommen.

## 11 · Wenn jemand was kaputt macht

Reihenfolge der Sicherheits­netze:
1. `git diff` ansehen.
2. `WOODROWER_SIM=1 python server.py` – läuft die UI noch?
3. Parser-Test aus Abschnitt 8 – kommt der erwartete Output?
4. Kinomap-Import-Test (Abschnitt 8) – funktioniert mit dem
   Beispiel-`.tcx`?
5. README-Schnellstart durchgehen.

Hot Spots, wo Änderungen oft Folge­fehler haben:
- `expandWorkout()` in `static/app.js` – wird von Editor-Save UND
  Dashboard-Start benutzt. Schema-Änderungen hier propagieren.
- `parse_rower_data()` in `server.py` – die Reihenfolge der Felder ist nicht beliebig.
- `dash.sums` in `static/app.js` – wenn man eine Metrik dazunimmt, immer auch im Reset
  und in `onRowerData` ergänzen.
- `db_finalise_session()` vs. `db_import_session()` – beide berechnen
  Aggregate, die müssen konsistent bleiben (Spaltenliste!).
- `kinomap_import.import_bytes()` – Title-Resolution-Order ist
  GPX → PWX → Filename → Default; nicht umstellen ohne Anlass.
- Cache-Buster in `index.html` (`?v=…` am `<script>`-Tag) – bei
  Änderungen an `static/app.js` oder `static/style.css` inkrementieren.

---

Ende. Wenn was unklar ist: README zuerst, dann diesen Text, dann den
Code.
