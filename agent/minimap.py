"""Minimap capture + champion detection.

Screen-reads YOUR OWN minimap (nothing is injected into or read from the
game process) and template-matches the champion icons of the 10 champs the
Live Client API says are in the game.

Coordinates come back in game units, origin bottom-left, matching Riot's
map coordinate convention: (0,0) is Blue side fountain corner.
"""

import time

import cv2
import mss
import numpy as np


class MinimapReader:
    def __init__(self, cfg: dict, screen_size: tuple[int, int] | None = None):
        self.cfg = cfg
        self._sct = None
        self._screen = screen_size
        self._scaled: dict[str, list[np.ndarray]] = {}
        self._region: tuple[int, int, int, int] | None = None
        # champion display name -> (x_units, y_units, timestamp)
        self.positions: dict[str, tuple[float, float, float]] = {}
        # debug: last captured frame + accepted detections in frame pixels
        self.last_frame: np.ndarray | None = None
        # name -> (cx, cy, size_px, score)
        self.last_detections: dict[str, tuple[int, int, int, float]] = {}
        self._scan_count = 0

    # -- region ----------------------------------------------------------
    def region(self) -> tuple[int, int, int, int]:
        if self._region:
            return self._region
        r = self.cfg.get("minimap_region")
        if r and len(r) == 4:
            self._region = tuple(int(v) for v in r)
        else:
            sw, sh = self._screen or self._detect_screen()
            size = int(sh * self.cfg["minimap_size_frac"])
            # default minimap: square, flush with the bottom-right corner
            self._region = (sw - size, sh - size, size, size)
        return self._region

    def _detect_screen(self) -> tuple[int, int]:
        with mss.mss() as sct:
            mon = sct.monitors[1]  # primary
            return mon["width"], mon["height"]

    # -- templates ---------------------------------------------------------
    def set_templates(self, templates: dict[str, np.ndarray]):
        """Rescale full-res icon crops to the sizes icons appear on this
        minimap. Done once per game."""
        _, _, w, _ = self.region()
        lo, hi = self.cfg["icon_scale_range"]
        steps = self.cfg["icon_scale_steps"]
        self._scaled = {}
        for name, tpl in templates.items():
            variants = []
            for i in range(steps):
                frac = lo + (hi - lo) * i / max(steps - 1, 1)
                px = max(int(w * frac), 8)
                variants.append(cv2.resize(tpl, (px, px),
                                           interpolation=cv2.INTER_AREA))
            self._scaled[name] = variants
        self.positions.clear()

    @property
    def ready(self) -> bool:
        return bool(self._scaled)

    # -- capture + detect --------------------------------------------------
    def _grab(self) -> np.ndarray:
        if self._sct is None:
            self._sct = mss.mss()  # one instance per thread
        left, top, w, h = self.region()
        shot = self._sct.grab({"left": left, "top": top,
                               "width": w, "height": h})
        frame = np.asarray(shot)[:, :, :3]  # BGRA -> BGR
        return np.ascontiguousarray(frame)

    def scan(self) -> dict[str, tuple[float, float, float]]:
        """One detection pass. Updates and returns self.positions.

        Each champion's best multi-scale match becomes a candidate; then a
        greedy pass (strongest score first) accepts candidates that aren't
        on top of an already-accepted spot, so one icon can't be claimed by
        two champions — the classic false-positive mode of template
        matching on the minimap.
        """
        if not self._scaled:
            return self.positions
        frame = self._grab()
        fh, fw = frame.shape[:2]
        threshold = self.cfg["match_threshold"]
        units = self.cfg["map_units"]
        now = time.time()

        # Every Nth scan, force a full-frame search for everyone. Without
        # this, a false positive self-reinforces: ROI tracking keeps
        # re-finding the same wrong spot and never looks elsewhere.
        self._scan_count += 1
        full_rescan = self._scan_count % 8 == 0

        candidates = []  # (score, name, cx, cy, size_px)
        for name, variants in self._scaled.items():
            # Tracked champions get a small ROI search around their last
            # position (icons move a few px/frame) — ~10x faster than
            # scanning the whole minimap. Full-frame is the fallback.
            roi_off = (0, 0)
            search = frame
            last = self.positions.get(name)
            if (last and not full_rescan
                    and now - last[2] < self.cfg["position_stale_secs"]):
                lx = last[0] / units * fw
                ly = (1 - last[1] / units) * fh
                pad = int(variants[-1].shape[0] * 2)
                x0 = max(0, int(lx) - pad)
                y0 = max(0, int(ly) - pad)
                search = frame[y0:min(fh, int(ly) + pad),
                               x0:min(fw, int(lx) + pad)]
                roi_off = (x0, y0)

            best = self._best_match(search, variants, threshold)
            if best is None and roi_off != (0, 0):
                best = self._best_match(frame, variants, threshold)
                roi_off = (0, 0)
            if best is not None:
                score, px, py, sz = best
                candidates.append((score, name,
                                   roi_off[0] + px + sz / 2,
                                   roi_off[1] + py + sz / 2, sz))

        candidates.sort(key=lambda c: c[0], reverse=True)
        accepted: list[tuple[float, float, float]] = []  # (cx, cy, min_sep)
        detections: dict[str, tuple[int, int, int, float]] = {}
        for score, name, cx, cy, sz in candidates:
            min_sep = sz * 0.6
            if any((cx - ax) ** 2 + (cy - ay) ** 2 < max(min_sep, asep) ** 2
                   for ax, ay, asep in accepted):
                continue  # spot already claimed by a stronger match
            accepted.append((cx, cy, min_sep))
            detections[name] = (int(cx), int(cy), sz, score)
            x_units = (cx / fw) * units
            y_units = (1 - cy / fh) * units  # screen y-down -> map y-up
            self.positions[name] = (x_units, y_units, now)
        self.last_frame = frame
        self.last_detections = detections
        return self.positions

    def debug_jpeg(self, self_champion: str | None = None) -> bytes | None:
        """Last captured minimap with detection markers, as JPEG bytes."""
        if self.last_frame is None:
            return None
        img = self.last_frame.copy()
        for name, (cx, cy, sz, score) in self.last_detections.items():
            is_self = name == self_champion
            color = (80, 220, 255) if is_self else (110, 200, 80)
            label = f"{name} {score:.2f}"
            cv2.circle(img, (cx, cy), sz // 2 + 2, color, 2)
            cv2.putText(img, label, (cx - sz // 2, cy - sz // 2 - 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 0), 3,
                        cv2.LINE_AA)
            cv2.putText(img, label, (cx - sz // 2, cy - sz // 2 - 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, color, 1,
                        cv2.LINE_AA)
        ok, buf = cv2.imencode(".jpg", img,
                               [cv2.IMWRITE_JPEG_QUALITY, 80])
        return buf.tobytes() if ok else None

    @staticmethod
    def _best_match(search: np.ndarray, variants: list[np.ndarray],
                    threshold: float):
        """Best (score, x, y, size) over all template scales, or None."""
        sh, sw = search.shape[:2]
        best_score, best_pt, best_sz = -1.0, None, 0
        for tpl in variants:
            th, tw = tpl.shape[:2]
            if th >= sh or tw >= sw:
                continue
            res = cv2.matchTemplate(search, tpl, cv2.TM_CCOEFF_NORMED)
            _, score, _, loc = cv2.minMaxLoc(res)
            if score > best_score:
                best_score, best_pt, best_sz = score, loc, tw
        if best_pt is None or best_score < threshold:
            return None
        return best_score, best_pt[0], best_pt[1], best_sz

    def fresh_positions(self) -> dict[str, dict]:
        """Positions that aren't stale, JSON-ready."""
        cutoff = time.time() - self.cfg["position_stale_secs"]
        return {
            name: {"x": x, "y": y}
            for name, (x, y, ts) in self.positions.items()
            if ts >= cutoff
        }
