"""Minimap region calibration.

Run this WHILE IN A GAME (practice tool works great):

    python calibrate.py

It grabs a full screenshot, opens a window, and lets you drag a box around
the minimap. Press ENTER/SPACE to confirm, C to cancel. The region is saved
to config.json and used by the agent from then on.
"""

import cv2
import mss
import numpy as np

import config


def main():
    with mss.mss() as sct:
        mon = sct.monitors[1]
        shot = sct.grab(mon)
    frame = np.ascontiguousarray(np.asarray(shot)[:, :, :3])

    # Show a scaled-down preview so the whole screenshot fits on screen —
    # at 1:1 the bottom (where the minimap lives!) hides behind the taskbar.
    fh, fw = frame.shape[:2]
    scale = min(0.85 * mon["height"] / fh, 0.95 * mon["width"] / fw, 1.0)
    preview = cv2.resize(frame, (int(fw * scale), int(fh * scale)),
                         interpolation=cv2.INTER_AREA)

    print("Drag a box around the minimap, then press ENTER or SPACE.")
    print("(Press C to cancel.)")
    win = "Select minimap - ENTER to confirm"
    r = cv2.selectROI(win, preview, showCrosshair=True)
    cv2.destroyAllWindows()

    x, y, w, h = (int(v / scale) for v in r)
    if w < 40 or h < 40:
        print("Selection too small (or cancelled); nothing saved.")
        return

    cfg = config.load()
    cfg["minimap_region"] = [x + mon["left"], y + mon["top"], w, h]
    config.save(cfg)
    print(f"Saved minimap region {cfg['minimap_region']} to config.json")


if __name__ == "__main__":
    main()
