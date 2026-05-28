"""
Woodrower Trainer – Server
==========================
FastAPI server that:
  * Connects to a Decathlon Woodrower (or any FTMS rower) via Bluetooth.
  * Streams live rowing data over a WebSocket.
  * Lets the user set the rower's resistance level (FTMS Control Point 0x2AD9).
  * Persists workouts AND completed training sessions in DuckDB.
  * Serves history/aggregated stats for the "Verlauf" dashboard.
  * Imports completed sessions from Kinomap exports (TCX / PWX / CSV / ZIP).

Run:
    pip install -r requirements.txt
    python server.py
    # open http://localhost:8000 in your browser

Environment variables:
  * WOODROWER_SIM=1      → fake rower data, no Bluetooth needed (UI test).
  * WOODROWER_HOST=...   → bind address (default 127.0.0.1, localhost only).
                            Set to "0.0.0.0" to expose on the LAN — there is
                            NO authentication, only do this on a trusted net.
  * WOODROWER_PORT=...   → port (default 8000).

Database file: woodrower.duckdb (next to server.py).
If an old workouts.json exists, its content is migrated into the DB
on first start; the file stays as a backup.

If bleak is missing or no rower is found, the server runs in
SIMULATION mode so the UI can still be tested.

Security notes:
  * Default bind is 127.0.0.1 — only this machine can connect.
  * Uploads are size-capped at MAX_UPLOAD_BYTES (see below).
  * XML parsing of Kinomap files goes through defusedxml (XXE-safe).
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import math
import os
import random
import signal
import struct
import threading
import time
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
from fastapi import (
    FastAPI, File, HTTPException, UploadFile,
    WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import kinomap_import

try:
    from bleak import BleakClient, BleakScanner
    BLEAK_AVAILABLE = True
except ImportError:
    BLEAK_AVAILABLE = False

# Bluetooth FTMS (Fitness Machine Service) — assigned numbers
FTMS_SERVICE_UUID              = "00001826-0000-1000-8000-00805f9b34fb"
ROWER_DATA_UUID                = "00002ad1-0000-1000-8000-00805f9b34fb"
CONTROL_POINT_UUID             = "00002ad9-0000-1000-8000-00805f9b34fb"
SUPPORTED_RESISTANCE_RANGE_UUID = "00002ad6-0000-1000-8000-00805f9b34fb"

# FTMS Control Point opcodes
FTMS_OP_REQUEST_CONTROL  = 0x00
FTMS_OP_START_OR_RESUME  = 0x07
FTMS_OP_SET_RESISTANCE   = 0x04

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
)
log = logging.getLogger("woodrower")

BASE_DIR = Path(__file__).parent
DB_FILE = BASE_DIR / "woodrower.duckdb"
LEGACY_WORKOUTS_FILE = BASE_DIR / "workouts.json"
CONFIG_FILE = BASE_DIR / "config.json"
SIM_MODE = os.environ.get("WOODROWER_SIM", "0") == "1"

# Bind address. Defaults to localhost — there is no auth, so we don't
# want to be reachable from the LAN unless the user explicitly opts in.
HOST = os.environ.get("WOODROWER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WOODROWER_PORT", "8000"))

# Upload cap for /api/sessions/import. A Kinomap ZIP is typically
# 1–3 MB; 20 MB is a generous ceiling that still keeps the server from
# OOM-ing on a hostile upload.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024     # 20 MiB

# Hard limits for workout PUT bodies. Locally we'd never hit these, but
# they keep a buggy or hostile client from filling the DB with garbage.
MAX_WORKOUT_NAME_LEN  = 200
MAX_WORKOUT_STEPS     = 200
MAX_WORKOUT_JSON_LEN  = 64 * 1024       # 64 KiB

# Resistance Level range exposed to the UI. FTMS doesn't standardise the
# range — concrete devices vary. Woodrower has 15 resistance levels (1–15).
RESISTANCE_MIN = 1
RESISTANCE_MAX = 15


# ---------------------------------------------------------------------------
# DuckDB layer
# ---------------------------------------------------------------------------
# DuckDB connections are not safe for concurrent use from multiple threads.
# Everything that touches `_db` therefore goes through `_db_lock`. Reads and
# writes are both short, so a single global lock is fine for our workload
# (single user, a handful of WS clients, ≤1 BLE notify per second).

_db_lock = threading.Lock()
_db: duckdb.DuckDBPyConnection | None = None


def db() -> duckdb.DuckDBPyConnection:
    assert _db is not None, "database not initialised"
    return _db


def init_db() -> None:
    global _db
    _db = duckdb.connect(str(DB_FILE))

    with _db_lock:
        _db.execute("""
            CREATE TABLE IF NOT EXISTS workouts (
                name        VARCHAR PRIMARY KEY,
                definition  VARCHAR NOT NULL,
                created_at  TIMESTAMP DEFAULT current_timestamp,
                updated_at  TIMESTAMP DEFAULT current_timestamp
            );
        """)
        _db.execute("CREATE SEQUENCE IF NOT EXISTS seq_sessions_id START 1;")
        _db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id                BIGINT PRIMARY KEY
                                  DEFAULT nextval('seq_sessions_id'),
                workout_name      VARCHAR,
                workout_snapshot  VARCHAR,
                started_at        TIMESTAMP DEFAULT current_timestamp,
                ended_at          TIMESTAMP,
                duration_s        DOUBLE,
                total_distance    INTEGER,
                avg_power         DOUBLE,
                max_power         INTEGER,
                avg_spm           DOUBLE,
                avg_pace          DOUBLE,
                avg_hr            DOUBLE,
                total_energy      INTEGER,
                completed         BOOLEAN DEFAULT FALSE
            );
        """)
        _db.execute("""
            CREATE TABLE IF NOT EXISTS samples (
                session_id   BIGINT NOT NULL,
                t_sec        DOUBLE NOT NULL,
                sample_time  TIMESTAMP DEFAULT current_timestamp,
                power        INTEGER,
                spm          DOUBLE,
                pace         INTEGER,
                distance     INTEGER,
                hr           INTEGER,
                energy       INTEGER
            );
        """)
        _db.execute("""
            CREATE INDEX IF NOT EXISTS idx_samples_session
            ON samples (session_id);
        """)
        # Migration: add columns introduced after initial schema
        for col, coltype in [
            ("max_spm",       "DOUBLE"),
            ("max_hr",        "INTEGER"),
            ("best_pace",     "INTEGER"),
            ("bmr_kcal",      "INTEGER"),
            ("exercise_kcal", "INTEGER"),
            ("total_kcal",    "INTEGER"),
            ("user_id",       "VARCHAR"),
        ]:
            _db.execute(
                f"ALTER TABLE sessions ADD COLUMN IF NOT EXISTS {col} {coltype}"
            )

    if LEGACY_WORKOUTS_FILE.exists():
        try:
            data = json.loads(LEGACY_WORKOUTS_FILE.read_text(encoding="utf-8"))
            migrated = 0
            with _db_lock:
                for name, defn in data.items():
                    existing = _db.execute(
                        "SELECT 1 FROM workouts WHERE name = ?", [name]
                    ).fetchone()
                    if not existing:
                        _db.execute(
                            "INSERT INTO workouts (name, definition) "
                            "VALUES (?, ?)",
                            [name, json.dumps(defn, ensure_ascii=False)],
                        )
                        migrated += 1
            if migrated:
                log.info("migrated %d workouts from workouts.json", migrated)
        except Exception as e:  # noqa: BLE001
            log.warning("could not migrate workouts.json: %s", e)


def close_db() -> None:
    global _db
    if _db is not None:
        with _db_lock:
            _db.close()
        _db = None


# ---------------------------------------------------------------------------
# Persistent config (BLE address, etc.)
# ---------------------------------------------------------------------------

def load_config() -> dict[str, Any]:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(updates: dict[str, Any]) -> None:
    cfg = load_config()
    cfg.update(updates)
    try:
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("could not save config: %s", e)


# ----- workout CRUD -----

def db_list_workouts() -> dict[str, Any]:
    with _db_lock:
        rows = db().execute(
            "SELECT name, definition FROM workouts ORDER BY updated_at DESC"
        ).fetchall()
    return {name: json.loads(defn) for name, defn in rows}


def db_get_workout(name: str) -> dict[str, Any] | None:
    with _db_lock:
        row = db().execute(
            "SELECT definition FROM workouts WHERE name = ?", [name]
        ).fetchone()
    return json.loads(row[0]) if row else None


def db_save_workout(name: str, definition: dict[str, Any]) -> None:
    defn_json = json.dumps(definition, ensure_ascii=False)
    with _db_lock:
        db().execute(
            "INSERT INTO workouts (name, definition) VALUES (?, ?) "
            "ON CONFLICT (name) DO UPDATE SET "
            "definition = excluded.definition, updated_at = now()",
            [name, defn_json],
        )


def db_delete_workout(name: str) -> None:
    with _db_lock:
        db().execute("DELETE FROM workouts WHERE name = ?", [name])


# ----- session CRUD -----

def db_create_session(workout_name: str | None,
                      workout_snapshot: dict[str, Any] | None) -> int:
    snap_json = json.dumps(workout_snapshot, ensure_ascii=False) \
        if workout_snapshot is not None else None
    with _db_lock:
        row = db().execute(
            "INSERT INTO sessions (workout_name, workout_snapshot) "
            "VALUES (?, ?) RETURNING id",
            [workout_name, snap_json],
        ).fetchone()
    return int(row[0])


def db_insert_sample(session_id: int, t_sec: float,
                     payload: dict[str, Any]) -> None:
    with _db_lock:
        db().execute(
            "INSERT INTO samples "
            "(session_id, t_sec, power, spm, pace, distance, hr, energy) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                session_id, t_sec,
                payload.get("power"),
                payload.get("spm"),
                payload.get("pace"),
                payload.get("distance"),
                payload.get("hr"),
                payload.get("energy"),
            ],
        )


def db_finalise_session(session_id: int, duration_s: float,
                        completed: bool) -> dict[str, Any]:
    with _db_lock:
        agg = db().execute("""
            SELECT
                MAX(distance)                                          AS total_distance,
                AVG(NULLIF(power, 0))                                  AS avg_power,
                MAX(NULLIF(power, 0))                                  AS max_power,
                AVG(NULLIF(spm,   0))                                  AS avg_spm,
                AVG(NULLIF(pace,  0))                                  AS avg_pace,
                AVG(NULLIF(hr,    0))                                  AS avg_hr,
                MAX(energy)                                            AS total_energy,
                MAX(NULLIF(spm,   0))                                  AS max_spm,
                MAX(NULLIF(hr,    0))                                  AS max_hr,
                MIN(CASE WHEN pace > 0 AND pace < 600 THEN pace END)   AS best_pace
            FROM samples WHERE session_id = ?
        """, [session_id]).fetchone()
        total_distance, avg_power, max_power, avg_spm, avg_pace, avg_hr, \
            total_energy, max_spm, max_hr, best_pace = agg

        db().execute("""
            UPDATE sessions
               SET ended_at       = current_timestamp,
                   duration_s     = ?,
                   total_distance = ?,
                   avg_power      = ?,
                   max_power      = ?,
                   avg_spm        = ?,
                   avg_pace       = ?,
                   avg_hr         = ?,
                   total_energy   = ?,
                   completed      = ?,
                   max_spm        = ?,
                   max_hr         = ?,
                   best_pace      = ?
             WHERE id = ?
        """, [
            duration_s, total_distance, avg_power, max_power,
            avg_spm, avg_pace, avg_hr, total_energy,
            completed, max_spm, max_hr, best_pace,
            session_id,
        ])

    return {
        "duration_s":     duration_s,
        "total_distance": total_distance,
        "avg_power":      avg_power,
        "max_power":      max_power,
        "avg_spm":        avg_spm,
        "avg_pace":       avg_pace,
        "avg_hr":         avg_hr,
        "total_energy":   total_energy,
        "completed":      completed,
        "max_spm":        max_spm,
        "max_hr":         max_hr,
        "best_pace":      best_pace,
    }


def _row_to_dict(cols: list[str], row: tuple) -> dict[str, Any]:
    return {k: v.isoformat() if isinstance(v, datetime) else v for k, v in zip(cols, row)}


def db_list_sessions(limit: int = 100) -> list[dict[str, Any]]:
    cols = ["id", "workout_name", "started_at", "ended_at", "duration_s",
            "total_distance", "avg_power", "max_power", "avg_spm",
            "avg_pace", "avg_hr", "total_energy", "completed",
            "max_spm", "max_hr", "best_pace",
            "bmr_kcal", "exercise_kcal", "total_kcal", "user_id"]
    with _db_lock:
        rows = db().execute(
            f"SELECT {','.join(cols)} FROM sessions "
            f"WHERE ended_at IS NOT NULL "
            f"ORDER BY started_at DESC LIMIT {int(limit)}"
        ).fetchall()
    return [_row_to_dict(cols, r) for r in rows]


def db_get_session(session_id: int) -> dict[str, Any] | None:
    cols = ["id", "workout_name", "workout_snapshot", "started_at",
            "ended_at", "duration_s", "total_distance", "avg_power",
            "max_power", "avg_spm", "avg_pace", "avg_hr",
            "total_energy", "completed",
            "max_spm", "max_hr", "best_pace",
            "bmr_kcal", "exercise_kcal", "total_kcal", "user_id"]
    with _db_lock:
        row = db().execute(
            f"SELECT {','.join(cols)} FROM sessions WHERE id = ?",
            [session_id]
        ).fetchone()
        if not row:
            return None
        out = _row_to_dict(cols, row)
        if out.get("workout_snapshot"):
            try:
                out["workout_snapshot"] = json.loads(out["workout_snapshot"])
            except json.JSONDecodeError:
                pass
        scols = ["t_sec", "power", "spm", "pace", "distance", "hr", "energy"]
        srows = db().execute(
            f"SELECT {','.join(scols)} FROM samples "
            f"WHERE session_id = ? ORDER BY t_sec",
            [session_id]
        ).fetchall()
    out["samples"] = [_row_to_dict(scols, r) for r in srows]
    return out


def db_import_session(result: "kinomap_import.ImportResult") -> int:
    """
    Persist a completed session reconstructed from an external file
    (e.g. a Kinomap export).  Sets ``ended_at`` / ``completed`` / all
    aggregates in one go; does not touch the in-memory ``active`` state
    because no live recording is happening.

    Duplicate guard: refuses to import a session that has the same
    ``(workout_name, started_at)`` as an existing one.  Caller turns the
    raised ValueError into HTTP 409.
    """
    # DuckDB TIMESTAMP columns are timezone-naive → coerce to UTC-naive.
    started_naive = result.started_at.astimezone(timezone.utc).replace(tzinfo=None)
    ended_naive   = result.ended_at  .astimezone(timezone.utc).replace(tzinfo=None)

    # Aggregates straight from the sample list (mirrors what
    # db_finalise_session() computes via SQL — kept in Python here so
    # we can also write things like total_energy that don't sit on the
    # samples).
    powers = [s["power"] for s in result.samples if s["power"]]
    spms   = [s["spm"]   for s in result.samples if s["spm"]]
    paces  = [s["pace"]  for s in result.samples if s["pace"]]
    hrs    = [s["hr"]    for s in result.samples if s["hr"]]
    avg_power = sum(powers) / len(powers) if powers else None
    max_power = max(powers)               if powers else None
    avg_spm   = sum(spms)   / len(spms)   if spms   else None
    max_spm   = max(spms)                 if spms   else None
    avg_pace  = sum(paces)  / len(paces)  if paces  else None
    avg_hr    = sum(hrs)    / len(hrs)    if hrs    else None
    max_hr    = max(hrs)                  if hrs    else None
    valid_paces = [p for p in paces if 0 < p < 600]
    best_pace   = min(valid_paces)        if valid_paces else None

    snap_json = json.dumps({
        "source": "kinomap",
        "format": result.source_format,
        "files":  result.source_files,
    }, ensure_ascii=False)

    with _db_lock:
        existing = db().execute(
            "SELECT id FROM sessions "
            "WHERE workout_name = ? AND started_at = ?",
            [result.workout_name, started_naive],
        ).fetchone()
        if existing:
            raise ValueError(
                f"a session for {result.workout_name!r} starting at "
                f"{result.started_at.isoformat()} already exists "
                f"(id={existing[0]})"
            )

        row = db().execute("""
            INSERT INTO sessions (
                workout_name, workout_snapshot, started_at, ended_at,
                duration_s, total_distance, avg_power, max_power,
                avg_spm, avg_pace, avg_hr, total_energy, completed,
                max_spm, max_hr, best_pace
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?)
            RETURNING id
        """, [
            result.workout_name, snap_json, started_naive, ended_naive,
            result.duration_s, result.total_distance, avg_power, max_power,
            avg_spm, avg_pace, avg_hr, result.total_energy,
            max_spm, max_hr, best_pace,
        ]).fetchone()
        sid = int(row[0])

        sample_rows = [
            (sid, s["t_sec"], s["power"], s["spm"], s["pace"],
             s["distance"], s["hr"], s["energy"])
            for s in result.samples
        ]
        if sample_rows:
            db().executemany(
                "INSERT INTO samples "
                "(session_id, t_sec, power, spm, pace, distance, hr, energy) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                sample_rows,
            )

    return sid


def db_delete_session(session_id: int) -> None:
    with _db_lock:
        db().execute("DELETE FROM samples  WHERE session_id = ?", [session_id])
        db().execute("DELETE FROM sessions WHERE id = ?",         [session_id])


def db_update_session_energy(session_id: int, user_id: str | None,
                              bmr_kcal: int | None, exercise_kcal: int | None,
                              total_kcal: int | None) -> None:
    with _db_lock:
        db().execute("""
            UPDATE sessions
               SET user_id       = ?,
                   bmr_kcal      = ?,
                   exercise_kcal = ?,
                   total_kcal    = ?
             WHERE id = ?
        """, [user_id, bmr_kcal, exercise_kcal, total_kcal, session_id])


def db_trends() -> dict[str, Any]:
    """Per-session series + p10/mean/p90 percentile bands for multi-training analytics."""
    s_cols = ["id", "started_at", "avg_power", "avg_pace", "avg_spm",
              "total_distance", "duration_s", "total_energy", "max_power"]
    with _db_lock:
        s_rows = db().execute(
            f"SELECT {','.join(s_cols)} FROM sessions "
            f"WHERE ended_at IS NOT NULL ORDER BY started_at ASC"
        ).fetchall()
        if not s_rows:
            return {"series": [], "percentiles": {}, "power_profile": []}

        pct = db().execute("""
            SELECT
              PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY avg_power)      p25_power,
              AVG(avg_power)                                                mean_power,
              PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY avg_power)      p75_power,
              PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY avg_pace)       p25_pace,
              AVG(avg_pace)                                                 mean_pace,
              PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY avg_pace)       p75_pace,
              PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY avg_spm)        p25_spm,
              AVG(avg_spm)                                                  mean_spm,
              PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY avg_spm)        p75_spm,
              PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY total_distance) p25_distance,
              AVG(total_distance)                                           mean_distance,
              PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY total_distance) p75_distance,
              PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY duration_s)     p25_duration,
              AVG(duration_s)                                               mean_duration,
              PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY duration_s)     p75_duration
            FROM sessions WHERE ended_at IS NOT NULL
        """).fetchone()

        pp_sids = [r[0] for r in s_rows[-50:]]

        pp_samples: list[tuple] = []
        if pp_sids:
            ph = ",".join("?" * len(pp_sids))
            pp_samples = db().execute(
                f"SELECT session_id, t_sec, power FROM samples "
                f"WHERE session_id IN ({ph}) AND power > 0 "
                f"ORDER BY session_id, t_sec",
                pp_sids,
            ).fetchall()

    series = [_row_to_dict(s_cols, r) for r in s_rows]

    pct_keys = [
        "p25_power",    "mean_power",    "p75_power",
        "p25_pace",     "mean_pace",     "p75_pace",
        "p25_spm",      "mean_spm",      "p75_spm",
        "p25_distance", "mean_distance", "p75_distance",
        "p25_duration", "mean_duration", "p75_duration",
    ]
    pf = {k: (float(v) if v is not None else None)
          for k, v in zip(pct_keys, pct)}
    percentiles = {
        m: {"p25": pf[f"p25_{m}"], "mean": pf[f"mean_{m}"], "p75": pf[f"p75_{m}"]}
        for m in ("power", "pace", "spm", "distance", "duration")
    }

    # Power-profile percentile bands (max avg power for fixed durations)
    by_sid: dict[int, list[tuple[float, float]]] = {}
    for sid, t, p in pp_samples:
        by_sid.setdefault(sid, []).append((float(t), float(p)))

    def _map4dur(pts: list[tuple[float, float]], d: float) -> float | None:
        if len(pts) < 2:
            return None
        avg_int = (pts[-1][0] - pts[0][0]) / (len(pts) - 1)
        best = 0.0
        lo = 0
        su = 0.0
        for hi in range(len(pts)):
            su += pts[hi][1]
            while pts[hi][0] - pts[lo][0] > d:
                su -= pts[lo][1]
                lo += 1
            if pts[hi][0] - pts[lo][0] + avg_int >= d:
                avg = su / (hi - lo + 1)
                if avg > best:
                    best = avg
        return float(best) if best > 0 else None

    pp_bins = [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600]
    power_profile: list[dict[str, Any]] = []
    for d in pp_bins:
        vals: list[float] = []
        for pts in by_sid.values():
            if len(pts) < 2:
                continue
            if pts[-1][0] - pts[0][0] < d * 0.5:
                continue
            v = _map4dur(pts, d)
            if v is not None:
                vals.append(v)
        if len(vals) < 2:
            continue
        vals.sort()
        nn = len(vals)
        power_profile.append({
            "d":    d,
            "p25":  round(vals[max(0, int(nn * 0.25))], 1),
            "mean": round(sum(vals) / nn, 1),
            "p75":  round(vals[min(nn - 1, int(nn * 0.75))], 1),
            "n":    nn,
        })

    return {
        "series":        series,
        "percentiles":   percentiles,
        "power_profile": power_profile,
    }


def db_stats(days: int = 0) -> dict[str, Any]:
    """Aggregates for the history dashboard:
       per-day activity, lifetime totals, personal bests.
       days=0 means all time."""
    day_filter = (
        f"AND started_at >= current_date - INTERVAL {int(days)} DAY"
        if days > 0 else ""
    )
    with _db_lock:
        daily_rows = db().execute(f"""
            SELECT CAST(date_trunc('day', started_at) AS DATE) AS day,
                   COUNT(*)                AS sessions,
                   COALESCE(SUM(duration_s),     0) AS duration_s,
                   COALESCE(SUM(total_distance), 0) AS distance_m,
                   AVG(avg_power)                   AS avg_power
              FROM sessions
             WHERE ended_at IS NOT NULL
               {day_filter}
             GROUP BY 1 ORDER BY 1
        """).fetchall()

        totals_row = db().execute("""
            SELECT COUNT(*)                          AS sessions,
                   COALESCE(SUM(duration_s),     0) AS duration_s,
                   COALESCE(SUM(total_distance), 0) AS distance_m,
                   COALESCE(SUM(total_energy),   0) AS energy_kcal,
                   AVG(avg_power)                    AS avg_power,
                   AVG(avg_spm)                      AS avg_spm,
                   AVG(avg_pace)                     AS avg_pace,
                   AVG(avg_hr)                       AS avg_hr
              FROM sessions
             WHERE ended_at IS NOT NULL
        """).fetchone()

        bests_row = db().execute("""
            SELECT MAX(max_power)      AS max_power,
                   MAX(total_distance) AS max_distance,
                   MAX(duration_s)     AS max_duration_s,
                   MIN(NULLIF(avg_pace, 0)) AS best_pace
              FROM sessions
             WHERE ended_at IS NOT NULL
        """).fetchone()

    daily = [{
        "day": d.isoformat(),
        "sessions":   int(s),
        "duration_s": float(dur or 0),
        "distance_m": int(dist or 0),
        "avg_power":  float(p) if p is not None else None,
    } for (d, s, dur, dist, p) in daily_rows]

    totals = {
        "sessions":    int(totals_row[0] or 0),
        "duration_s":  float(totals_row[1] or 0),
        "distance_m":  int(totals_row[2] or 0),
        "energy_kcal": int(totals_row[3] or 0),
        "avg_power":   float(totals_row[4]) if totals_row[4] is not None else None,
        "avg_spm":     float(totals_row[5]) if totals_row[5] is not None else None,
        "avg_pace":    float(totals_row[6]) if totals_row[6] is not None else None,
        "avg_hr":      float(totals_row[7]) if totals_row[7] is not None else None,
    }
    bests = {
        "max_power":      int(bests_row[0])    if bests_row[0] is not None else None,
        "max_distance":   int(bests_row[1])    if bests_row[1] is not None else None,
        "max_duration_s": float(bests_row[2])  if bests_row[2] is not None else None,
        "best_pace":      float(bests_row[3])  if bests_row[3] is not None else None,
    }
    return {"daily": daily, "totals": totals, "bests": bests}


# ---------------------------------------------------------------------------
# Active session state
# ---------------------------------------------------------------------------
# Tracks the *currently running* recording (if any). Only one session may be
# active at a time — the start endpoint returns 409 otherwise. All times here
# are event-loop monotonic seconds (not wall-clock), so pausing the session
# doesn't drift when the system clock changes.

class ActiveSession:
    def __init__(self) -> None:
        self.id: int | None = None
        self.started_at: float | None = None   # loop.time() at session start
        self.paused_at: float | None = None    # loop.time() at last pause
        self.paused_total: float = 0.0         # cumulative paused seconds
        self.running: bool = False

    def reset(self) -> None:
        self.__init__()

    def elapsed(self) -> float:
        """Wall-clock seconds the session has been *actively* running, i.e.
        total duration minus any paused intervals. Reads the event-loop
        monotonic clock (set in api_session_start), so this must be called
        from inside the async loop."""
        if self.started_at is None:
            return 0.0
        # asyncio.get_event_loop() is deprecated since Python 3.10 when no
        # loop is running; we're always inside the running loop here.
        now = asyncio.get_running_loop().time()
        if self.running:
            return now - self.started_at - self.paused_total
        if self.paused_at is not None:
            return self.paused_at - self.started_at - self.paused_total
        return 0.0


active = ActiveSession()


# ---------------------------------------------------------------------------
# Rower connection state (for control point writes)
# ---------------------------------------------------------------------------

class RowerLink:
    client: Any = None
    control_acquired: bool = False
    device_started: bool = False   # True after START_OR_RESUME accepted
    current_resistance: int | None = None
    resistance_min: int = RESISTANCE_MIN
    resistance_max: int = RESISTANCE_MAX
    connected: bool = False
    address: str | None = None
    # FTMS Control Point indication sync (set by on_ctrl_response callback)
    _cp_event: asyncio.Event | None = None
    _cp_result: int | None = None
    # True only if start_notify for the CP characteristic succeeded
    cp_indications_active: bool = False
    # monotonic timestamp until which device-reported resistance that doesn't
    # match current_resistance should be ignored (write in flight)
    _resistance_write_until: float = 0.0
    # Resistance requested while GATT setup was still in progress; applied on ready.
    _pending_resistance: int | None = None


rower = RowerLink()

# Serialises concurrent GATT writes so two HTTP requests can't clobber each other's
# _cp_event or trigger simultaneous Control Point writes (→ UNLIKELY_ERROR).
_resistance_lock = asyncio.Lock()

# Set by /api/ble/connect (or on demand at training start) to wake the BLE task.
# Stays set forever once triggered — the task reconnects on drops automatically.
_ble_connect_event: asyncio.Event | None = None


def _clamp_level(level: int) -> int:
    return max(rower.resistance_min, min(rower.resistance_max, int(level)))


async def _wait_cp_indication(timeout: float = 4.0) -> int | None:
    """Wait for a FTMS Control Point indication and return the result code,
    or None on timeout. Only call this when rower.cp_indications_active is True."""
    if rower._cp_event is None:
        return None
    try:
        await asyncio.wait_for(rower._cp_event.wait(), timeout=timeout)
        return rower._cp_result
    except asyncio.TimeoutError:
        return None


async def set_resistance(level: int) -> bool:
    """Write Target Resistance Level (0x04) via FTMS Control Point (0x2AD9).
       Acquires control once. Takes a direct level (1–15).

       Strategy:
       - Optimistically update current_resistance + broadcast before the GATT
         write, so the UI is always responsive.
       - If CP indications are active, also wait for the device ack and roll
         back on an explicit rejection.
    """
    level = _clamp_level(level)

    if SIM_MODE or rower.client is None or not rower.connected:
        rower.current_resistance = level
        if not SIM_MODE and rower.client is not None:
            # GATT setup still in progress — remember for when the device is ready.
            rower._pending_resistance = level
        await manager.broadcast(
            {"type": "resistance", "level": level, "simulated": True}
        )
        return True

    # Optimistic update – keeps the UI in sync even if the GATT write is slow.
    # on_notify will broadcast again if the device reports a different level.
    old_level = rower.current_resistance
    rower.current_resistance = level
    rower._resistance_write_until = time.monotonic() + 3.0
    await manager.broadcast({"type": "resistance", "level": level})

    log.info("→ WRITE resistance: level=%d", level)

    async with _resistance_lock:
        try:
            if not rower.control_acquired:
                if rower.cp_indications_active:
                    rower._cp_event = asyncio.Event()
                    rower._cp_result = None
                await rower.client.write_gatt_char(
                    CONTROL_POINT_UUID, bytes([FTMS_OP_REQUEST_CONTROL]),
                    response=True,
                )
                if rower.cp_indications_active:
                    code = await _wait_cp_indication()
                    if code is None:
                        log.warning("FTMS REQUEST_CONTROL: no indication (continuing)")
                    elif code != 0x01:
                        log.warning("FTMS REQUEST_CONTROL rejected (code=0x%02x), continuing", code)
                rower.control_acquired = True
                log.info("FTMS control acquired")

            # FTMS rowing machines only accept SET_RESISTANCE in "Started" state.
            # Send START_OR_RESUME once per connection to enter that state.
            if not rower.device_started:
                if rower.cp_indications_active:
                    rower._cp_event = asyncio.Event()
                    rower._cp_result = None
                await rower.client.write_gatt_char(
                    CONTROL_POINT_UUID, bytes([FTMS_OP_START_OR_RESUME]),
                    response=True,
                )
                if rower.cp_indications_active:
                    code = await _wait_cp_indication()
                    if code == 0x01:
                        log.info("FTMS device started (resistance control now active)")
                    else:
                        # Device returns 0x00 when already started; proceed regardless.
                        log.warning("START_OR_RESUME: code=0x%02x (proceeding anyway)",
                                    code or 0)
                rower.device_started = True

            if rower.cp_indications_active:
                rower._cp_event = asyncio.Event()
                rower._cp_result = None
            payload = bytes([FTMS_OP_SET_RESISTANCE, level * 10])
            await rower.client.write_gatt_char(
                CONTROL_POINT_UUID, payload, response=True,
            )
            if rower.cp_indications_active:
                code = await _wait_cp_indication()
                if code is None:
                    log.warning("SET_RESISTANCE: no indication received")
                elif code != 0x01:
                    log.warning("SET_RESISTANCE rejected by device (code=0x%02x)", code)
                    rower.current_resistance = old_level
                    rower.control_acquired = False
                    rower.device_started = False
                    await manager.broadcast({
                        "type": "resistance",
                        "level": old_level if old_level is not None else rower.resistance_min,
                    })
                    return False
            return True
        except Exception as exc:                # noqa: BLE001
            log.warning("set_resistance failed: %s (%s)", exc, type(exc).__name__)
            rower.current_resistance = old_level
            rower.control_acquired = False
            rower.device_started = False
            return False


# ---------------------------------------------------------------------------
# WebSocket fan-out
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self) -> None:
        self.connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.connections.append(ws)
        log.info("client connected (%d total)", len(self.connections))
        await ws.send_json({
            "type": "status",
            "connected": rower.client is not None,
            "address":   rower.address,
        })
        if rower.current_resistance is not None:
            await ws.send_json({
                "type": "resistance",
                "level": rower.current_resistance,
            })

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.connections:
            self.connections.remove(ws)
            log.info("client disconnected (%d total)", len(self.connections))

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Send `message` (as JSON) to every connected WebSocket client.
        Any client whose send fails (closed socket, network error) is
        silently removed — callers don't need to care about dead clients.
        """
        dead: list[WebSocket] = []
        for ws in self.connections:
            try:
                await ws.send_json(message)
            except Exception:        # noqa: BLE001 — any failure → drop client
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# FTMS Rower Data parser
# ---------------------------------------------------------------------------

def parse_rower_data(data: bytes) -> dict[str, Any]:
    """Parse a single ``Rower Data`` (0x2AD1) notify packet from an FTMS
    device into a flat dict.

    The packet starts with a 16-bit flags field that selects which fields
    follow, in a fixed order. Bit 0 ("More Data") is a quirk: when *set*,
    ``stroke_rate`` and ``stroke_count`` are *omitted* (FTMS fragments the
    payload when it exceeds the BLE MTU).

    See ``CONTEXT.md`` §4.3 for the full flag → field table.
    """
    if len(data) < 2:
        return {}
    flags = struct.unpack_from("<H", data, 0)[0]
    o = 2                            # read cursor, in bytes
    out: dict[str, Any] = {}

    def take(fmt: str, size: int):
        """Consume `size` bytes at the cursor and return the decoded value,
        or None if the packet is truncated. ``size`` must match ``fmt``."""
        nonlocal o
        if o + size > len(data):
            return None
        v = struct.unpack_from(fmt, data, o)[0]
        o += size
        return v

    if not (flags & 0x0001):
        v = take("<B", 1)
        if v is not None: out["stroke_rate"] = v * 0.5
        v = take("<H", 2)
        if v is not None: out["stroke_count"] = v
    if flags & 0x0002:
        v = take("<B", 1)
        if v is not None: out["avg_stroke_rate"] = v * 0.5
    if flags & 0x0004:
        if o + 3 <= len(data):
            b = data[o:o+3]
            out["total_distance"] = b[0] | (b[1] << 8) | (b[2] << 16)
            o += 3
    if flags & 0x0008:
        v = take("<H", 2)
        if v is not None: out["instantaneous_pace"] = v
    if flags & 0x0010:
        v = take("<H", 2)
        if v is not None: out["average_pace"] = v
    if flags & 0x0020:
        v = take("<h", 2)
        if v is not None: out["instantaneous_power"] = v
    if flags & 0x0040:
        v = take("<h", 2)
        if v is not None: out["average_power"] = v
    if flags & 0x0080:
        v = take("<h", 2)
        if v is not None: out["resistance_level"] = v
    if flags & 0x0100:
        v = take("<H", 2)
        if v is not None: out["total_energy"] = v
        v = take("<H", 2)
        if v is not None: out["energy_per_hour"] = v
        v = take("<B", 1)
        if v is not None: out["energy_per_minute"] = v
    if flags & 0x0200:
        v = take("<B", 1)
        if v is not None: out["heart_rate"] = v
    if flags & 0x0400:
        v = take("<B", 1)
        if v is not None: out["metabolic_equivalent"] = v * 0.1
    if flags & 0x0800:
        v = take("<H", 2)
        if v is not None: out["elapsed_time"] = v
    if flags & 0x1000:
        v = take("<H", 2)
        if v is not None: out["remaining_time"] = v
    return out


def _make_rower_payload(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "type":     "rower",
        "power":    p.get("instantaneous_power"),
        "spm":      p.get("stroke_rate"),
        "pace":     p.get("instantaneous_pace"),
        "distance": p.get("total_distance"),
        "hr":       p.get("heart_rate"),
        "energy":   p.get("total_energy"),
    }


async def _maybe_record_sample(payload: dict[str, Any]) -> None:
    if active.id is None or not active.running:
        return
    t = active.elapsed()
    try:
        await asyncio.get_running_loop().run_in_executor(
            None, db_insert_sample, active.id, t, payload
        )
    except Exception as e:               # noqa: BLE001
        log.warning("could not record sample: %s", e)


# ---------------------------------------------------------------------------
# Rower background tasks
# ---------------------------------------------------------------------------

async def real_rower_task() -> None:
    loop = asyncio.get_running_loop()
    while True:
        # Wait until a training requests the connection.
        if _ble_connect_event is not None:
            await _ble_connect_event.wait()

        cfg = load_config()
        address: str | None = cfg.get("ble_address")

        if not address:
            log.warning("BLE connect requested but no device address in config.json")
            rower.connected = False
            rower.address = None
            await manager.broadcast({
                "type": "status", "connected": False, "error": "no_address",
            })
            await asyncio.sleep(5)
            continue

        log.info("connecting to %s …", address)

        # Warm up BlueZ's device cache before connecting.
        # This shortens the subsequent HCI connect time significantly.
        try:
            found = await BleakScanner.find_device_by_address(address, timeout=8.0)
            if found:
                log.info("device found in scan: %s", found.name)
            else:
                log.warning("device not found in scan — attempting direct connect anyway")
        except Exception as exc:
            log.warning("pre-connect scan failed: %s", exc)


        try:
            def on_notify(_char, raw: bytearray) -> None:
                """BLE GATT notify callback — runs on bleak's worker thread."""
                p = parse_rower_data(bytes(raw))
                if "resistance_level" in p:
                    new_level = int(p["resistance_level"])
                    if new_level != rower.current_resistance:
                        if time.monotonic() < rower._resistance_write_until:
                            log.debug("← READ  resistance: level=%d (ignored, write pending)",
                                      new_level)
                        else:
                            log.info("← READ  resistance: level=%d (from device)", new_level)
                            rower.current_resistance = new_level
                            asyncio.run_coroutine_threadsafe(
                                manager.broadcast({
                                    "type": "resistance",
                                    "level": new_level,
                                }),
                                loop,
                            )
                payload = _make_rower_payload(p)
                asyncio.run_coroutine_threadsafe(
                    manager.broadcast(payload), loop
                )
                asyncio.run_coroutine_threadsafe(
                    _maybe_record_sample(payload), loop
                )

            def on_ctrl_response(_char, raw: bytearray) -> None:
                if len(raw) >= 3 and raw[0] == 0x80:
                    op, code = raw[1], raw[2]
                    if code == 0x01:
                        log.info("FTMS CP ack: opcode=0x%02x success", op)
                    else:
                        log.warning("FTMS CP ack: opcode=0x%02x error=0x%02x", op, code)
                    if rower._cp_event is not None:
                        def _signal(c: int = code) -> None:
                            rower._cp_result = c
                            if rower._cp_event is not None:
                                rower._cp_event.set()
                        loop.call_soon_threadsafe(_signal)

            async with BleakClient(address, timeout=45.0) as client:
                rower.client = client
                rower.address = address
                rower.control_acquired = False
                rower.device_started = False
                rower.cp_indications_active = False
                # Announce the physical connection right away so the UI hides the
                # overlay and autoStartSession can fire.  GATT setup follows below;
                # rower.connected (the GATT-ready flag) is set after that.
                await manager.broadcast({
                    "type": "status", "connected": True,
                    "address": address,
                })
                await client.start_notify(ROWER_DATA_UUID, on_notify)
                try:
                    await client.start_notify(CONTROL_POINT_UUID, on_ctrl_response)
                    rower.cp_indications_active = True
                    log.info("subscribed to FTMS Control Point indications")
                except Exception as e:  # noqa: BLE001
                    log.warning("could not subscribe to FTMS CP indications: %s", e)
                try:
                    raw = bytes(await client.read_gatt_char(
                        SUPPORTED_RESISTANCE_RANGE_UUID
                    ))
                    if len(raw) == 3:
                        r_min, r_max, _ = raw[0], raw[1], raw[2]
                    elif len(raw) >= 6:
                        r_min, r_max, _ = struct.unpack_from("<HHH", raw)
                    else:
                        raise ValueError(f"unexpected length {len(raw)}")
                    rower.resistance_min = r_min // 10
                    rower.resistance_max = r_max // 10
                    log.info(
                        "resistance range from device: %d–%d (raw %d–%d)",
                        rower.resistance_min, rower.resistance_max, r_min, r_max,
                    )
                except Exception as e:  # noqa: BLE001
                    rower.resistance_min = RESISTANCE_MIN
                    rower.resistance_max = RESISTANCE_MAX
                    log.info(
                        "0x2AD6 not available (%s) — using defaults %d–%d",
                        e, RESISTANCE_MIN, RESISTANCE_MAX,
                    )
                rower.connected = True
                log.info("subscribed to rower data, streaming…")
                if rower._pending_resistance is not None:
                    pending = rower._pending_resistance
                    rower._pending_resistance = None
                    asyncio.create_task(set_resistance(pending))
                while client.is_connected:
                    await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise
        except Exception as exc:         # noqa: BLE001
            log.exception("rower task error: %s", exc)
        finally:
            rower.client = None
            rower.connected = False
            rower.control_acquired = False
            rower.device_started = False
            rower.cp_indications_active = False
            rower._pending_resistance = None
        await manager.broadcast({"type": "status", "connected": False})
        await asyncio.sleep(5)


async def simulated_rower_task() -> None:
    log.warning("running in SIMULATION mode – no real Bluetooth connection")
    rower.connected = True
    rower.address = "SIM"
    rower.current_resistance = round(RESISTANCE_MAX / 2)
    await manager.broadcast({"type": "status", "connected": True, "address": "SIM"})
    await manager.broadcast({"type": "resistance", "level": rower.current_resistance})
    t = 0.0
    distance = 0
    while True:
        # resistance influences perceived power in sim
        res = rower.current_resistance or 5
        base = (15 + res * 4) + 12 * math.sin(t * 0.08)
        power = max(0, int(base + random.uniform(-6, 6)))
        distance += int(2 + power / 30)
        payload = {
            "type": "rower",
            "power": power,
            "spm": 30,
            "pace": int(500 / max(1, power / 30 + 1)) if power else None,
            "distance": distance,
            "hr": None,
            "energy": int(t * 0.05),
        }
        await manager.broadcast(payload)
        await _maybe_record_sample(payload)
        t += 2
        await asyncio.sleep(2)


# ---------------------------------------------------------------------------
# FastAPI lifecycle & routes
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ble_connect_event
    _ble_connect_event = asyncio.Event()
    init_db()
    log.info("DuckDB ready at %s", DB_FILE)
    if SIM_MODE or not BLEAK_AVAILABLE:
        if not BLEAK_AVAILABLE:
            log.warning("bleak not installed – simulation mode")
        task = asyncio.create_task(simulated_rower_task())
    else:
        task = asyncio.create_task(real_rower_task())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        close_db()


app = FastAPI(title="Woodrower Trainer", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "index.html")


# ----- workouts -----

@app.get("/api/workouts")
async def api_list_workouts():
    return db_list_workouts()


@app.get("/api/workouts/{name}")
async def api_get_workout(name: str):
    w = db_get_workout(name)
    if w is None:
        raise HTTPException(404, "workout not found")
    return w


@app.put("/api/workouts/{name}")
async def api_save_workout(name: str, workout: dict[str, Any]):
    # Light shape validation. We keep it permissive (no Pydantic model) so
    # the editor in index.html can evolve without forcing schema changes
    # here, but we still reject obviously-malformed input that would only
    # blow up later in expandWorkout().
    if not name or len(name) > MAX_WORKOUT_NAME_LEN:
        raise HTTPException(400, f"name must be 1..{MAX_WORKOUT_NAME_LEN} chars")
    if not isinstance(workout, dict):
        raise HTTPException(400, "workout must be a JSON object")
    serialized = json.dumps(workout, ensure_ascii=False)
    if len(serialized) > MAX_WORKOUT_JSON_LEN:
        raise HTTPException(413, "workout JSON too large")
    repeat_count = workout.get("repeat_count")
    if repeat_count is not None and not isinstance(repeat_count, (int, float)):
        raise HTTPException(400, "repeat_count must be a number")
    steps = workout.get("steps")
    if steps is not None and (not isinstance(steps, list) or
                              len(steps) > MAX_WORKOUT_STEPS):
        raise HTTPException(400, f"too many steps (max {MAX_WORKOUT_STEPS})")
    db_save_workout(name, workout)
    return {"ok": True}


@app.delete("/api/workouts/{name}")
async def api_delete_workout(name: str):
    db_delete_workout(name)
    return {"ok": True}


# ----- sessions -----

@app.post("/api/sessions/start")
async def api_session_start(body: dict[str, Any]):
    if active.id is not None:
        raise HTTPException(409, f"a session is already active (id={active.id})")
    workout_name     = body.get("workout_name")
    workout_snapshot = body.get("workout_snapshot")
    sid = db_create_session(workout_name, workout_snapshot)
    active.reset()
    active.id = sid
    active.started_at = asyncio.get_running_loop().time()
    active.running = True
    log.info("session %s started (workout=%s)", sid, workout_name)
    return {"id": sid}


@app.post("/api/sessions/{session_id}/pause")
async def api_session_pause(session_id: int):
    if active.id != session_id or not active.running:
        raise HTTPException(409, "session is not running")
    active.running = False
    active.paused_at = asyncio.get_running_loop().time()
    return {"ok": True}


@app.post("/api/sessions/{session_id}/resume")
async def api_session_resume(session_id: int):
    if active.id != session_id or active.running:
        raise HTTPException(409, "session is not paused")
    if active.paused_at is not None:
        active.paused_total += \
            asyncio.get_running_loop().time() - active.paused_at
        active.paused_at = None
    active.running = True
    return {"ok": True}


@app.post("/api/sessions/{session_id}/stop")
async def api_session_stop(session_id: int, body: dict[str, Any] | None = None):
    if active.id != session_id:
        raise HTTPException(409, "session is not active")
    duration = active.elapsed()
    completed = bool((body or {}).get("completed", False))
    summary = db_finalise_session(session_id, duration, completed)
    active.reset()
    log.info("session %s stopped (duration=%.1fs, completed=%s)",
             session_id, duration, completed)
    return {"id": session_id, **summary}


@app.post("/api/sessions/import")
async def api_session_import(file: UploadFile = File(...)):
    """
    Import a completed workout from a Kinomap export.

    Accepted upload formats:
      * a ZIP file as downloaded from Kinomap (preferred — contains all
        four formats; the server picks the most informative one);
      * a single ``.tcx`` / ``.pwx`` / ``.csv`` file (``.gpx`` alone is
        not a usable data source).

    Returns 409 if a session with the same workout name + start time
    already exists, so re-uploading the same archive is safe.

    The upload is capped at ``MAX_UPLOAD_BYTES`` to keep a hostile file
    from exhausting server memory; the underlying XML parser is
    defusedxml-based, so well-known XML attacks (billion-laughs, XXE,
    quadratic blowup) are rejected as well.
    """
    # Reading with an upper bound prevents an arbitrarily large upload
    # from being slurped into RAM. We read MAX+1 so we can tell "exactly
    # at the limit" from "definitely over".
    blob = await file.read(MAX_UPLOAD_BYTES + 1)
    if not blob:
        raise HTTPException(400, "empty upload")
    if len(blob) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"upload too large (max {MAX_UPLOAD_BYTES // 1024 // 1024} MiB)"
        )
    try:
        result = kinomap_import.import_bytes(blob, filename=file.filename or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:          # noqa: BLE001
        log.exception("kinomap import failed")
        raise HTTPException(400, f"could not parse upload: {e}")

    try:
        sid = db_import_session(result)
    except ValueError as e:
        raise HTTPException(409, str(e))

    log.info(
        "imported session id=%s (%s, %.0fs, %sm) from %s",
        sid, result.workout_name, result.duration_s,
        result.total_distance, result.source_format,
    )

    return {
        "id":             sid,
        "workout_name":   result.workout_name,
        "started_at":     result.started_at.isoformat(),
        "duration_s":     result.duration_s,
        "total_distance": result.total_distance,
        "total_energy":   result.total_energy,
        "source_format":  result.source_format,
        "n_samples":      len(result.samples),
    }


@app.get("/api/sessions")
async def api_list_sessions(limit: int = 100):
    return db_list_sessions(limit)


@app.get("/api/sessions/{session_id}")
async def api_get_session(session_id: int):
    s = db_get_session(session_id)
    if s is None:
        raise HTTPException(404, "session not found")
    return s


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: int):
    if active.id == session_id:
        raise HTTPException(409, "cannot delete an active session")
    db_delete_session(session_id)
    return {"ok": True}


@app.patch("/api/sessions/{session_id}/energy")
async def api_session_energy(session_id: int, body: dict[str, Any]):
    db_update_session_energy(
        session_id,
        body.get("user_id"),
        body.get("bmr_kcal"),
        body.get("exercise_kcal"),
        body.get("total_kcal"),
    )
    return {"ok": True}


# ----- resistance & stats -----

@app.get("/api/resistance")
async def api_resistance_get():
    return {
        "level": rower.current_resistance,
        "connected": rower.connected,
        "simulated": SIM_MODE or not BLEAK_AVAILABLE,
    }


@app.post("/api/resistance")
async def api_resistance_set(body: dict[str, Any]):
    level = body.get("level")
    if level is None or not isinstance(level, (int, float)):
        raise HTTPException(400, "level (int, 1–15) required")
    clamped = _clamp_level(int(level))
    ok = await set_resistance(clamped)
    if not ok:
        raise HTTPException(502, "could not write resistance to device")
    return {"ok": True, "level": clamped}


@app.get("/api/stats")
async def api_stats(days: int = 0):
    return db_stats(days=days)


@app.get("/api/stats/trends")
async def api_stats_trends():
    return db_trends()


@app.post("/api/shutdown")
async def api_shutdown():
    os.kill(os.getpid(), signal.SIGTERM)
    return {"ok": True}


# ----- export -----


def _export_session_ids(ids_param: str | None) -> list[int]:
    """Parse the ?ids= query param into a list of session IDs.
    Returns all completed session IDs only when ids_param is None (not provided)."""
    if ids_param is not None:
        try:
            return [int(x) for x in ids_param.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(400, "ids must be comma-separated integers")
    with _db_lock:
        rows = db().execute(
            "SELECT id FROM sessions WHERE ended_at IS NOT NULL ORDER BY started_at DESC"
        ).fetchall()
    return [r[0] for r in rows]


def _sessions_for_export(ids: list[int]) -> list[dict[str, Any]]:
    result = []
    for sid in ids:
        s = db_get_session(sid)
        if s is not None:
            result.append(s)
    return result


def _parse_dt(dt: datetime | str | None) -> datetime | None:
    if dt is None:
        return None
    if isinstance(dt, str):
        dt = datetime.fromisoformat(dt.rstrip("Z"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _fmt_dt(dt: datetime | str | None) -> str:
    parsed = _parse_dt(dt)
    if parsed is None:
        return ""
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")


def _session_to_tcx(s: dict[str, Any]) -> str:
    started = _parse_dt(s.get("started_at")) or datetime.now(timezone.utc)

    lap_start = _fmt_dt(started)
    duration = s.get("duration_s") or 0.0
    distance = s.get("total_distance") or 0
    kcal = s.get("total_kcal")
    calories = kcal if kcal is not None else (s.get("total_energy") or 0)
    avg_hr   = s.get("avg_hr")
    max_hr   = s.get("max_hr")

    hr_avg_xml = (f"<AverageHeartRateBpm><Value>{int(avg_hr)}</Value></AverageHeartRateBpm>"
                  if avg_hr else "")
    hr_max_xml = (f"<MaximumHeartRateBpm><Value>{int(max_hr)}</Value></MaximumHeartRateBpm>"
                  if max_hr else "")

    trackpoints = []
    for sample in s.get("samples", []):
        t = started.timestamp() + (sample.get("t_sec") or 0)
        ts = datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        dist  = sample.get("distance") or 0
        hr    = sample.get("hr")
        cad   = sample.get("spm")
        power = sample.get("power")

        hr_xml  = f"<HeartRateBpm><Value>{int(hr)}</Value></HeartRateBpm>" if hr else ""
        cad_xml = f"<Cadence>{int(cad)}</Cadence>" if cad else ""
        pwr_xml = (f"<Extensions><ns3:TPX><ns3:Watts>{int(power)}</ns3:Watts></ns3:TPX></Extensions>"
                   if power else "")

        trackpoints.append(
            f"<Trackpoint>"
            f"<Time>{ts}</Time>"
            f"<DistanceMeters>{dist}</DistanceMeters>"
            f"{hr_xml}{cad_xml}{pwr_xml}"
            f"</Trackpoint>"
        )

    tracks_xml = "<Track>" + "".join(trackpoints) + "</Track>" if trackpoints else ""

    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"'
        ' xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">'
        "<Activities>"
        '<Activity Sport="Rowing">'
        f"<Id>{lap_start}</Id>"
        f'<Lap StartTime="{lap_start}">'
        f"<TotalTimeSeconds>{duration:.1f}</TotalTimeSeconds>"
        f"<DistanceMeters>{distance}</DistanceMeters>"
        f"<Calories>{int(calories)}</Calories>"
        f"{hr_avg_xml}{hr_max_xml}"
        "<Intensity>Active</Intensity>"
        "<TriggerMethod>Manual</TriggerMethod>"
        f"{tracks_xml}"
        "</Lap>"
        "</Activity>"
        "</Activities>"
        "</TrainingCenterDatabase>"
    )


def _session_to_fit_bytes(s: dict[str, Any]) -> bytes:
    from fit_tool.fit_file_builder import FitFileBuilder
    from fit_tool.profile.messages.activity_message import ActivityMessage
    from fit_tool.profile.messages.file_id_message import FileIdMessage
    from fit_tool.profile.messages.lap_message import LapMessage
    from fit_tool.profile.messages.record_message import RecordMessage
    from fit_tool.profile.messages.session_message import SessionMessage
    from fit_tool.profile.profile_type import (
        Activity, Event, EventType, FileType,
        LapTrigger, Sport, SubSport,
    )

    started = _parse_dt(s.get("started_at")) or datetime.now(timezone.utc)
    ended   = _parse_dt(s.get("ended_at"))   or started

    # fit-tool expects Unix milliseconds; it encodes internally to FIT epoch seconds
    start_ms  = int(started.timestamp() * 1000)
    end_ms    = int(ended.timestamp()   * 1000)
    duration  = s.get("duration_s") or 0.0
    distance  = float(s.get("total_distance") or 0)
    _kcal     = s.get("total_kcal")
    calories  = int(_kcal if _kcal is not None else (s.get("total_energy") or 0))
    avg_power = int(s.get("avg_power") or 0)
    max_power = int(s.get("max_power") or 0)
    avg_spm   = int(s.get("avg_spm")   or 0)
    max_spm   = int(s.get("max_spm")   or 0)
    avg_hr    = s.get("avg_hr")
    max_hr    = s.get("max_hr")

    builder = FitFileBuilder()

    fid = FileIdMessage()
    fid.type = FileType.ACTIVITY
    fid.time_created = start_ms
    builder.add(fid)

    for sample in s.get("samples", []):
        t_sec = sample.get("t_sec") or 0
        rec = RecordMessage()
        rec.timestamp = start_ms + int(t_sec * 1000)
        dist = sample.get("distance")
        if dist is not None:
            rec.distance = float(dist)
        power = sample.get("power")
        if power is not None:
            rec.power = int(power)
        spm = sample.get("spm")
        if spm is not None:
            rec.cadence = int(spm)
        hr = sample.get("hr")
        if hr is not None:
            rec.heart_rate = int(hr)
        pace = sample.get("pace")
        if pace and pace > 0:
            rec.speed = round(500.0 / pace, 4)
        builder.add(rec)

    lap = LapMessage()
    lap.timestamp       = end_ms
    lap.start_time      = start_ms
    lap.total_elapsed_time = duration
    lap.total_timer_time   = duration
    lap.total_distance  = distance
    lap.total_calories  = calories
    lap.avg_power       = avg_power
    lap.max_power       = max_power
    lap.avg_cadence     = avg_spm
    lap.max_cadence     = max_spm
    if avg_hr:
        lap.avg_heart_rate = int(avg_hr)
    if max_hr:
        lap.max_heart_rate = int(max_hr)
    lap.event           = Event.LAP
    lap.event_type      = EventType.STOP
    lap.lap_trigger     = LapTrigger.SESSION_END
    lap.sport           = Sport.ROWING
    builder.add(lap)

    sess = SessionMessage()
    sess.timestamp         = end_ms
    sess.start_time        = start_ms
    sess.total_elapsed_time = duration
    sess.total_timer_time  = duration
    sess.total_distance    = distance
    sess.total_calories    = calories
    sess.avg_power         = avg_power
    sess.max_power         = max_power
    sess.avg_cadence       = avg_spm
    sess.max_cadence       = max_spm
    if avg_hr:
        sess.avg_heart_rate = int(avg_hr)
    if max_hr:
        sess.max_heart_rate = int(max_hr)
    sess.sport             = Sport.ROWING
    sess.sub_sport         = SubSport.INDOOR_ROWING
    sess.event             = Event.SESSION
    sess.event_type        = EventType.STOP
    builder.add(sess)

    act = ActivityMessage()
    act.timestamp          = end_ms
    act.total_timer_time   = duration
    act.num_sessions       = 1
    act.type               = Activity.MANUAL
    act.event              = Event.ACTIVITY
    act.event_type         = EventType.STOP
    builder.add(act)

    return builder.build().to_bytes()


@app.get("/api/export/csv")
async def api_export_csv(ids: str | None = None):
    session_ids = _export_session_ids(ids)
    cols = [
        "id", "workout_name", "started_at", "ended_at", "duration_s",
        "total_distance", "avg_power", "max_power", "avg_spm", "max_spm",
        "avg_pace", "best_pace", "avg_hr", "max_hr",
        "total_kcal", "bmr_kcal", "exercise_kcal",
        "completed", "user_id",
    ]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    writer.writeheader()
    with _db_lock:
        rows = db().execute(
            f"SELECT {','.join(cols)} FROM sessions "
            f"WHERE id IN ({','.join('?' * len(session_ids))})"
            " ORDER BY started_at DESC",
            session_ids,
        ).fetchall() if session_ids else []
    for row in rows:
        d = dict(zip(cols, row))
        for k, v in d.items():
            if isinstance(v, datetime):
                d[k] = _fmt_dt(v)
        writer.writerow(d)
    content = buf.getvalue().encode("utf-8-sig")  # BOM so Excel opens it correctly
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="woodrower_sessions.csv"'},
    )


@app.get("/api/export/json")
async def api_export_json(ids: str | None = None):
    session_ids = _export_session_ids(ids)
    sessions = _sessions_for_export(session_ids)

    def _serialise(obj: Any) -> Any:
        if isinstance(obj, datetime):
            return _fmt_dt(obj)
        raise TypeError(f"not serializable: {type(obj)}")

    content = json.dumps({"sessions": sessions}, default=_serialise, indent=2).encode()
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="woodrower_sessions.json"'},
    )


@app.get("/api/export/tcx")
async def api_export_tcx(ids: str | None = None):
    session_ids = _export_session_ids(ids)
    sessions = _sessions_for_export(session_ids)

    if len(sessions) == 1:
        s = sessions[0]
        fname = f"session_{s['id']}_{_fmt_dt(s.get('started_at'))[:10]}.tcx"
        return Response(
            content=_session_to_tcx(s).encode(),
            media_type="application/xml",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for s in sessions:
            fname = f"session_{s['id']}_{_fmt_dt(s.get('started_at'))[:10]}.tcx"
            zf.writestr(fname, _session_to_tcx(s).encode())
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="woodrower_sessions_tcx.zip"'},
    )


@app.get("/api/export/fit")
async def api_export_fit(ids: str | None = None):
    session_ids = _export_session_ids(ids)
    sessions = _sessions_for_export(session_ids)

    if len(sessions) == 1:
        s = sessions[0]
        fname = f"session_{s['id']}_{_fmt_dt(s.get('started_at'))[:10]}.fit"
        return Response(
            content=_session_to_fit_bytes(s),
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for s in sessions:
            fname = f"session_{s['id']}_{_fmt_dt(s.get('started_at'))[:10]}.fit"
            zf.writestr(fname, _session_to_fit_bytes(s))
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="woodrower_sessions_fit.zip"'},
    )


# ----- BLE device config -----

@app.get("/api/ble/config")
async def api_ble_config_get():
    cfg = load_config()
    return {
        "address":   cfg.get("ble_address"),
        "connected": rower.connected,
        "sim":       SIM_MODE or not BLEAK_AVAILABLE,
    }


@app.put("/api/ble/config")
async def api_ble_config_set(body: dict[str, Any]):
    address = body.get("address")
    if address is not None and not isinstance(address, str):
        raise HTTPException(400, "address must be a string or null")
    save_config({"ble_address": address.strip() if address else None})
    return {"ok": True}


@app.post("/api/ble/connect")
async def api_ble_connect():
    """Signal the BLE task to (re)connect. Idempotent — safe to call if already connected."""
    if _ble_connect_event is not None:
        _ble_connect_event.set()
    return {"ok": True, "connected": rower.connected}


@app.post("/api/ble/disconnect")
async def api_ble_disconnect():
    """Stop retrying BLE connection and disconnect if currently connected."""
    if _ble_connect_event is not None:
        _ble_connect_event.clear()
    if rower.client is not None:
        try:
            await rower.client.disconnect()
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True}


@app.post("/api/ble/scan")
async def api_ble_scan():
    """Scan 10 s for FTMS devices. For admin setup only — not used during training."""
    if not BLEAK_AVAILABLE:
        raise HTTPException(503, "Bluetooth not available (bleak not installed)")
    if SIM_MODE:
        return [{"address": "SIM:00:00:00:00:00", "name": "Simulation"}]
    try:
        devices = await BleakScanner.discover(timeout=10.0, return_adv=True)
    except Exception as e:               # noqa: BLE001
        raise HTTPException(503, f"scan failed: {e}")
    result = []
    for dev, adv in devices.values():
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        if FTMS_SERVICE_UUID.lower() in uuids:
            result.append({"address": dev.address, "name": dev.name or ""})
    return result


# ----- websocket -----

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    import webbrowser
    # Default bind is loopback only (see HOST definition above). Override
    # with WOODROWER_HOST=0.0.0.0 to expose the UI on the LAN — bear in
    # mind there is no authentication.
    url = f"http://{'localhost' if HOST in ('127.0.0.1', '::1') else HOST}:{PORT}"
    log.info(
        "starting on %s %s", url,
        "(localhost only)" if HOST in ("127.0.0.1", "localhost", "::1")
        else "(EXPOSED on the network — no auth!)"
    )
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
