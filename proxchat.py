"""ProxChat launcher — single entry point for the exe build.

    ProxChat                       run the voice agent (default)
    ProxChat calibrate             set the minimap region (run while in game)
    ProxChat server [password]     host a signaling server on port 8080
    ProxChat server [password] [port]
"""

import os
import sys
from pathlib import Path

if not getattr(sys, "frozen", False):
    root = Path(__file__).parent
    sys.path.insert(0, str(root / "agent"))
    sys.path.insert(0, str(root / "signaling"))


def run():
    cmd = sys.argv[1].lower() if len(sys.argv) > 1 else "agent"

    if cmd == "calibrate":
        import calibrate
        calibrate.main()

    elif cmd == "server":
        # args before import: server.py reads env at module load
        if len(sys.argv) > 2:
            os.environ["ROOM_PASSWORD"] = sys.argv[2]
        if len(sys.argv) > 3:
            os.environ["PORT"] = sys.argv[3]
        import asyncio
        import server
        try:
            asyncio.run(server.main())
        except KeyboardInterrupt:
            print("bye")

    elif cmd in ("agent", ""):
        import main
        main.main()

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    run()
