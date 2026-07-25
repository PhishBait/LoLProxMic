/**
 * spatial.js — Web Audio spatialization for ProxChat.
 *
 * Each peer's WebRTC audio runs through:
 *   MediaStreamSource -> StereoPanner -> Gain -> master Gain -> speakers
 *
 * Distance -> volume tuning lives here.
 */
"use strict";

const Spatial = (() => {
  // ---- tuning ------------------------------------------------------------
  // Distances are in Summoner's Rift game units.
  // Reference points: melee range ~125, most attack ranges 500-650,
  // Flash 400, one lane ~13000 end to end.
  let MAX_HEARING_DISTANCE = 1800; // beyond this: silence ("shouting range")
  // Within this: full volume. Kept proportional to the hearing range so
  // one slider controls the whole feel — a short range still has a usable
  // full-volume bubble, a long range doesn't go quiet at melee distance.
  let REF_DISTANCE = 1800 * 0.28;

  /** Quadratic falloff between REF_DISTANCE and MAX_HEARING_DISTANCE. */
  function distanceToGain(d) {
    if (d <= REF_DISTANCE) return 1;
    if (d >= MAX_HEARING_DISTANCE) return 0;
    const t = (d - REF_DISTANCE) / (MAX_HEARING_DISTANCE - REF_DISTANCE);
    return (1 - t) * (1 - t);
  }

  // ---- audio graph ---------------------------------------------------------
  let ctx = null;
  let master = null;
  const peers = new Map(); // peerId -> {source, panner, gain, analyser, audioEl}

  function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function addPeer(peerId, stream) {
    ensureContext();
    removePeer(peerId);

    // Chrome quirk: WebRTC audio only flows into Web Audio if the stream is
    // ALSO attached to a media element. Keep it muted; Web Audio does output.
    const audioEl = new Audio();
    audioEl.muted = true;
    audioEl.srcObject = stream;
    audioEl.play().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);
    const panner = ctx.createStereoPanner();
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    gain.gain.value = 1; // start at full volume (out-of-game default)
    source.connect(panner).connect(gain).connect(master);
    gain.connect(analyser);

    peers.set(peerId, { source, panner, gain, analyser, audioEl });
  }

  function removePeer(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    try { p.source.disconnect(); } catch {}
    try { p.gain.disconnect(); } catch {}
    p.audioEl.srcObject = null;
    peers.delete(peerId);
  }

  /**
   * Set a peer's target volume/pan. Smoothed to avoid zipper noise.
   * @param {string} peerId
   * @param {number} gainTarget 0..1
   * @param {number} pan -1 (left) .. 1 (right)
   */
  function setPeerAudio(peerId, gainTarget, pan) {
    const p = peers.get(peerId);
    if (!p || !ctx) return;
    const t = ctx.currentTime;
    p.gain.gain.setTargetAtTime(gainTarget, t, 0.08);
    p.panner.pan.setTargetAtTime(pan, t, 0.08);
  }

  /** Rough output level 0..1 for the speaking indicator. */
  function peerLevel(peerId) {
    const p = peers.get(peerId);
    if (!p) return 0;
    const buf = new Uint8Array(p.analyser.frequencyBinCount);
    p.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const c = (v - 128) / 128; sum += c * c; }
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }

  function setMasterVolume(v) {
    if (master) master.gain.value = v;
  }

  return {
    ensureContext, addPeer, removePeer, setPeerAudio, peerLevel,
    distanceToGain, setMasterVolume,
    get maxDistance() { return MAX_HEARING_DISTANCE; },
    set maxDistance(v) {
      MAX_HEARING_DISTANCE = v;
      REF_DISTANCE = v * 0.28;
    },
    get refDistance() { return REF_DISTANCE; },
    set refDistance(v) { REF_DISTANCE = v; },
  };
})();
