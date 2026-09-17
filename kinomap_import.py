"""
Kinomap import parser.
======================
Parses workout exports downloaded from Kinomap and turns them into the
internal format used by ``server.db_import_session()``.

Kinomap exports the same workout in four parallel formats (typically
shipped together in one ZIP):

  * ``.tcx``  — Garmin Training Center XML.  Most complete: real
    per-trackpoint timestamps, total calories, speed in m/s.
  * ``.pwx``  — Peaksware XML.  Has real start time + duration + speed
    in km/h, no calories.
  * ``.csv``  — flat tabular dump.  Timestamps are *not* real
    (1970-01-01 + seconds offset).
  * ``.gpx``  — usually has a track ``<name>`` like "Kinomap - Wave 50'",
    which we use as a fallback for the workout title.

Priority for sample data: TCX > PWX > CSV.
Priority for the workout title: GPX track name > PWX title > "Kinomap-Import <date>".

Security
--------
All XML parsing goes through ``defusedxml`` rather than the stdlib's
``xml.etree.ElementTree``, which is documented as unsafe for untrusted
input (XXE, billion-laughs, quadratic-blowup attacks). ZIP entries are
also size-capped before extraction so a small "ZIP bomb" cannot OOM the
server.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# ``defusedxml`` exposes the same API as ``xml.etree.ElementTree`` but
# rejects entity expansion / external DTDs. We import the module under
# the same name (``ET``) so the rest of the file reads unchanged.
from defusedxml import ElementTree as ET

log = logging.getLogger("kinomap")


# ---------------------------------------------------------------------------
# Hard limits — caller (server.py) caps the whole upload first, but a
# malicious ZIP could still claim to contain a 50 GB CSV. These limits
# keep individual entries (and the total bundle) bounded.
# ---------------------------------------------------------------------------

MAX_ENTRY_BYTES   = 32 * 1024 * 1024     # 32 MiB per file inside a ZIP
MAX_TOTAL_BYTES   = 64 * 1024 * 1024     # 64 MiB across all extracted files
MAX_SAMPLES       = 200_000              # hard ceiling on parsed rows


# ---------------------------------------------------------------------------
# XML namespaces — Kinomap is fairly consistent, but TCX uses both an
# unprefixed default namespace and a prefixed extension namespace.
# ---------------------------------------------------------------------------

NS = {
    "tcx":  "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2",
    "tpx":  "http://www.garmin.com/xmlschemas/ActivityExtension/v2",
    "pwx":  "http://www.peaksware.com/PWX/1/0",
    "gpx":  "http://www.topografix.com/GPX/1/1",
    "gpxd": "http://www.cluetrust.com/XML/GPXDATA/1/0",
}


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------

@dataclass
class ImportResult:
    """Everything ``server.db_import_session()`` needs in one place."""
    workout_name: str
    started_at:   datetime            # UTC, real
    duration_s:   float
    samples:      list[dict[str, Any]] = field(default_factory=list)
    total_distance: int  | None = None
    total_energy:   int  | None = None
    source_format:  str  = "unknown"  # "tcx" | "pwx" | "csv"
    source_files:   list[str] = field(default_factory=list)

    @property
    def ended_at(self) -> datetime:
        return self.started_at + timedelta(seconds=self.duration_s)


# ---------------------------------------------------------------------------
# Sample-level helpers
# ---------------------------------------------------------------------------

def _pace_from_kmh(speed_kmh: float | None) -> int | None:
    """1800 / km/h gives seconds per 500 m. None / 0 → None."""
    if not speed_kmh or speed_kmh <= 0:
        return None
    return max(1, int(round(1800.0 / speed_kmh)))


def _pace_from_mps(speed_mps: float | None) -> int | None:
    """500 / (m/s) gives seconds per 500 m. None / 0 → None."""
    if not speed_mps or speed_mps <= 0:
        return None
    return max(1, int(round(500.0 / speed_mps)))


def _int_or_none(s: str | None) -> int | None:
    if s is None or s == "":
        return None
    try:
        return int(float(s))   # tolerate "42.0" style
    except ValueError:
        return None


def _float_or_none(s: str | None) -> float | None:
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_iso_z(s: str) -> datetime:
    """Kinomap timestamps end in 'Z' (UTC).  Return a tz-aware datetime."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# TCX (preferred)
# ---------------------------------------------------------------------------

def parse_tcx(xml_bytes: bytes) -> ImportResult:
    root = ET.fromstring(xml_bytes)
    activity = root.find(".//tcx:Activity", NS)
    if activity is None:
        raise ValueError("TCX: no <Activity> found")

    started_at = _parse_iso_z(activity.find("tcx:Id", NS).text.strip())

    # collect every Trackpoint across every Lap (Kinomap uses one lap,
    # but we don't rely on that).
    laps = activity.findall("tcx:Lap", NS)
    total_time = 0.0
    total_distance: int | None = None
    total_energy:   int | None = None
    samples: list[dict[str, Any]] = []

    for lap in laps:
        tt = _float_or_none(lap.findtext("tcx:TotalTimeSeconds", default="", namespaces=NS))
        if tt is not None:
            total_time += tt
        dm = _float_or_none(lap.findtext("tcx:DistanceMeters", default="", namespaces=NS))
        if dm is not None:
            total_distance = int(dm)        # last lap wins → fine for 1-lap files
        cal = _int_or_none(lap.findtext("tcx:Calories", default="", namespaces=NS))
        if cal is not None:
            total_energy = (total_energy or 0) + cal

        for tp in lap.findall(".//tcx:Trackpoint", NS):
            tp_time = tp.findtext("tcx:Time", default=None, namespaces=NS)
            if not tp_time:
                continue
            try:
                t_sec = (_parse_iso_z(tp_time) - started_at).total_seconds()
            except (ValueError, TypeError):
                continue
            if t_sec < 0:
                continue

            dist = _int_or_none(tp.findtext("tcx:DistanceMeters", default="", namespaces=NS))
            cad  = _int_or_none(tp.findtext("tcx:Cadence",        default="", namespaces=NS))
            # extensions: <Extensions><ns3:TPX><ns3:Speed/><ns3:Watts/>
            tpx  = tp.find(".//tpx:TPX", NS)
            speed_mps = None
            watts     = None
            if tpx is not None:
                speed_mps = _float_or_none(tpx.findtext("tpx:Speed", default="", namespaces=NS))
                watts     = _int_or_none(  tpx.findtext("tpx:Watts", default="", namespaces=NS))

            samples.append({
                "t_sec":    t_sec,
                "power":    watts,
                "spm":      float(cad) if cad is not None else None,
                "pace":     _pace_from_mps(speed_mps),
                "distance": dist,
                "hr":       None,
                "energy":   None,
            })

    if not samples:
        raise ValueError("TCX: no trackpoints found")

    if not total_time:
        total_time = samples[-1]["t_sec"]
    if total_distance is None and samples:
        total_distance = max((s["distance"] or 0) for s in samples)

    return ImportResult(
        workout_name=    "",            # filled in by caller
        started_at=      started_at,
        duration_s=      total_time,
        samples=         samples,
        total_distance=  total_distance,
        total_energy=    total_energy,
        source_format=   "tcx",
    )


# ---------------------------------------------------------------------------
# PWX (good fallback when TCX is missing)
# ---------------------------------------------------------------------------

def parse_pwx(xml_bytes: bytes) -> ImportResult:
    root = ET.fromstring(xml_bytes)
    workout = root.find("pwx:workout", NS)
    if workout is None:
        raise ValueError("PWX: no <workout> found")

    title_raw = (workout.findtext("pwx:title", default="", namespaces=NS) or "").strip()
    time_str  = workout.findtext("pwx:time",  default="", namespaces=NS)
    if not time_str:
        raise ValueError("PWX: no <time> found")
    started_at = _parse_iso_z(time_str)

    duration_s = 0.0
    for sd in workout.findall("pwx:summarydata", NS):
        d = _float_or_none(sd.findtext("pwx:duration", default="", namespaces=NS))
        if d is not None and d > duration_s:
            duration_s = d

    samples: list[dict[str, Any]] = []
    last_dist = 0
    # <sample> elements are children of <workout>, not of the <pwx> root —
    # root.findall("pwx:sample", NS) only matches direct children of root
    # and therefore never found anything (see CONTEXT.md / bug notes).
    for sample in workout.findall("pwx:sample", NS):
        t_sec = _float_or_none(sample.findtext("pwx:timeoffset", default="", namespaces=NS))
        if t_sec is None:
            continue
        hr        = _int_or_none(  sample.findtext("pwx:hr",   default="", namespaces=NS))
        speed_kmh = _float_or_none(sample.findtext("pwx:spd",  default="", namespaces=NS))
        pwr       = _int_or_none(  sample.findtext("pwx:pwr",  default="", namespaces=NS))
        cad       = _int_or_none(  sample.findtext("pwx:cad",  default="", namespaces=NS))
        dist      = _int_or_none(  sample.findtext("pwx:dist", default="", namespaces=NS))
        if dist is not None:
            last_dist = dist
        samples.append({
            "t_sec":    t_sec,
            "power":    pwr,
            "spm":      float(cad) if cad is not None else None,
            "pace":     _pace_from_kmh(speed_kmh),
            "distance": dist,
            "hr":       hr if hr else None,    # Kinomap writes 0 instead of "no sensor"
            "energy":   None,
        })

    if not samples:
        raise ValueError("PWX: no <sample> elements found")

    if duration_s <= 0:
        duration_s = samples[-1]["t_sec"]

    return ImportResult(
        workout_name=    title_raw,     # may be "Kinomap - " (empty); caller will clean
        started_at=      started_at,
        duration_s=      duration_s,
        samples=         samples,
        total_distance=  last_dist or None,
        total_energy=    None,
        source_format=   "pwx",
    )


# ---------------------------------------------------------------------------
# CSV (last resort — has no real start time)
# ---------------------------------------------------------------------------

def parse_csv(csv_bytes: bytes, fallback_started_at: datetime) -> ImportResult:
    text = csv_bytes.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    samples: list[dict[str, Any]] = []
    last_dist = 0
    t0: float | None = None
    for row in reader:
        # row["Date"] is "1970-01-01 HH:MM:SS" — parse as relative seconds.
        date_str = (row.get("Date") or "").strip()
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        # interpret as seconds since 1970-01-01 00:00:00 = relative offset
        t_sec = (dt - datetime(1970, 1, 1)).total_seconds()
        if t0 is None:
            t0 = t_sec
        t_sec -= t0

        dist      = _int_or_none(row.get("Distance"))
        speed_kmh = _float_or_none(row.get("Speed"))
        pwr       = _int_or_none(row.get("Power"))
        cad       = _int_or_none(row.get("Cadence"))
        if dist is not None:
            last_dist = dist
        samples.append({
            "t_sec":    t_sec,
            "power":    pwr,
            "spm":      float(cad) if cad is not None else None,
            "pace":     _pace_from_kmh(speed_kmh),
            "distance": dist,
            "hr":       None,
            "energy":   None,
        })

    if not samples:
        raise ValueError("CSV: no usable rows")

    duration_s = samples[-1]["t_sec"]
    return ImportResult(
        workout_name=    "",
        started_at=      fallback_started_at,
        duration_s=      duration_s,
        samples=         samples,
        total_distance=  last_dist or None,
        total_energy=    None,
        source_format=   "csv",
    )


# ---------------------------------------------------------------------------
# GPX — only used to grab the workout name
# ---------------------------------------------------------------------------

def extract_gpx_title(xml_bytes: bytes) -> str | None:
    """Read the ``<trk><name>`` element out of a GPX file. Used purely
    for the workout title — the GPX track itself isn't a data source.
    Returns ``None`` if the file isn't well-formed (defusedxml raises
    ParseError on malicious or broken input)."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return None
    name = root.findtext(".//gpx:trk/gpx:name", default=None, namespaces=NS)
    return name.strip() if name else None


# ---------------------------------------------------------------------------
# Dispatcher: take raw bytes (file or ZIP) and return one ImportResult
# ---------------------------------------------------------------------------

_TITLE_PREFIX_RE = re.compile(r"^\s*kinomap\s*[-:]\s*", re.IGNORECASE)


def _clean_title(raw: str | None) -> str:
    """Turn 'Kinomap - Wave 50'' into 'Wave 50''.  Empty → ''."""
    if not raw:
        return ""
    cleaned = _TITLE_PREFIX_RE.sub("", raw).strip()
    return cleaned


def import_bytes(blob: bytes, filename: str = "") -> ImportResult:
    """
    Detect whether ``blob`` is a single Kinomap file or a ZIP bundle and
    return one fully-populated ``ImportResult`` ready to be stored.

    Title-resolution order:  GPX track name → PWX title → filename stem
    Data-resolution order:   TCX  →  PWX  →  CSV
    """
    files: dict[str, bytes] = {}   # extension (lowercase, w/o dot) → bytes
    source_filenames: list[str] = []

    # ZIPs start with the local-file-header magic ``PK\x03\x04``. We accept
    # the magic OR a ``.zip`` filename — Kinomap always sets the right name
    # but we don't want to trust just the suffix.
    is_zip = blob[:4] == b"PK\x03\x04" or filename.lower().endswith(".zip")
    if is_zip:
        # ZIP-bomb guard: refuse single entries above MAX_ENTRY_BYTES and
        # stop reading once the cumulative uncompressed size exceeds
        # MAX_TOTAL_BYTES. The file header's ``file_size`` is checked
        # BEFORE we actually decompress, so a 1 KB file claiming to expand
        # to 50 GB is rejected without ever allocating memory for it.
        try:
            zf = zipfile.ZipFile(io.BytesIO(blob))
        except zipfile.BadZipFile as e:
            raise ValueError(f"not a valid ZIP file: {e}")

        with zf:
            total = 0
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = Path(info.filename).name
                ext = Path(name).suffix.lower().lstrip(".")
                if ext not in ("tcx", "pwx", "csv", "gpx"):
                    continue
                if info.file_size > MAX_ENTRY_BYTES:
                    raise ValueError(
                        f"ZIP entry {name!r} too large "
                        f"({info.file_size} bytes; limit {MAX_ENTRY_BYTES})"
                    )
                total += info.file_size
                if total > MAX_TOTAL_BYTES:
                    raise ValueError(
                        f"ZIP contents exceed {MAX_TOTAL_BYTES} bytes uncompressed"
                    )
                files[ext] = zf.read(info)
                source_filenames.append(name)
    else:
        ext = Path(filename).suffix.lower().lstrip(".")
        if ext not in ("tcx", "pwx", "csv", "gpx"):
            raise ValueError(
                f"unsupported file type: {ext!r}. "
                f"Expected one of: zip, tcx, pwx, csv, gpx."
            )
        files[ext] = blob
        source_filenames.append(Path(filename).name or f"upload.{ext}")

    if not files:
        raise ValueError("no Kinomap files found in upload")

    # 1. Get the workout name (best source: GPX track name)
    title = ""
    if "gpx" in files:
        title = _clean_title(extract_gpx_title(files["gpx"]))

    # 2. Parse the actual sample data (priority: TCX > PWX > CSV)
    if "tcx" in files:
        result = parse_tcx(files["tcx"])
    elif "pwx" in files:
        result = parse_pwx(files["pwx"])
    elif "csv" in files:
        result = parse_csv(files["csv"], fallback_started_at=datetime.now(timezone.utc))
    elif "gpx" in files:
        # We don't fully parse GPX as a data source (no speed, often no HR).
        # In practice Kinomap always ships pwx + csv alongside, so this
        # branch is mostly defensive.
        raise ValueError(
            "GPX alone is not supported as a data source — "
            "please upload the original Kinomap ZIP."
        )
    else:
        raise ValueError("no parseable data file (TCX/PWX/CSV) in upload")

    if len(result.samples) > MAX_SAMPLES:
        raise ValueError(
            f"file has {len(result.samples)} samples; refuse to import more than "
            f"{MAX_SAMPLES}"
        )

    # 3. Resolve title fallbacks
    if not title and result.workout_name:
        title = _clean_title(result.workout_name)
    if not title:
        # Try PWX title even if TCX was the data source — Kinomap puts a
        # useful name there even when the TCX has none.
        if "pwx" in files and result.source_format != "pwx":
            try:
                title = _clean_title(parse_pwx(files["pwx"]).workout_name)
            except Exception:        # noqa: BLE001
                pass
    if not title:
        title = "Kinomap-Import " + result.started_at.strftime("%Y-%m-%d %H:%M")

    # Prefix "Kinomap: " unless the user (or Kinomap itself) already did.
    result.workout_name  = "Kinomap: " + title \
        if not title.lower().startswith("kinomap") else title
    result.source_files  = source_filenames

    # 4. Cross-fill missing aggregates from other formats if present.
    # PWX has no calories, but the TCX next to it usually does.
    if result.total_energy is None and "tcx" in files and result.source_format != "tcx":
        try:
            tcx_meta = parse_tcx(files["tcx"])
            result.total_energy = tcx_meta.total_energy
        except Exception as e:       # noqa: BLE001
            log.debug("could not cross-read TCX calories: %s", e)

    return result
