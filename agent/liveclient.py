"""Riot Live Client Data API wrapper.

Read-only, official, local API served by the game process itself on
https://127.0.0.1:2999 with a self-signed Riot cert (hence verify=False).
Only exists while you're in an active game.
"""

import urllib3
import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE = "https://127.0.0.1:2999/liveclientdata"
TIMEOUT = 1.5

_session = requests.Session()
_session.verify = False


def _get(path: str):
    try:
        r = _session.get(f"{BASE}/{path}", timeout=TIMEOUT)
        if r.status_code == 200:
            return r.json()
    except requests.RequestException:
        pass
    return None


def player_list() -> list[dict] | None:
    """All 10 players, or None when not in game."""
    data = _get("playerlist")
    return data if isinstance(data, list) else None


def active_riot_id() -> str | None:
    """Local player's riot id ('Name#TAG'), or None when not in game."""
    data = _get("activeplayername")
    return data if isinstance(data, str) and data else None


def normalize_player(p: dict) -> dict:
    """Flatten one playerlist entry to the fields we care about."""
    riot_id = p.get("riotId") or ""
    if not riot_id:
        game_name = p.get("riotIdGameName") or p.get("summonerName") or ""
        tag = p.get("riotIdTagLine") or ""
        riot_id = f"{game_name}#{tag}" if tag else game_name
    return {
        "riotId": riot_id,
        "championName": p.get("championName") or "",
        "team": p.get("team") or "",          # ORDER / CHAOS
        "isDead": bool(p.get("isDead")),
        "respawnTimer": p.get("respawnTimer") or 0,
        "isBot": bool(p.get("isBot")),
    }
