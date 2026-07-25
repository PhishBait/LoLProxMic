"""Data Dragon: champion icon fetching + minimap template preparation.

Champion display names from the Live Client API ("Wukong", "Kai'Sa",
"Renata Glasc") don't always equal Data Dragon ids ("MonkeyKing", "Kaisa",
"Renata"), so we build a name->id map from champion.json instead of guessing.

Icons are cached in agent/cache/icons/. Templates are the central crop of
the square icon (the part that survives the minimap's circular mask),
matched with TM_CCOEFF_NORMED at several scales.
"""

import json
import re
from pathlib import Path

import cv2
import numpy as np
import requests

from config import base_dir

CACHE = base_dir() / "cache"
ICONS = CACHE / "icons"
DD = "https://ddragon.leagueoflegends.com"

# Crop this central fraction of the square icon as the template. The
# minimap shows a circle with a team-colored ring over its edge, so only
# the central region is reliably visible.
TEMPLATE_CROP = 0.60


def _fold(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def latest_version() -> str:
    return requests.get(f"{DD}/api/versions.json", timeout=10).json()[0]


def name_to_id_map(version: str) -> dict[str, str]:
    """Folded display name -> ddragon id, e.g. 'wukong' -> 'MonkeyKing'."""
    cache_file = CACHE / f"champions_{version}.json"
    if cache_file.exists():
        data = json.loads(cache_file.read_text(encoding="utf-8"))
    else:
        url = f"{DD}/cdn/{version}/data/en_US/champion.json"
        data = requests.get(url, timeout=10).json()["data"]
        CACHE.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(data), encoding="utf-8")
    out = {}
    for champ_id, info in data.items():
        out[_fold(info["name"])] = champ_id
        out[_fold(champ_id)] = champ_id  # id itself also resolves
    return out


def fetch_icon(version: str, champ_id: str) -> np.ndarray | None:
    """Champion square icon as BGR, from cache or Data Dragon."""
    ICONS.mkdir(parents=True, exist_ok=True)
    path = ICONS / f"{champ_id}.png"
    if not path.exists():
        url = f"{DD}/cdn/{version}/img/champion/{champ_id}.png"
        r = requests.get(url, timeout=10)
        if r.status_code != 200:
            return None
        path.write_bytes(r.content)
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    return img


def build_templates(champion_names: list[str]) -> dict[str, np.ndarray]:
    """Map live-client champion display name -> template image (BGR).

    Templates are full-resolution central crops; minimap.py rescales them
    per minimap size.
    """
    version = latest_version()
    names = name_to_id_map(version)
    templates: dict[str, np.ndarray] = {}
    for display in champion_names:
        champ_id = names.get(_fold(display))
        if not champ_id:
            print(f"[ddragon] no id found for champion '{display}'")
            continue
        icon = fetch_icon(version, champ_id)
        if icon is None:
            print(f"[ddragon] failed to fetch icon for {champ_id}")
            continue
        h, w = icon.shape[:2]
        m = int(min(h, w) * (1 - TEMPLATE_CROP) / 2)
        templates[display] = icon[m:h - m, m:w - m]
    return templates
