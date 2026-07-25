"""ProxChat signaling server.

Relays WebRTC session descriptions and ICE candidates between clients in a
room. Never sees or touches audio. One person hosts this (or deploys it to
any free-tier Python host); everyone else just points their client at it.

Built on aiohttp so plain HTTP requests (health checks, browsers) get a
normal 200 while WebSocket clients get upgraded — cloud platforms need
both to work.

Usage:
    ROOM_PASSWORD=somepassword python server.py          # port 8080
    PORT=9000 ROOM_PASSWORD=somepassword python server.py
"""

import json
import os
import secrets

from aiohttp import web, WSMsgType

PORT = int(os.environ.get("PORT", "8080"))
ROOM_PASSWORD = os.environ.get("ROOM_PASSWORD", "")

# room name -> {client_id: Client}
ROOMS: dict[str, dict[str, "Client"]] = {}


class Client:
    def __init__(self, ws, client_id: str, riot_id: str, room: str):
        self.ws = ws
        self.id = client_id
        self.riot_id = riot_id
        self.room = room

    async def send(self, msg: dict):
        try:
            await self.ws.send_str(json.dumps(msg))
        except ConnectionError:
            pass


async def broadcast(room: str, msg: dict, exclude: str | None = None):
    for client in list(ROOMS.get(room, {}).values()):
        if client.id != exclude:
            await client.send(msg)


async def handle(request):
    if request.headers.get("Upgrade", "").lower() != "websocket":
        return web.Response(
            text="ProxChat signaling server. Connect with a ProxChat "
                 "client.\n")

    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    client: Client | None = None
    try:
        async for raw in ws:
            if raw.type != WSMsgType.TEXT:
                continue
            try:
                msg = json.loads(raw.data)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "join" and client is None:
                if ROOM_PASSWORD and msg.get("password") != ROOM_PASSWORD:
                    await ws.send_str(json.dumps(
                        {"type": "error", "message": "bad password"}))
                    await ws.close()
                    break

                room = str(msg.get("room") or "default")[:64]
                riot_id = str(msg.get("riotId") or "unknown")[:64]
                client = Client(ws, secrets.token_hex(4), riot_id, room)

                peers = ROOMS.setdefault(room, {})
                await client.send({
                    "type": "joined",
                    "id": client.id,
                    "peers": [{"id": p.id, "riotId": p.riot_id}
                              for p in peers.values()],
                })
                await broadcast(room, {
                    "type": "peer-joined",
                    "id": client.id,
                    "riotId": client.riot_id,
                })
                peers[client.id] = client
                print(f"[+] {client.riot_id} ({client.id}) joined "
                      f"'{room}' ({len(peers)} in room)")

            elif mtype == "signal" and client is not None:
                target = ROOMS.get(client.room, {}).get(msg.get("to"))
                if target:
                    await target.send({
                        "type": "signal",
                        "from": client.id,
                        "data": msg.get("data"),
                    })

    finally:
        if client is not None:
            room = ROOMS.get(client.room, {})
            room.pop(client.id, None)
            if not room:
                ROOMS.pop(client.room, None)
            await broadcast(client.room, {"type": "peer-left",
                                          "id": client.id})
            print(f"[-] {client.riot_id} ({client.id}) left '{client.room}'")
    return ws


def main():
    if not ROOM_PASSWORD:
        print("WARNING: no ROOM_PASSWORD set — anyone who finds this server "
              "can join.")
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handle)
    print(f"ProxChat signaling listening on :{PORT}")
    web.run_app(app, host="0.0.0.0", port=PORT, print=None)


if __name__ == "__main__":
    main()
