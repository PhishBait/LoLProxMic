"""Config load/save for the ProxChat agent.

config.json lives next to this file. Anything missing falls back to DEFAULTS.
"""

import copy
import json
import sys
from pathlib import Path


def base_dir() -> Path:
    """Directory for persistent files (config, icon cache).

    Frozen exe: next to the .exe (portable-app style, survives restarts —
    a PyInstaller onefile's __file__ lives in a temp dir that vanishes).
    Dev: next to this file.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent


CONFIG_PATH = base_dir() / "config.json"

DEFAULTS = {
    # [left, top, width, height] in screen pixels. None = auto-guess the
    # bottom-right square (default minimap spot). Run calibrate.py to set
    # this precisely for your resolution / minimap scale.
    "minimap_region": None,
    # Fraction of screen height the minimap occupies when auto-guessing.
    "minimap_size_frac": 0.26,

    # Local web UI port (the page you open in your browser).
    "http_port": 3000,

    # CV loop rate (positions per second) and API poll rate.
    "cv_hz": 4,
    "poll_hz": 2,

    # Template matching. Icon diameter is searched as a fraction of the
    # minimap width across this range. Raise threshold if you get phantom
    # detections, lower it if champions go missing.
    "icon_scale_range": [0.06, 0.14],
    "icon_scale_steps": 9,
    "match_threshold": 0.50,

    # Summoner's Rift is ~14870 game units across. Distances below are in
    # those units (attack ranges ~500-650, flash ~400, whole lane ~13000).
    "map_units": 14870,

    # A detected position older than this many seconds counts as unknown
    # (e.g. enemy walked into fog of war).
    "position_stale_secs": 4.0,
}


def load() -> dict:
    cfg = copy.deepcopy(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError) as e:
            print(f"config.json unreadable ({e}); using defaults")
    return cfg


def save(cfg: dict):
    on_disk = {k: v for k, v in cfg.items() if DEFAULTS.get(k) != v}
    CONFIG_PATH.write_text(json.dumps(on_disk, indent=2), encoding="utf-8")
