"""ProxChat signaling server.

Relays WebRTC session descriptions and ICE candidates between clients in a
room. Never sees or touches audio. One person hosts this (or deploys it to
any free-tier Python host); everyone else just points their client at it.

Usage:
    ROOM_PASSWORD=somepassword python server.py          # port 8080
    PORT=9000 ROOM_PASSWORD=somepassword python server.py
"""

import asyncio
import json
import os
import secrets
import signal

import websockets

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
            await self.ws.send(json.dumps(msg))
        except websockets.ConnectionClosed:
            pass


async def broadcast(room: str, msg: dict, exclude: str | None = None):
    for client in list(ROOMS.get(room, {}).values()):
        if client.id != exclude:
            await client.send(msg)


async def handler(ws):
    client: Client | None = None
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "join" and client is None:
                if ROOM_PASSWORD and msg.get("password") != ROOM_PASSWORD:
                    await ws.send(json.dumps(
                        {"type": "error", "message": "bad password"}))
                    await ws.close()
                    return

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

    except websockets.ConnectionClosed:
        pass
    finally:
        if client is not None:
            room = ROOMS.get(client.room, {})
            room.pop(client.id, None)
            if not room:
                ROOMS.pop(client.room, None)
            await broadcast(client.room, {"type": "peer-left",
                                          "id": client.id})
            print(f"[-] {client.riot_id} ({client.id}) left '{client.room}'")


async def main():
    if not ROOM_PASSWORD:
        print("WARNING: no ROOM_PASSWORD set — anyone who finds this server "
              "can join.")
    stop = asyncio.Future()
    for sig in (getattr(signal, "SIGINT", None),):
        pass  # windows: rely on KeyboardInterrupt
    async with websockets.serve(handler, "0.0.0.0", PORT):
        print(f"ProxChat signaling listening on :{PORT}")
        await stop  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("bye")
