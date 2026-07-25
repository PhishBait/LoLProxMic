# ProxChat — proximity voice chat for League of Legends

Companion app for custom games among friends. Voices fade in and out based
on in-game distance, spatially panned left/right.

**How it gets positions:** Riot's Live Client Data API does *not* expose map
coordinates, so ProxChat reads them from **your own minimap** with computer
vision (screen capture + template matching of champion icons). It never
injects into the game, never reads game memory, and only consumes the
official local API for player/champion/death info.

```
[ LoL game ]--(official local API :2999)--\
[ your screen ]--(minimap CV, OpenCV)------>[ Python agent ]--ws--> [ browser page ]
                                                                     |  Web Audio
[ peer 1 ] <-------------- WebRTC audio (P2P mesh) ----------------> |  gain + pan
[ peer 2 ] <-------------------------------------------------------> |
              (signaling server only relays setup, never audio)
```

## Requirements

- Windows + a browser (Chrome/Edge recommended)
- **ProxChat.exe** (see below) — or Python 3.11+ if running from source
- League running in **Borderless or Windowed** mode (screen capture can't
  see exclusive fullscreen)

## The easy way: ProxChat.exe

One exe, three modes:

```
ProxChat                    voice agent (opens the browser page for you)
ProxChat calibrate          set the minimap region (run while in a game)
ProxChat server <password>  host the signaling server (one person only)
```

Each friend just needs `ProxChat.exe` — double-click it, browser opens,
enter server/room/password, Connect. First run of a game downloads champion
icons (needs internet). `config.json` and the icon cache are created next
to the exe.

Build it yourself from source:

```sh
pip install pyinstaller -r agent/requirements.txt -r signaling/requirements.txt
pyinstaller --noconfirm --onefile --name ProxChat --paths agent --paths signaling --add-data "agent/web;web" proxchat.py
```

Result: `dist/ProxChat.exe` (~150 MB — OpenCV is most of it). Windows
SmartScreen/Defender may warn on unsigned PyInstaller exes; "More info →
Run anyway", or build `--onedir` and zip the folder instead.

## Setup (from source)

### 1. One person hosts the signaling server

```sh
cd signaling
pip install -r requirements.txt
set ROOM_PASSWORD=pick-a-shared-password && python server.py
```

(exe equivalent: `ProxChat server pick-a-shared-password`)

Listens on port 8080. To let friends reach it: port-forward 8080, use
`ngrok http 8080` (share the `wss://` URL), or deploy to any free Python
host (Fly.io / Railway / Render).

### 2. Every player runs the agent

```sh
cd agent
pip install -r requirements.txt
python main.py
```

Open http://127.0.0.1:3000 in your browser. Enter the server URL
(`ws://host:8080` or `wss://…`), room, password. Your Riot ID auto-fills
once you're in a game. Click **Connect**, allow the microphone.

### 3. Calibrate the minimap (once, per machine)

While in any game (Practice Tool is perfect):

```sh
cd agent
python calibrate.py
```

Drag a box around the minimap, press ENTER. Without calibration the agent
guesses the default bottom-right region, which usually works at default
minimap scale — but calibrating makes detection much more reliable,
especially if you've moved or resized the minimap.

## Behavior

- **Out of game / champ select:** everyone at full volume.
- **In game:** volume falls off with distance (full within ~500 units,
  silent beyond ~1800 — both tunable live in the UI). Voices pan
  left/right based on map direction.
- **Death:** dead players hear everyone; living players don't hear the dead.
- **Fog of war:** you can only "hear" players your minimap can see. Allies
  are always visible; enemies only when your team has vision. `team` mode
  sidesteps this entirely.

## Tuning

In the page: mode (distance/team), hearing range, master volume.
In code: falloff curve in `agent/web/spatial.js` (`distanceToGain`),
CV thresholds in `agent/config.py` (`match_threshold`, `icon_scale_range`).

## Known limits

- **CV accuracy:** ~4 position updates/sec from minimap icons. Overlapping
  icons in teamfights can momentarily confuse matching. Pings and minimap
  clutter can cause brief dropouts (positions go stale after 4 s and count
  as "unseen").
- **Mirror picks:** if both teams have the same champion (blind pick
  customs), CV can't tell them apart. Use draft.
- **Mesh scale:** WebRTC mesh is fine for 10; beyond that you'd want an SFU
  (LiveKit / mediasoup).
- **Strict NATs:** free STUN covers most home networks; if someone can't
  connect, add a TURN server to `ICE_SERVERS` in `agent/web/app.js`
  (e.g. [coturn](https://github.com/coturn/coturn)).
- **Exclusive fullscreen:** not capturable — use Borderless.

## Riot ToS note

ProxChat runs as a separate process, consumes only the documented local
Live Client Data API, and reads pixels from your own screen. It does not
modify the game, inject code, read game memory, or automate any input —
the categories Vanguard targets. Screen-reading tools live in a
tolerated-but-not-explicitly-blessed zone of Riot's third-party policy;
use at your own risk.
