# Woodrower Trainer

Eine kleine Python-Webapp, um Intervalltrainings für den Decathlon
**Woodrower** (oder andere FTMS-Rudergeräte) zu entwerfen, live durch­
zuführen und im Verlauf auszuwerten.

## Funktionen

- **Trainings entwerfen & speichern**
  Start-Intervall · Wiederholungsblock mit beliebig vielen Schritten ×
  Wiederholungs­anzahl · End-Intervall. Pro Schritt Dauer (Sek.) und
  Ziel-Widerstandslevel (1–15).
- **Live-Dashboard**
  Gesamt-Restzeit · Fortschrittsbalken · Diagramm mit Soll-Balken und
  tatsächlich geruderter Leistung · aktuelle Periode (Restzeit + Soll-Stufe)
  · Live-Kennzahlen Watt / spm · akustischer 3-2-1-Countdown vor jedem
  Segmentwechsel · kompaktes Layout.
- **Auto-Pause** – bleibt ein paar Sekunden ein Ruderschlag aus,
  pausieren Training und Aufzeichnung automatisch; ein Overlay
  ("Pause. Starte das Rudern zum Fortsetzen") zeigt das an und bietet
  einen Knopf zum Trainingsabbruch. Sobald wieder gerudert wird, laufen
  Training und Aufzeichnung nahtlos weiter. Fällt währenddessen die
  Bluetooth-Verbindung weg, versucht der Server automatisch neu zu
  verbinden (bekanntes Verbindungs-Overlay) — auch hier läuft es beim
  nächsten Ruderschlag einfach weiter. Die Wartezeit bis zur Auto-Pause
  (Default 4 s) lässt sich im **Admin**-Tab einstellen und wird im
  Browser gespeichert.
- **Trainingsende-Overlay** – ist ein definiertes Training komplett
  durchlaufen, erscheint ein Glückwunsch-Overlay mit den Kennzahlen der
  Session (Dauer, Distanz, ⌀ Leistung/Schlagzahl/Pace/Puls, Kalorien).
  Es wechselt automatisch nach 10 Sekunden (oder per Knopf *Beenden*)
  in den Trainingsverlauf.
- **Freies Training** mit großem Widerstands-Slider statt Plan-Diagramm.
- **Bluetooth-Anbindung über FTMS** – nutzt direkt
  [`bleak`](https://github.com/hbldh/bleak) und parst die FTMS-„Rower
  Data"-Characteristic (UUID `0x2AD1`) selbst. Setzt den Widerstand
  über das FTMS Control Point (`0x2AD9`). Läuft auf Python ≥ 3.9.
  Der erste Verbindungsaufbau dauert ca. 12–20 s (BlueZ handelt
  Verbindungsparameter aus); folgende Verbindungen sind schneller.
  Verbindet sich per aktivem Scan und merkt sich das Gerät als
  vertrauenswürdig (`bluetoothctl trust`), was Aussetzer/„device not
  found"-Fehler beim Reconnect deutlich reduziert; bei anhaltenden
  Problemen wiederholt der Server mit wachsender Pause automatisch.
- **Mehrere Nutzerprofile** – Name, Gewicht, Größe, Geburtsdatum und
  Wirkungsgrad werden lokal im Browser gespeichert; Kalorien werden je
  Session dem gewählten Nutzer zugeordnet.
- **Verlauf & Statistik** – jede Session landet automatisch in einer
  DuckDB neben `server.py`; mit GitHub-Style-Heatmap, persönlichen
  Bestwerten und Durchschnitten.
- **Kinomap-Import** – fertige Trainings aus der Kinomap-App
  (`.zip` / `.tcx` / `.pwx` / `.csv`) lassen sich in den Verlauf laden.
- **Export** – Sessions im Admin-Tab auswählen und als **CSV** (Excel/Sheets),
  **JSON** (Vollexport mit Rohdaten), **TCX** oder **FIT** herunterladen.
  Mehrere Sessions werden als ZIP geliefert; TCX/FIT lassen sich direkt in
  Strava, Garmin Connect oder Runalyze importieren.
- **Admin-Tab** – Bluetooth-Adresse per UI eintragen/scannen,
  Nutzerprofile verwalten, Dark Mode umschalten, Sessions exportieren.
- **Simulationsmodus** falls kein Rudergerät verbunden ist – die UI
  funktioniert trotzdem, mit gefakten Strokes. Lässt sich sowohl per
  Umgebungsvariable beim Start als auch jederzeit über einen Schalter
  im **Admin**-Tab aktivieren/deaktivieren (nicht möglich während ein
  Training läuft). Startet ein Training im Simulationsmodus, erscheint
  kein Verbindungs-Overlay, da bereits eine (simulierte) Verbindung
  besteht. Zum Testen der Auto-Pause baut die Simulation außerdem
  spätestens alle 45–65 Sekunden ein paar Sekunden ohne Ruderschlag ein
  (abschaltbar mit `WOODROWER_SIM_PAUSES=0`).

## Installation

```bash
cd woodrower-trainer
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Erststart / Initial Setup

Beim ersten Start legt der Server alle benötigten Dateien automatisch an:

| Datei               | Erstellt durch          | Inhalt                          |
|---------------------|-------------------------|---------------------------------|
| `woodrower.duckdb`  | Server beim ersten Start | Trainings- und Sessiondaten     |
| `config.json`       | Admin-Tab oder manuell  | BLE-Adresse des Rudergeräts     |

**Rudergerät konfigurieren** (nicht nötig im Simulationsmodus):

Option A – über die UI: Server starten → Tab **Admin** → *Bluetooth-Adresse scannen*
oder direkt eintragen.

Option B – manuell: `config.example.json` kopieren, umbenennen und die Adresse
eintragen:

```bash
cp config.example.json config.json
# config.json bearbeiten: "ble_address" auf die MAC-Adresse des Rowers setzen
```

> `config.json` und `woodrower.duckdb` sind in `.gitignore` eingetragen und
> enthalten gerätespezifische bzw. persönliche Daten — sie werden nicht
> ins Repository eingecheckt.

## Start

**Mit echtem Rower** (Bluetooth eingeschaltet, Gerät in Reichweite):

```bash
./start.sh          # aktiviert .venv automatisch
# oder direkt:
python server.py
```

**Nur UI testen, ohne Hardware:**

```bash
WOODROWER_SIM=1 python server.py
```

Dann im Browser öffnen: <http://localhost:8000>

> Hinweis: Während die App läuft, darf **nicht gleichzeitig** die
> Decathlon-/Domyos-Coach-App o.ä. mit dem Rower verbunden sein – BLE
> erlaubt nur einen Client.

### Konfiguration per Umgebungsvariable

| Variable                        | Default     | Wirkung                                              |
|----------------------------------|-------------|------------------------------------------------------|
| `WOODROWER_SIM`                 | `0`         | `1` = Simulationsmodus beim Start (kein Bluetooth). Lässt sich danach jederzeit im Admin-Tab umschalten. |
| `WOODROWER_SIM_PAUSES`          | `1`         | Nur im Simulationsmodus: `0` = kein zufälliges Pausieren des simulierten Ruderns (Dauerbetrieb). |
| `WOODROWER_HOST`                | `127.0.0.1` | Bind-Adresse. **Default: nur dieser Rechner.**       |
| `WOODROWER_PORT`                | `8000`      | TCP-Port.                                            |
| `WOODROWER_BLE_SCAN_TIMEOUT`    | `15`        | Sekunden aktiver BLE-Scan pro Connect-Versuch.       |
| `WOODROWER_BLE_CONNECT_TIMEOUT` | `45`        | Sekunden Timeout für den eigentlichen GATT-Connect.  |
| `WOODROWER_BLE_RESET_ADAPTER`   | `0`         | `1` = Bluetooth-Adapter nach mehreren Fehlversuchen in Folge power-cyclen (betrifft alle BT-Geräte am Rechner). |

### Sicherheits­hinweis

Die App hat **keine Authentifizierung**. Wer den Port erreicht, kann
Trainings ändern/löschen, Sessions starten und den Geräte-Widerstand
verstellen. Deshalb bindet der Server standardmäßig nur auf
`127.0.0.1`. Nur in einem **vertrauenswürdigen Heimnetz** und nur dann
auf `0.0.0.0` umstellen (z. B. um vom Tablet aus zu bedienen):

```bash
WOODROWER_HOST=0.0.0.0 python server.py
```

## Bedienung

1. **Trainings** → *+ Neues Training* → Schritte definieren → *Speichern*.
2. In der Trainingsliste auf ▶ **Start** klicken.
3. Im Dashboard Nutzer auswählen, dann mit ▶ den Timer starten.
   ✕ geht zurück zur Liste (und speichert das bisher Trainierte). Mit ⏸
   lässt sich jederzeit selbst pausieren; sobald danach wieder gerudert
   wird, geht es automatisch weiter — der ▶-Knopf muss dafür nicht extra
   gedrückt werden.
   - Hört das Rudern für ein paar Sekunden auf, pausieren Training und
     Aufzeichnung automatisch (Overlay *"Pause. Starte das Rudern zum
     Fortsetzen"*); Rudern fortsetzen macht das Overlay weg und beides
     läuft weiter. Über den Knopf *Training abbrechen* im Overlay lässt
     sich das Training stattdessen sofort beenden und speichern.
   - Bricht währenddessen die Bluetooth-Verbindung ab, versucht die App
     automatisch neu zu verbinden und pausiert bis dahin ebenfalls.
   - Ist ein **definiertes** Training komplett durchlaufen, erscheint ein
     Glückwunsch-Overlay mit den Kennzahlen der Session. Es wechselt nach
     10 Sekunden automatisch (oder per Knopf *Beenden*) in den
     Trainingsverlauf.
4. Im Tab **Verlauf** liegen abgeschlossene Sessions, Bestwerte und die
   Aktivitäts-Heatmap. Dort gibt es auch den Knopf
   *📁 Kinomap-Datei importieren* — einfach das ZIP von Kinomap auswählen.
5. Im Tab **Admin** lassen sich Nutzerprofile anlegen, die Bluetooth-
   Adresse des Rudergeräts eintragen (oder per Scan suchen), der
   Simulationsmodus umschalten, die Auto-Pause-Zeit einstellen, der
   Dark Mode aktivieren und Sessions exportieren (CSV / JSON / TCX / FIT).
6. **Beenden** (oben rechts in der Navigationsleiste) fährt den Server
   sauber herunter und schließt den Tab.

Die Trainings und Sessions werden in `woodrower.duckdb` neben
`server.py` gespeichert. Ein altes `workouts.json` wird beim ersten
Start automatisch eingelesen und bleibt als Backup liegen.

Die BLE-Adresse des Rudergeräts und gerätespezifische Parameter
werden in `config.json` gespeichert (wird automatisch angelegt). Nach dem
ersten erfolgreichen Connect ergänzt der Server dort außerdem den vom
Gerät gemeldeten Widerstandsbereich (`ble_resistance_min/max`), damit er
bei künftigen Verbindungen nicht erneut ausgelesen werden muss.

## Datenmodell (Workout)

`resistance_pct` ist trotz des Namens **kein Prozentwert**, sondern
direkt der Widerstandslevel des Rudergeräts (Woodrower: 1–15).

```jsonc
{
  "Mein Training": {
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


## Erweiterungs­ideen

- Brustgurt direkt über den Heart-Rate-Service (`0x180D`, Char `0x2A37`)
  abonnieren.
- Mehrere Profile / Pulszonen.

## Lizenz

MIT – einfach behalten, anpassen, zerlegen.
