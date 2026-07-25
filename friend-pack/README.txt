PROXCHAT — proximity voice for our customs
===========================================

Voices get louder/quieter based on how close you are in game.

SETUP (once)
------------
1. Put ProxChat.exe in any folder you like.
   Windows may warn "unrecognized app" — More info -> Run anyway.
   (It's unsigned, not malware. Source: github.com/PhishBait/LoLProxMic)

2. In League settings: set Window Mode to BORDERLESS.
   (Fullscreen breaks it — the app reads your minimap off the screen.)

3. Calibrate (once, takes 30 seconds):
   - Get into any game (Practice Tool is fine), minimap visible
   - Open the folder with ProxChat.exe, click the address bar,
     type  cmd  and press Enter
   - In the black window type:  ProxChat calibrate
   - Drag a box tight around the minimap, press ENTER

EVERY SESSION
-------------
1. Double-click ProxChat.exe — a browser page opens
2. Enter (it remembers after the first time):

     Server URL:  wss://proxchat.onrender.com
     Room:        customs
     Password:    isaacsababybitchboy

3. Click Connect, allow the microphone
4. Play. Full volume in lobby; in game, voices fade with distance.

SETTINGS (in the page, they save automatically)
-----------------------------------------------
- Voices carry about one screen. This is fixed and the same for
  everyone, so hearing is always fair both ways.
- Dead players: "silenced until respawn" or "can still talk" - pick
  as a group so it's fair
- Who can hear you: everyone close enough, or teammates only
- The % next to each name = how loud they are to you right now.
  A checkmark means their app is reporting their position directly.

NOTES
-----
- First person to connect each night may wait ~60s (server waking up)
- Keep the ProxChat browser tab open while playing
