"""ProxChat agent — run this on each player's machine.

    python main.py

Then open the printed URL (http://127.0.0.1:3000) in your browser. The
browser page handles the microphone and voice (WebRTC); this agent handles
game data (Live Client API) and minimap vision, and streams both to the
page over a local WebSocket.
"""

import asyncio
import json
import sys
import threading
import time
import webbrowser
from pathlib import Path

from aiohttp import web, WSMsgType

import config
import ddragon
import liveclient
from minimap import MinimapReader

if getattr(sys, "frozen", False):
    WEB_DIR = Path(sys._MEIPASS) / "web"   # bundled into the exe
else:
    WEB_DIR = Path(__file__).parent / "web"


class AgentState:
    """Shared game state, updated by background loops, pushed to the page."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.in_game = False
        self.self_riot_id: str | None = None
        self.players: list[dict] = []           # normalized playerlist
        self.reader = MinimapReader(cfg)
        self._templates_for: frozenset[str] | None = None
        self._building = False

    def snapshot(self) -> dict:
        with self.lock:
            positions = self.reader.fresh_positions()
            players = []
            for p in self.players:
                pos = positions.get(p["championName"])
                players.append({**p, "pos": pos})
            return {
                "type": "state",
                "inGame": self.in_game,
                "selfRiotId": self.self_riot_id,
                "cvReady": self.reader.ready,
                "players": players,
                "maxUnits": self.cfg["map_units"],
                "ts": time.time(),
            }

    # -- background loops (run in threads; cv2/mss/requests are blocking) --
    def poll_loop(self):
        interval = 1.0 / self.cfg["poll_hz"]
        while True:
            raw = liveclient.player_list()
            with self.lock:
                if raw is None:
                    if self.in_game:
                        print("[game] game ended")
                    self.in_game = False
                    self.players = []
                    self._templates_for = None
                    self.reader.positions.clear()
                else:
                    if not self.in_game:
                        print("[game] game detected")
                    self.in_game = True
                    self.players = [liveclient.normalize_player(p)
                                    for p in raw]
                    if not self.self_riot_id:
                        self.self_riot_id = liveclient.active_riot_id()
            self._ensure_templates()
            time.sleep(interval)

    def _ensure_templates(self):
        with self.lock:
            if not self.in_game or self._building:
                return
            champs = frozenset(p["championName"] for p in self.players
                               if p["championName"])
            if not champs or champs == self._templates_for:
                return
            self._building = True
        try:
            print(f"[cv] preparing templates for {len(champs)} champions...")
            templates = ddragon.build_templates(sorted(champs))
            with self.lock:
                self.reader.set_templates(templates)
                self._templates_for = champs
            print(f"[cv] templates ready ({len(templates)}/{len(champs)}), "
                  f"minimap region {self.reader.region()}")
        except Exception as e:
            print(f"[cv] template build failed: {e} (will retry)")
        finally:
            with self.lock:
                self._building = False

    def cv_loop(self):
        interval = 1.0 / self.cfg["cv_hz"]
        while True:
            if self.in_game and self.reader.ready:
                try:
                    self.reader.scan()
                except Exception as e:
                    print(f"[cv] scan error: {e}")
                time.sleep(interval)
            else:
                time.sleep(0.5)


# -- web server -------------------------------------------------------------

async def index(_request):
    return web.FileResponse(WEB_DIR / "index.html")


async def ws_handler(request):
    """Local page connects here; we push state at cv rate."""
    state: AgentState = request.app["state"]
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    request.app["sockets"].add(ws)
    print("[web] page connected")
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        request.app["sockets"].discard(ws)
        print("[web] page disconnected")
    return ws


async def state_json(request):
    return web.json_response(request.app["state"].snapshot())


async def frame_jpeg(request):
    """Latest captured minimap with detection markers (vision debug)."""
    state: AgentState = request.app["state"]
    with state.lock:
        self_champ = None
        if state.self_riot_id:
            fold = state.self_riot_id.lower()
            for p in state.players:
                if p["riotId"].lower() == fold:
                    self_champ = p["championName"]
                    break
        data = state.reader.debug_jpeg(self_champ)
    if data is None:
        return web.Response(status=404, text="no frame captured yet")
    return web.Response(body=data, content_type="image/jpeg",
                        headers={"Cache-Control": "no-store"})


async def broadcaster(app):
    state: AgentState = app["state"]
    interval = 1.0 / state.cfg["cv_hz"]
    try:
        while True:
            if app["sockets"]:
                payload = json.dumps(state.snapshot())
                for ws in list(app["sockets"]):
                    try:
                        await ws.send_str(payload)
                    except ConnectionError:
                        app["sockets"].discard(ws)
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        pass


async def on_startup(app):
    app["broadcast_task"] = asyncio.create_task(broadcaster(app))


async def on_cleanup(app):
    app["broadcast_task"].cancel()


def main():
    cfg = config.load()
    state = AgentState(cfg)

    threading.Thread(target=state.poll_loop, daemon=True,
                     name="liveclient-poll").start()
    threading.Thread(target=state.cv_loop, daemon=True,
                     name="minimap-cv").start()

    app = web.Application()
    app["state"] = state
    app["sockets"] = set()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/state", state_json)
    app.router.add_get("/frame.jpg", frame_jpeg)
    app.router.add_static("/", WEB_DIR)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    port = cfg["http_port"]
    print(f"\n  ProxChat agent running.")
    print(f"  Open  http://127.0.0.1:{port}  in your browser.\n")
    threading.Timer(
        1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    web.run_app(app, host="127.0.0.1", port=port, print=None)


if __name__ == "__main__":
    main()
