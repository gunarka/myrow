# CONTEXT.md — Woodrower Trainer

> Briefing für Claude Code (oder jeden anderen, der hier weiterbaut).
> Stand: September 2026. Zuletzt aktualisiert: 2026-09-17.
> Repo: <https://github.com/gunarka/myrow> (Branch `main`, siehe §12).

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

| Datei                   | Zweck                                              | Größe    |
|-------------------------|----------------------------------------------------|----------|
| `server.py`             | FastAPI-Backend, FTMS-Parser, WS, DuckDB-Layer     | ~2290 Z  |
| `kinomap_import.py`     | TCX/PWX/CSV/ZIP-Parser für Kinomap-Exporte         | ~489 Z   |
| `index.html`            | SPA-Shell (nur HTML), lädt static/                 | ~494 Z   |
| `static/app.js`         | Gesamte SPA-Logik (alle Views, WS, Canvas-Chart)   | ~3030 Z  |
| `static/style.css`      | Alle CSS-Regeln (inkl. Dark Mode)                  | ~594 Z   |
| `start.sh`              | Venv aktivieren + `python server.py` starten       | –        |
| `config.example.json`   | Vorlage für `config.json` (leeres `ble_address`)   | –        |
| `config.json`           | BLE-Adresse + Geräteparameter — **nicht im Repo**  | –        |
| `woodrower.duckdb`      | DB (Workouts, Sessions, Samples) — **nicht im Repo** | wächst |
| `requirements.txt`      | fastapi, uvicorn, bleak, duckdb, defusedxml, fit-tool, … | 7 Zeilen |
| `.gitignore`            | schließt lokale Daten / venv / Exporte aus (§12)   | –        |
| `.claude/settings.json` | Claude-Code-Berechtigungen, **versioniert**        | –        |
| `LICENSE`               | MIT                                                | –        |
| `README.md`             | Endnutzer-Anleitung                                | –        |
| `CONTEXT.md`            | dieses Dokument                                    | –        |

`ble_test.py` wurde entfernt (war ein interaktives Debug-Tool, nicht mehr im Repo).
`.claude/settings.local.json` und `.claude/**/*.local.json` sind bewusst
ignoriert (persönliche Einstellungen), die projektweite `settings.json` nicht.

## 4 · Datenmodell

### 4.1 · Workout (Plan)

```jsonc
{
  "Pyramide 5×": {
    "start":        { "duration_s": 180, "resistance_pct": 3 },
    "repeat_count": 5,
    "steps": [
      { "duration_s": 60, "resistance_pct": 5 },
      { "duration_s": 30, "resistance_pct": 8 },
      { "duration_s": 60, "resistance_pct": 5 },
      { "duration_s": 60, "resistance_pct": 3 }
    ],
    "end":          { "duration_s": 180, "resistance_pct": 3 }
  }
}
```

**Interpretation der „Wiederholung":** `repeat_count` × `steps` (ein Block
mit beliebig vielen Schritten, der N-mal wiederholt wird). Das matcht das
Muster im Original-Screenshot (blau-grün-orange-grün-blau ×5).

**Einheit der Intensität:** `resistance_pct` — der Name ist historisch,
der Wert ist **keine Prozentangabe**, sondern direkt der FTMS-Geräte-
Level (1–15 beim Woodrower, siehe §6.5). Editor und Dashboard begrenzen
die Eingabe hart auf 1–15 und geben den Wert unverändert an
`POST /api/resistance` weiter. Alte Workouts mit `watts`-Schlüssel
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
{ "type": "status", "connected": false, "error": "no_address" }  // config.json ohne ble_address
{ "type": "status", "connected": false, "retry_in": 5.0, "retry_at": 1234.5 } // Backoff läuft (siehe _broadcast_retry)

// Frisch verbundene WS-Clients bekommen sofort den aktuellen Stand
// (ConnectionManager.connect(), Feld "connected" = rower.connected —
// NICHT rower.client, das bei simuliertem Rower nie gesetzt wird).

// Aktueller Widerstand (initial + bei jedem Set). Feld heißt "level"
// (Rohwert im Geräte-Level-Bereich, siehe §4.5), NICHT "level_pct".
// "simulated" ist nur gesetzt, wenn kein echter GATT-Write passiert
// (Sim-Modus oder Gerät noch nicht verbunden) — sonst fehlt das Feld.
{ "type": "resistance", "level": 8, "simulated": false }

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

`set_resistance(level)` nimmt einen direkten Geräte-Level entgegen (kein
`%`-Wert — das Frontend rechnet nichts um, siehe §6.5) und schickt bis zu
drei Schreibvorgänge über den Control Point:

1. Beim ersten Set einmalig `[0x00]` = *Request Control*.
2. Einmalig pro Verbindung `[0x07]` = *Start or Resume*. FTMS-Rudergeräte
   nehmen `SET_RESISTANCE` nur im Zustand „Started" an — ohne diesen Write
   quittiert das Gerät spätere Resistance-Writes teils stillschweigend nicht.
3. Bei jedem Aufruf *Set Target Resistance Level* (`0x04`) mit
   `level*10` (Faktor 10 entspricht der FTMS-Spec, RES in 0.1-Schritten).

**Frame-Länge (Geräte-Quirk):** Der Woodrower validiert die
Control-Point-Payload für Opcode `0x04` strikt auf Länge und liest nur
ein Byte nach dem Opcode — der spec-konforme 3-Byte-Frame (Opcode +
sint16, `struct.pack("<Bh", ...)`) wird mit `error=0x03` (*Invalid
Parameter*) abgelehnt. Passt `level*10` in ein Byte (`level <= 25`,
beim Woodrower ohnehin max. 15), wird deshalb der minimale 2-Byte-Frame
(`struct.pack("<BB", ...)`) geschickt; nur für FTMS-Geräte mit größerem
Widerstandsbereich (`level*10 > 255`) fällt der Code auf den vollen
3-Byte-Frame zurück. Siehe „Behobene Bugs" unten.

**Optimistisches Update:** `current_resistance` wird sofort gesetzt und per
WS gebroadcastet, bevor der GATT-Write überhaupt läuft — die UI bleibt so
responsiv, auch wenn der Write mal 1–2 s braucht.

**Indications (falls verfügbar):** Der Server abonniert `0x2AD9` selbst als
Notify/Indicate-Kanal (`on_ctrl_response`). Antwortpakete beginnen mit
`0x80` (*Response Code*), gefolgt von Opcode und Result-Code
(`0x01` = Success). Ist die Subscription erfolgreich
(`rower.cp_indications_active`), wartet `set_resistance()` bis zu 4 s auf
die Bestätigung; bei explizitem Reject (Code ≠ `0x01`) wird der alte
Widerstandswert wiederhergestellt und per WS neu gebroadcastet
(`control_acquired`/`device_started` werden zurückgesetzt, damit Request
Control/Start-Or-Resume beim nächsten Versuch erneut laufen). Ist keine
Indication verfügbar, wird optimistisch weitergemacht (kein Rollback).

### 4.6 · Widerstandsbereich (`0x2AD6`, Supported Resistance Level Range)

Der nutzbare Level-Bereich ist gerätespezifisch und wird nicht mehr fest
angenommen. Beim ersten Connect auf eine Adresse liest der Server
`0x2AD6` (`resistance_min`/`resistance_max`, in 0.1-Schritten → `//10`)
und cacht das Ergebnis in `config.json` unter `ble_resistance_min`,
`ble_resistance_max`, `ble_resistance_addr`. Bei jedem weiteren Connect
mit derselben Adresse wird der Cache verwendet und der GATT-Read
übersprungen; ändert sich die Adresse, wird automatisch neu gelesen.
Ist die Characteristic nicht vorhanden (Fehler beim Read), fällt der
Server auf `RESISTANCE_MIN=1` / `RESISTANCE_MAX=15` zurück (Standard für
den Woodrower). `_clamp_level()` begrenzt jeden gesetzten Wert immer auf
den aktuell bekannten Bereich.

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
| GET     | `/api/resistance`          | aktueller Level + `connected`/`simulated`-Flags |
| POST    | `/api/resistance`          | Level setzen (Body: `{level}`, 1–15) |
| GET     | `/api/stats?days=N`        | Heatmap, Totals, Bests            |
| GET     | `/api/stats/trends`        | Zeitreihen + P25/⌀/P75-Bänder + Power-Profil |
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
| GET     | `/api/ble/config`       | gespeicherte BLE-Adresse + `connected`/`sim`-Flags |
| PUT     | `/api/ble/config`       | BLE-Adresse speichern (Body: `{address}`)         |
| POST    | `/api/ble/connect`      | setzt `_ble_connect_event` → `real_rower_task` beginnt zu verbinden (siehe §6.11) |
| POST    | `/api/ble/disconnect`   | trennt aktive Verbindung UND stoppt Auto-Reconnect (Event wird gecleart) |
| POST    | `/api/ble/scan`         | BLE-Scan starten, Geräteliste zurückgeben         |
| PUT     | `/api/sim`              | Simulationsmodus umschalten (Body: `{enabled}`); 409 falls `active.id != None` (Training läuft) |

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
Achse plus benutzerdefinierte Segmentfarben deutlich komplexer als der
reine Canvas-Code in `drawChart()` (~115 Zeilen). **Nicht ohne Grund umstellen.**

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

### 6.5 · `resistance_pct` — historischer Name, tatsächlich ein Geräte-Level
Der Workout-Editor speichert pro Schritt einen `resistance_pct`-Wert.
Der Name ist irreführend/historisch gewachsen: **es ist kein 0–100-%-Wert**,
sondern direkt der FTMS-Geräte-Level (Woodrower: 1–15). Editor-Slider
(`#ed-start-w`, `#ed-end-w`, Step-Zeilen) und Dashboard-Slider
(`#d-resistance-slider`) sind alle fest auf `min="1" max="15"` begrenzt
(`index.html`), und `apiSetResistance(level)` reicht den Wert 1:1 als
`{level}` an `POST /api/resistance` durch — **ohne** Umrechnung. Beim
Segmentwechsel ruft das Dashboard also direkt `apiSetResistance(seg.resistance_pct)`
auf (siehe `autoStartSession()` bzw. `updateDashboard()` in `app.js`). Alte
Workouts mit `watts`-Schlüssel werden weiterhin als Fallback gelesen
(`resistance_pct ?? watts`, siehe §4.1).
Die Live-Anzeige zeigt weiterhin Watt (direkt vom FTMS-Notify), aber der
Plan steuert nur den Widerstands-Level — keine Watt-Ziel-Kurve.

**Bekannte Inkonsistenz:** Die Slider-Grenzen (1–15) sind im Frontend
hart codiert und werden **nicht** aus `GET /api/resistance` oder dem
serverseitig gecachten `ble_resistance_min/max` (§4.6) übernommen — die
Response dieses Endpunkts enthält gar kein Min/Max-Feld. Bei einem
FTMS-Gerät mit abweichendem Bereich würde die UI also Werte anbieten,
die der Server über `_clamp_level()` still auf den echten Gerätebereich
zurechtstutzt.

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

### 6.12 · Audio-Cues per Web Audio API (kein Sample, synthetisch)
`playBeep()` in `app.js` erzeugt den Piepton per `AudioContext`/
`OscillatorNode` (kein Audio-File). `updateDashboard()` piepst in den
letzten 3 Sekunden vor jedem Segmentwechsel einmal pro Sekunde
(`dash.beepedKeys` verhindert Mehrfach-Beeps pro Sekunde/Segment-Paar).
Läuft nur, während `dash.running`; im pausierten Zustand kein Ton.

### 6.11 · BLE-Reconnect: aktiver Scan + Device-Trust statt blindem Connect
`real_rower_task()` verbindet **nicht** automatisch beim Serverstart,
sondern wartet auf `_ble_connect_event` (gesetzt durch
`POST /api/ble/connect`, das UI triggert das beim Trainingsstart bzw.
im Admin-Tab). Das spart unnötige BLE-Aktivität, solange niemand
trainiert.

Beim eigentlichen Connect-Versuch:
1. `_wait_for_device()` scannt aktiv mit einem Detection-Callback
   (`WOODROWER_BLE_SCAN_TIMEOUT`, Default 15 s) statt einmalig
   `find_device_by_address()` zu fragen — reagiert auf jedes Advertisement
   sofort statt den vollen Timeout auszusitzen, und liefert laut
   Diagnose zuverlässiger ein Ergebnis.
2. Wird das Gerät gesehen, markiert `_trust_device()` es per
   `bluetoothctl trust <adresse>` als „trusted" (kein Pairing/Bonding).
   Grund: BlueZ kann ein ungetrustetes Device-Objekt kurz nach dem Scan
   wieder aus seiner D-Bus-Objektliste werfen, sodass ein frischer
   `bleak`-Connect-Versuch mit „device not found" fehlschlägt, obwohl
   das Gerät gerade noch gesehen wurde.
3. Der eigentliche `BleakClient`-Connect läuft mit
   `WOODROWER_BLE_CONNECT_TIMEOUT` (Default 45 s).
4. Bei Fehlschlag greift ein wachsendes Backoff
   (`BLE_RECONNECT_BACKOFF = [3, 5, 10, 20, 30]` Sekunden) statt einer
   festen Pause.
5. Optional (`WOODROWER_BLE_RESET_ADAPTER=1`, Default aus): nach je
   `BLE_RESET_AFTER_FAILURES` (3) aufeinanderfolgenden Fehlschlägen wird
   der lokale Bluetooth-Adapter per `bluetoothctl power off/on`
   durchgestartet. Betrifft **alle** BT-Geräte am Rechner (Maus,
   Headset, …) — deshalb bewusst opt-in.

`config.json` → `ble_conn_params` (MinConnectionInterval etc.) bleibt
weiterhin nur Dokumentation und wird **nicht** automatisch angewendet
(BlueZ 5.85 exportiert `SetConnectionParameters` nicht über D-Bus) —
siehe §9. Die obige Strategie adressiert ein anderes Problem
(Erreichbarkeit/Reconnect-Zuverlässigkeit), nicht die
Verbindungsparameter-Aushandlungszeit selbst.

### 6.13 · Simulationsmodus zur Laufzeit umschaltbar
`SIM_MODE` ist ein Modul-Global, das früher nur beim Start aus
`WOODROWER_SIM` gelesen wurde. Jetzt lässt es sich per
`PUT /api/sim {enabled}` (Admin-Tab-Schalter) zur Laufzeit umschalten:

- `_start_rower_task()` cancelt den laufenden Task (egal ob `real_rower_task`
  oder `simulated_rower_task`), setzt den `RowerLink`-Zustand zurück und
  startet den passenden Task neu. Wird sowohl beim Lifespan-Start als auch
  von `/api/sim` aufgerufen — **einzige** Stelle, die den Rower-Task startet.
- Der Handle liegt in `_rower_task` (Modul-Global), damit er cancelbar bleibt.
- Umschalten wird mit `409` abgelehnt, solange `active.id is not None`
  (ein Training läuft gerade) — sonst würde die Aufzeichnung mitten im
  Training die Datenquelle unter sich wegziehen.
- Frontend: `apiSimSet()` in `app.js`, Checkbox `#sim-mode-toggle` im
  Admin-Tab (`renderBleConfig()`).

**Bug, der dabei auffiel und mitgefixt wurde:** `ConnectionManager.connect()`
schickte frisch verbundenen WS-Clients `connected: rower.client is not None`.
`rower.client` bleibt im Sim-Modus aber immer `None` (nur `real_rower_task`
setzt es) — dadurch dachte ein Browser-Tab, der die WS-Verbindung *nach*
Start des Sim-Tasks aufbaut, er sei nicht verbunden, und zeigte beim
Trainingsstart unnötig das Verbindungs-Overlay. Jetzt wird `rower.connected`
gesendet (der Flag, den auch `simulated_rower_task`/`real_rower_task` korrekt
pflegen).

`simulated_rower_task()` baut außerdem (default an, `WOODROWER_SIM_PAUSES=0`
zum Abschalten) zufällig ein paar Sekunden ohne Ruderschlag ein
(`power`/`spm` = 0, Distanz stoppt), damit sich §6.14 (Auto-Pause) auch ohne
echtes Gerät durchspielen lässt: pro 2s-Tick 8 % Chance auf eine 8–20 s lange
Pause (`pause_ticks_left`), solange gerade keine läuft. Eine reine
Zufallschance pro Tick kann aber unglücklich lange ausbleiben (bei den
ursprünglichen 5 %/Tick blieb sie in ~20 % aller 60-Sekunden-Testfenster
komplett aus) — deshalb gibt es zusätzlich eine harte Obergrenze
(`SIM_PAUSE_FORCE_AFTER_S = 45`): sind seit der letzten Pause 45 s aktiv
simuliert gerudert worden, wird garantiert eine erzwungen
(`log.info("SIM: … (forced, none for a while)")`). Damit liegt der
schlimmste Abstand zwischen zwei Pausen bei ~45 s Rudern + Pausendauer
(≤ 65 s), im Schnitt kommt die erste Pause meist schon nach 10–30 s.
Während der Pause laufen `_maybe_record_sample()`-Aufrufe zwar weiter,
schreiben aber nichts, weil `active.running` durch den
Frontend-Auto-Pause-Aufruf (`POST /api/sessions/{id}/pause`) längst `False`
ist.

**Hinweis für Tests:** `server.py` läuft ohne Auto-Reload (kein
`uvicorn --reload`); nach einer Codeänderung muss der Serverprozess neu
gestartet werden, sonst greift weiterhin die alte `simulated_rower_task()`
im Speicher — ein sicheres Zeichen, dass die neue Version läuft, ist die
Log-Zeile `SIM: random rowing pauses enabled …` direkt nach dem Start.

### 6.14 · Auto-Pause-Zustandsmaschine (Frontend)
`dash.autoPaused` + `dash.lastStrokeAt` in `app.js` steuern eine einzige
Pause-Zustandsmaschine für zwei Auslöser — kein Ruderschlag mehr, oder BLE-
Verbindungsverlust —, die beide dieselbe Pause/Resume-Logik teilen:

- **Idle-Erkennung**: `updateDashboard()` prüft bei jedem Tick, ob
  `dash.running` ist und seit `dash.lastStrokeAt` mehr als
  `AUTO_PAUSE_IDLE_MS` vergangen sind → `pauseTrainingAuto()` +
  `showAutoPauseOverlay()`. `dash.lastStrokeAt` wird in `onRowerData()` bei
  jedem Datenpunkt mit `spm > 0 || power > 0` aktualisiert, sowie beim
  (manuellen oder automatischen) Session- bzw. Resume-Start — sonst würde
  direkt nach dem Start/Resume sofort wieder pausiert werden.
- **Einstellbare Schwelle**: `AUTO_PAUSE_IDLE_MS` ist kein `const` mehr,
  sondern ein modul-globales `let`, initialisiert aus
  `loadAutoPauseIdleS() * 1000` (localStorage-Key `wr_autopause_idle_s`,
  Default **4 s**). Admin-Tab-Feld `#autopause-idle-input` (2–30 s,
  0,5er-Schritte) schreibt bei `change` direkt in diese Variable — kein
  Seiten-Reload nötig, der nächste `updateDashboard()`-Tick nutzt sofort
  den neuen Wert. Default-Herleitung: bei den in der Praxis beobachteten
  15,1–23,1 spm liegen rechnerisch (`60 / spm`) 2,6–4,0 s zwischen zwei
  Schlägen; 4 s deckt den langsamsten Fall gerade ab, ohne unnötig lange
  auf eine echte Pause zu warten.
- **BLE-Drop-Erkennung**: im WS-`status`-Handler pausiert
  `pauseTrainingAuto()` sofort, wenn `!msg.connected && dash.sessionId != null`
  — zeigt dabei das **bekannte** `#ble-overlay` (connecting/retrying/no_address),
  nicht das Auto-Pause-Overlay. Kommt die Verbindung zurück
  (`msg.connected === true`) aber `dash.autoPaused` ist noch gesetzt, wird auf
  das normale `#autopause-overlay` gewechselt — der Ruderer ist ja noch nicht
  zwangsläufig am Rudern, nur die Verbindung ist wieder da.
- **Resume**: passiert ausschließlich in `onRowerData()`, wenn ein echter
  Stroke erkannt wird während `dash.autoPaused` gesetzt ist
  (`resumeFromAutoPause()`) — unabhängig davon, ob der Auslöser Idle oder
  BLE-Drop war. Das hält die Logik auf einen einzigen Trigger-Pfad reduziert.
- **Auch nach manueller Pause (⏸-Knopf) wird bei Stroke automatisch
  fortgesetzt**: `onRowerData()` prüft dafür zusätzlich (per `else if`,
  also exklusiv zum autoPaused-Zweig) `dash.startedAt && !dash.running &&
  dash.sessionId != null` und ruft `resumeTraining()` — dieselbe
  Resume-Bookkeeping-Funktion, die auch `resumeFromAutoPause()` und der
  ⏸/▶-Button-Handler nutzen, aber **ohne** Overlay-Handling, da hier
  nichts angezeigt wurde. `dash.sessionId != null` schließt abgeschlossene
  (`completedNotified`) und abgebrochene (`abortTraining()`) Trainings
  sicher aus, bei denen `dash.running` ebenfalls `false` ist, aber kein
  automatischer Restart stattfinden soll.
- **Abbrechen**: `abortTraining()` ist die gemeinsame Funktion für den
  normalen ✕-Knopf im Dashboard, den "Training abbrechen"-Knopf im
  Auto-Pause-Overlay, und den (wiederverwendeten) "Abbrechen"-Knopf im
  BLE-Overlay, sobald mitten im Training eine Session existiert
  (`dash.sessionId != null`).
- `pauseTrainingAuto()` ist idempotent (prüft `dash.running`, bevor es
  erneut pausiert) — wichtig, weil bei anhaltendem BLE-Drop mehrfach
  `retry_in`-Status-Broadcasts eintreffen können.

### 6.15 · Trainingsende-Overlay
Ausgelöst in `updateDashboard()`, wenn `!dash.completedNotified && t >=
dash.totalSec` (also nur bei **definierten** Trainings, nicht im
`freeMode`). Sammelt die Session-Kennzahlen aus `dash.sums`/`dash.last` plus
`recordSessionEnergy()` (die jetzt das berechnete `{bmr_kcal, exercise_kcal,
total_kcal}`-Objekt zurückgibt statt `void`) und zeigt sie in
`#trainingend-overlay` (`showTrainingEndOverlay(stats)`). Ein
`performance.now()`-basierter Countdown (gleiches Pattern wie
`bleRetryDeadline`) wechselt nach 10 s automatisch in den Trainingsverlauf
(`showView("history")`); der Knopf *Beenden* macht dasselbe sofort
(`closeTrainingEndOverlay()`). `resetDashState()` räumt Timer + Overlay auf,
falls eine neue Session gestartet wird, bevor der Countdown abgelaufen ist.

### 6.16 · Overlays: kein `backdrop-filter` (Ventilator-/CPU-Bug)
Gemeldetes Symptom: Während einer Auto-Pause (oder dem BLE-Reconnect-
Overlay) drehte der Lüfter des Rechners hoch, solange das Overlay sichtbar
war. Bestätigte Ursache: `backdrop-filter: blur(3px)` auf den
Vollbild-Overlays. Dieser Effekt zwingt den Compositor, alles darunter
Liegende neu weichzuzeichnen, sobald sich *irgendetwas* im Overlay-Layer
ändert — inklusive der rein CSS-getriebenen `.ble-spinner`-
Rotationsanimation (`animation: … 1s linear infinite`), die unabhängig von
jeglichem JS-Timing mit 60 fps läuft, solange das Overlay sichtbar ist. Bei
einer Auto-Pause, die minutenlang andauern kann, lief das potenziell
dauerhaft. Da `--ble-overlay-bg` ohnehin schon 96 % opak ist (siehe
Theme-Variablen), war der Blur optisch kaum wahrnehmbar — reiner
Kostenfaktor ohne echten Nutzen.

Fix:
- `backdrop-filter: blur(3px)` aus allen drei Overlay-Regeln entfernt
  (`#ble-overlay`, `#autopause-overlay`, `#trainingend-overlay`). Kein
  Overlay in dieser App nutzt `backdrop-filter` mehr.
- `.ble-spinner` (rotierender Ring) im Auto-Pause-Overlay durch ein
  **statisches** `.pause-icon` (⏸, keine Animation) ersetzt — ein
  Lade-Spinner ergibt für "wartet aufs Weiterrudern" ohnehin semantisch
  keinen Sinn und lief zuvor unbegrenzt lange mit. Der `.ble-spinner`
  bleibt für den (typischerweise kurzen) Verbindungsaufbau im
  `#ble-overlay` erhalten — ohne Blur ist die Animation für sich genommen
  unproblematisch.

**Sackgasse (verworfen):** Vor der eigentlichen Diagnose wurde zunächst
vermutet, der 10-Hz-`drawChart()`-Aufruf in `updateDashboard()` sei die
Ursache (Canvas-Resize+Repaint 10×/s, obwohl `t = elapsedSec()` während
einer Pause eingefroren ist). Es wurde testweise eine
laufzustandsabhängige Tick-Drossel (`dash.running` → 100 ms sonst 1000 ms)
plus ein `dash._needsChartDraw`-Flag eingebaut. Das hat den gemeldeten
Ressourcenverbrauch **nicht** gesenkt und wurde wieder vollständig
zurückgenommen — `updateDashboard()`/`drawChart()` laufen also unverändert
mit festen 10 Hz, wie vor diesem Abschnitt. Lehre: Bei Performance-Reports
mit CSS-Overlays zuerst `backdrop-filter`/Filter-Effekte prüfen, bevor an
der JS-Redraw-Frequenz gedreht wird — Canvas-Redraws ohne Filter-Overlay
sind bei dieser Chartgröße kein messbares Problem.

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

Weitere Env-Vars für die BLE-Reconnect-Logik (§6.11), normalerweise nicht
nötig anzufassen:

```bash
WOODROWER_BLE_SCAN_TIMEOUT=15       # Sekunden aktiver Scan pro Connect-Versuch
WOODROWER_BLE_CONNECT_TIMEOUT=45    # Sekunden Timeout für den BleakClient-Connect
WOODROWER_BLE_RESET_ADAPTER=1       # Adapter nach mehreren Fehlschlägen power-cyclen (Default: aus)
```

Während die App läuft, darf die Decathlon-Coach-App nicht parallel mit
dem Rower verbunden sein – BLE erlaubt nur einen Client.

### Debug-Snippets

Geräte sichtbar?
```bash
python -c "import asyncio; from bleak import BleakScanner; \
print(asyncio.run(BleakScanner.discover(timeout=10)))"
```

BLE-Verbindungsparameter live beobachten (während der Server per
`POST /api/ble/connect` verbindet, z. B. beim Trainingsstart):
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

### Behobene Bugs (2026-09-11)
- **Trainingsende-Overlay erschien links unten statt zentriert und
  verschob das Dashboard-Layout.** Ursache: `static/style.css` bekam
  neue Regeln für `#autopause-overlay`/`#trainingend-overlay`
  (`position: fixed`, zentriert), aber der Cache-Buster am
  `<link>`-Tag in `index.html` (`?v=…`) wurde beim Ausliefern **nicht**
  erhöht — Browser mit bereits gecachter `style.css` bekamen die neuen
  Regeln nie zu Gesicht. Ohne die Regel fällt der Browser auf
  Default-Block-Rendering zurück: das (durch JS sichtbar geschaltete)
  Overlay landet unten im normalen Dokumentfluss statt als Vollbild-
  Overlay, was wie ein Layout-Sprung wirkt. Lehre: **beide**
  Cache-Buster (`app.js` UND `style.css`) bei jeder Änderung an der
  jeweiligen Datei erhöhen, nicht nur den des Scripts (siehe Hot-Spot
  in §11).
- **Lüfter/CPU-Last stieg während einer Auto-Pause spürbar an.** Siehe
  §6.16 — bestätigte Ursache war `backdrop-filter: blur()` auf den
  Overlays zusammen mit der dauerhaft laufenden `.ble-spinner`-
  CSS-Animation (60 fps, unabhängig vom JS-Tick), nicht der
  `drawChart()`-Aufruf (eine testweise eingebaute Tick-Drosselung
  brachte keine Besserung und wurde wieder zurückgenommen). Fix: Blur
  aus allen drei Overlays entfernt, Spinner im Auto-Pause-Overlay durch
  statisches `.pause-icon` ersetzt (siehe Nachtrag in §6.16).

### Behobene Bugs (2026-08-20)
- **SET_RESISTANCE vom Gerät abgelehnt (`error=0x03`, Invalid
  Parameter) nach dem 3-Byte-Fix vom 2026-08-19.** Log zeigte
  `FTMS CP ack: opcode=0x04 error=0x03` / `SET_RESISTANCE rejected by
  device (code=0x03)` → 502 auf `POST /api/resistance`, obwohl Connect,
  Request Control und Start-or-Resume erfolgreich liefen. Ursache: Die
  Woodrower-Firmware validiert die Control-Point-Payload für Opcode
  `0x04` strikt auf Länge und liest nur ein Byte nach dem Opcode; das
  zusätzliche High-Byte des spec-konformen 3-Byte-Frames
  (`struct.pack("<Bh", ...)`, siehe Fix vom 2026-08-19) führte zur
  Ablehnung. Der eigentliche Wert (`level*10` im Low-Byte) war in
  beiden Versionen identisch — nur die Frame-Länge unterschied sich.
  Fix: `set_resistance()` schickt jetzt den minimalen 2-Byte-Frame
  (`struct.pack("<BB", ...)`), solange `level*10 <= 255` (beim
  Woodrower mit Max. 15 immer der Fall), und weicht nur für Geräte mit
  größerem Widerstandsbereich auf den vollen 3-Byte-Frame aus — damit
  bleibt auch der ursprüngliche Crash-Fix (ValueError bei `level*10 >
  255`) erhalten. Siehe §4.5.

### Behobene Bugs (2026-08-19, Code-Review)
- **PWX-Import fand nie Samples.** `parse_pwx()` durchsuchte
  `root.findall("pwx:sample", NS)` — `<sample>`-Elemente stehen aber unter
  `<workout>`, nicht direkt unter der `<pwx>`-Wurzel. Ohne `.//` matcht
  `findall()` nur direkte Kinder, also 0 Treffer → `ValueError("PWX: no
  <sample> elements found")` bei jeder real strukturierten PWX-Datei.
  Fix: `workout.findall("pwx:sample", NS)`. Fiel nicht auf, weil Kinomap-
  ZIPs meist TCX enthalten (Priorität TCX > PWX > CSV) und PWX nur als
  Fallback greift.
- **FTMS-Resistance-Write war fehlerhaft gepackt.** `set_resistance()`
  baute die Set-Target-Resistance-Level-Payload als
  `bytes([FTMS_OP_SET_RESISTANCE, level * 10])` — nur 2 Bytes statt der
  laut Spec (und §4.5 oben) geforderten 3 Bytes (Opcode + sint16
  little-endian). Für Level ≤ 25 fehlte das High-Byte (nicht-konform),
  für Level ≥ 26 crashte `bytes()` mit `ValueError` (abgefangen, aber
  `set_resistance()` gab `False` zurück → 502). Fix:
  `struct.pack("<Bh", FTMS_OP_SET_RESISTANCE, level * 10)`. Vermeidet
  den Crash bei größerem Widerstandsbereich, wurde vom Woodrower selbst
  aber mit `error=0x03` abgelehnt (Frame-Längen-Quirk) — siehe Fix vom
  2026-08-20 direkt oberhalb, der beide Fälle abdeckt.

### Optimierungen (2026-08-19)
- `updateDashboard()` lief mit voller `requestAnimationFrame`-Rate
  (~60 Hz), obwohl Rower-Daten nur ~1×/s reinkommen (§4.3). Jetzt auf
  ~10 Hz gedrosselt (`DASH_TICK_MS`), spart CPU/Akku speziell auf
  Tablets.
- WS-Ping-`setInterval` in `connectWS()` wurde bei jedem Reconnect neu
  angelegt und nie gecleart. Jetzt in `pingTimer` gehalten und in
  `ws.onclose` gecleart.
- Multi-Session-Export (`_sessions_for_export()`) rief `db_get_session()`
  pro ID einzeln auf (2×N Queries). Neue `db_get_sessions_bulk()` holt
  Sessions + Samples in 2 Queries insgesamt.
- `style.css` hatte keinen Cache-Buster (`app.js` schon) — ergänzt,
  gleiches Schema wie bei `app.js` (§6.7).
- `aiofiles` aus `requirements.txt` entfernt (nirgends importiert).

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
  (weiterhin nur zur Dokumentation, derzeit nicht automatisch
  angewendet, da BlueZ 5.85 `SetConnectionParameters` via D-Bus nicht
  exportiert). Das ist unverändert offen.
- **Reconnect-Zuverlässigkeit** — größtenteils adressiert (Stand
  2026-08-19, siehe §6.11): `real_rower_task` nutzt jetzt aktives
  Scannen mit Detection-Callback statt eines einmaligen
  `find_device_by_address()`, und markiert gefundene Geräte per
  `bluetoothctl trust` als vertrauenswürdig — Diagnose hatte gezeigt,
  dass BlueZ ein ungetrustetes Device-Objekt zwischen Scan und Connect
  aus seiner D-Bus-Liste werfen kann, was zu „device not found"-Fehlern
  trotz sichtbarem Gerät führte. Reconnects laufen mit wachsendem
  Backoff (3/5/10/20/30 s) statt fester 5-s-Pause. Ein optionaler
  Adapter-Reset (`WOODROWER_BLE_RESET_ADAPTER=1`) steht als letztes
  Mittel nach mehreren Fehlschlägen in Folge zur Verfügung. Verbleibt
  offen: die Verbindungsaufbauzeit selbst (siehe Punkt oben) ist davon
  unberührt.
- **Auto-Resistance.** Aktuell setzt nur der Nutzer den Widerstand;
  der Plan-Step könnte theoretisch automatisch passende RES-Stufen
  schreiben — nicht implementiert, würde Mapping Watt→RES brauchen
  (pro Gerät anders).
- **Mehrere parallele Browser-Tabs** auf demselben Dashboard können
  beide Start/Stop drücken; der Server lässt nur eine aktive Session
  zu (409 sonst), aber die UI synchronisiert sich nicht aktiv.

### Nicht implementiert, aber nice
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
- Cache-Buster in `index.html` (`?v=…` an **beiden** Tags, `<link>`
  UND `<script>`) – bei Änderungen an `static/app.js` **oder**
  `static/style.css` jeweils den passenden Query-Wert erhöhen. Nur den
  Script-Tag zu bumpen reicht nicht, wenn sich CSS geändert hat (siehe
  Bug vom 2026-09-11 in §9) — Browser mit gecachter `style.css` sehen
  neue Regeln sonst nie.
- `real_rower_task()` in `server.py` – Scan → Trust → Connect → GATT-Setup
  → Resistance-Range-Cache ist eine lange Kette mit mehreren
  Fehlerpfaden (siehe §6.11); Änderungen hier gegen echte Hardware
  testen, nicht nur `WOODROWER_SIM=1`.
- `set_resistance()` in `server.py` – Reihenfolge Request-Control →
  Start-Or-Resume → Set-Resistance ist für FTMS-Rudergeräte bindend
  (siehe §4.5); `control_acquired`/`device_started` nicht ohne Grund
  vorzeitig zurücksetzen.
- `_start_rower_task()` in `server.py` – einzige Stelle, die den
  Rower-Task (er)startet (Lifespan **und** `/api/sim`, siehe §6.13);
  neue Aufrufer sollten diese Funktion nutzen statt selbst
  `asyncio.create_task(...)` zu rufen, sonst laufen zwei Tasks parallel.
- `backdrop-filter` und Dauer-Animationen (`.ble-spinner`) auf den
  Vollbild-Overlays (siehe §6.16) – beides ist teuer, solange ein Overlay
  sichtbar ist, und die Auto-Pause kann beliebig lange offen bleiben. Kein
  `backdrop-filter` auf `#ble-overlay`/`#autopause-overlay`/
  `#trainingend-overlay` wieder einführen, ohne den Effekt auf den
  Ressourcenverbrauch bei langer Anzeigedauer zu bedenken; neue
  Dauer-Animationen dort nur mit gutem Grund und möglichst nicht auf
  Overlays, die minutenlang offen bleiben können.
- `dash.autoPaused` / `pauseTrainingAuto()` / `resumeFromAutoPause()` in
  `static/app.js` (siehe §6.14) – neue Auslöser fürs automatische
  Pausieren sollten über `pauseTrainingAuto()` gehen, neue
  Resume-Bedingungen über `resumeFromAutoPause()`, sonst laufen
  Training/Aufzeichnung und Overlay-Anzeige auseinander.

## 12 · Git / GitHub

Das Projekt liegt öffentlich auf GitHub:
<https://github.com/gunarka/myrow> — einziger Branch: `main`, kein
Fork, keine Tags/Releases, **keine GitHub Actions / kein CI**. Der
Stand auf `main` ist der gültige Stand; Tests laufen manuell (§10).

**Was nicht ins Repo gehört** (`.gitignore`): `config.json` (BLE-Adresse
des Geräts), `*.duckdb` / `*.duckdb.wal` (persönliche Sessiondaten),
`workouts.json(.bak)`, `.venv/`, Exportartefakte (`*.fit`, `*.tcx`,
`*.pwx`, `exports/`), Logs, Editor- und OS-Dateien. Vor jedem Commit
kurz `git status` prüfen — ein versehentlich eingecheckter
`woodrower.duckdb` enthält vollständige Trainingsdaten inklusive Puls.

**Arbeitsweise mit Patches** (so entstehen Änderungen aus dem Chat):

```bash
cd ~/Programme/projects/myrow
git apply --check ~/Downloads/aenderung.patch   # trocken testen
git apply         ~/Downloads/aenderung.patch   # anwenden
git diff --stat                                 # Ergebnis ansehen
git add -A && git commit -m "…" && git push origin main
```

`git apply -3 …` nutzt einen Drei-Wege-Merge, wenn der Patch nicht exakt
passt; `git apply -R …` nimmt einen noch nicht committeten Patch zurück.

**Hinweis zur Gliederung:** Die Unterabschnitte in §6 sind historisch
gewachsen und stehen nicht in numerischer Reihenfolge (6.10 vor 6.9,
6.12 vor 6.11). Querverweise nutzen die Nummern, deshalb wurde bewusst
nicht umsortiert — neue Abschnitte hinten anhängen.

---

Ende. Wenn was unklar ist: README zuerst, dann diesen Text, dann den
Code.
