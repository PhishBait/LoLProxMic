/**
 * app.js — ProxChat browser client.
 *
 * Three connections:
 *   1. Local agent WebSocket (game state + minimap positions), same origin.
 *   2. Signaling server WebSocket (peer discovery + WebRTC setup relay).
 *   3. WebRTC mesh — one PeerConnection per other player, audio only.
 *
 * Every agent state tick we recompute distance -> gain/pan per peer and
 * feed Spatial (spatial.js).
 */
"use strict";

// Add a TURN server here if someone behind a strict NAT can't connect:
// { urls: "turn:your.turn.host:3478", username: "u", credential: "p" }
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// ---- state -----------------------------------------------------------------
let agentWS = null;
let sigWS = null;
let selfId = null;          // signaling id
let micStream = null;
let gameState = { inGame: false, players: [], selfRiotId: null,
                  cvReady: false, selfPos: null };
// peerId -> { pc, dc, riotId, polite, makingOffer, remote, lastNear }
const rtcPeers = new Map();

// Position reports: how we know where peers are.
// Primary: each client detects only ITSELF (never occluded on your own
// minimap) and broadcasts that over the data channel. Fallback: our own
// CV's detection of their champion (old clients / channel not open yet).
const REPORT_FRESH_MS = 3000; // peer self-report older than this: ignore
const NEAR_GRACE_MS = 8000;   // lost someone who was close: hold, don't mute

const $ = (id) => document.getElementById(id);
const settings = {
  mode: "distance",     // 'distance' | 'team'
  deathMode: "classic", // 'classic' (dead are silenced) | 'open' (dead talk)
  masterVolume: 1,
};

// ---- local agent connection ------------------------------------------------
function connectAgent() {
  agentWS = new WebSocket(`ws://${location.host}/ws`);
  agentWS.onopen = () => setChip("chip-agent", "ok", "agent");
  agentWS.onclose = () => {
    setChip("chip-agent", "bad", "agent");
    setTimeout(connectAgent, 2000);
  };
  agentWS.onmessage = (ev) => {
    gameState = JSON.parse(ev.data);
    setChip("chip-game", gameState.inGame ? "ok" : "idle",
            gameState.inGame ? (gameState.cvReady ? "in game" : "loading cv")
                             : "no game");
    if (gameState.selfRiotId && !$("riotId").value) {
      $("riotId").value = gameState.selfRiotId;
    }
    updateAllPeerAudio();
    renderPeers();
  };
}

// ---- proximity rules ---------------------------------------------------------
function findPlayer(riotId) {
  if (!riotId) return null;
  const fold = riotId.trim().toLowerCase();
  return gameState.players.find(
    (p) => p.riotId.toLowerCase() === fold) || null;
}

const clampPan = (v) => Math.max(-1, Math.min(1, v));

/** Returns {gain, pan, distance|null, reason, live} for one peer. */
function computeAudio(peer) {
  const FULL = { gain: 1, pan: 0, distance: null };
  const now = performance.now();

  if (!gameState.inGame || !gameState.cvReady) {
    return { ...FULL, reason: "lobby" };  // out-of-game: everyone full volume
  }
  const me = findPlayer($("riotId").value || gameState.selfRiotId);
  const them = findPlayer(peer.riotId);
  const remote = peer.remote && now - peer.remote.ts < REPORT_FRESH_MS
    ? peer.remote : null;
  if (remote && remote.inGame === false) {
    return { ...FULL, reason: "not in game yet" };
  }
  if (!me || (!them && !remote)) {
    return { ...FULL, reason: "not in this game" };
  }

  const theirTeam = remote?.team ?? them?.team;
  if (settings.mode === "team" && theirTeam && me.team !== theirTeam) {
    return { gain: 0, pan: 0, distance: null, reason: "enemy (team mode)" };
  }

  const themDead = remote ? remote.dead : them?.isDead;
  if (settings.deathMode === "classic") {
    // the dead hear everyone; the living don't hear the dead
    if (me.isDead) return { ...FULL, reason: "you are dead" };
    if (themDead) {
      return { gain: 0, pan: 0, distance: null, reason: "dead" };
    }
  } // 'open': death changes nothing, ghosts included

  const myPos = gameState.selfPos || me.pos;
  const theirPos = remote && remote.x != null ? remote : them?.pos;

  if (myPos && theirPos) {
    const dx = theirPos.x - myPos.x;
    const dy = theirPos.y - myPos.y;
    const d = Math.hypot(dx, dy);
    const gain = Spatial.distanceToGain(d);
    if (gain > 0.05) peer.lastNear = { d, dx, ts: now };
    return {
      gain,
      pan: clampPan(dx / Spatial.maxDistance),
      distance: d,
      reason: null,
      live: !!remote,   // position came from their own client
    };
  }

  // No position for one of us. Fail toward "together", not "fog": if they
  // were audibly close moments ago, hold that instead of going silent.
  if (peer.lastNear && now - peer.lastNear.ts < NEAR_GRACE_MS) {
    return {
      gain: Spatial.distanceToGain(peer.lastNear.d),
      pan: clampPan(peer.lastNear.dx / Spatial.maxDistance),
      distance: peer.lastNear.d,
      reason: "holding",
    };
  }
  return { gain: 0, pan: 0, distance: null, reason: "unseen" };
}

function updateAllPeerAudio() {
  for (const [peerId, peer] of rtcPeers) {
    const a = computeAudio(peer);
    peer.lastAudio = a;
    Spatial.setPeerAudio(peerId, a.gain * settings.masterVolume, a.pan);
  }
}

// Broadcast own position (from the agent's self-detection pass) to every
// peer a few times a second over the unreliable data channel.
function broadcastPos() {
  if (rtcPeers.size === 0) return;
  const me = findPlayer($("riotId").value || gameState.selfRiotId);
  const inGame = gameState.inGame && gameState.cvReady;
  const payload = JSON.stringify({
    t: "pos",
    inGame,
    x: inGame && gameState.selfPos ? gameState.selfPos.x : null,
    y: inGame && gameState.selfPos ? gameState.selfPos.y : null,
    dead: me ? me.isDead : false,
    team: me ? me.team : null,
  });
  for (const peer of rtcPeers.values()) {
    if (peer.dc?.readyState === "open") {
      try { peer.dc.send(payload); } catch {}
    }
  }
}
setInterval(broadcastPos, 250);

// ---- signaling + WebRTC mesh -------------------------------------------------
async function connect() {
  const url = $("serverUrl").value.trim();
  if (!url) return setStatus("enter a server URL");
  Spatial.ensureContext();

  try {
    micStream = micStream || await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    return setStatus("microphone permission denied");
  }

  sigWS = new WebSocket(url);
  sigWS.onopen = () => {
    sigWS.send(JSON.stringify({
      type: "join",
      room: $("room").value.trim() || "default",
      password: $("password").value,
      riotId: $("riotId").value.trim(),
    }));
  };
  sigWS.onclose = () => {
    setChip("chip-voice", "bad", "voice");
    setStatus("disconnected from signaling server");
    teardownAllPeers();
    $("connectBtn").textContent = "Connect";
  };
  sigWS.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case "joined":
        selfId = msg.id;
        setChip("chip-voice", "ok", "voice");
        setStatus(`connected — ${msg.peers.length} other(s) in room`);
        $("connectBtn").textContent = "Disconnect";
        // Existing peers: we are the newcomer, we make the offers.
        for (const p of msg.peers) await createPeer(p.id, p.riotId, true);
        break;
      case "peer-joined":
        await createPeer(msg.id, msg.riotId, false);
        break;
      case "peer-left":
        destroyPeer(msg.id);
        break;
      case "signal":
        await onSignal(msg.from, msg.data);
        break;
      case "error":
        setStatus(`server error: ${msg.message}`);
        break;
    }
    renderPeers();
  };
}

function disconnect() {
  if (sigWS) { sigWS.onclose = null; sigWS.close(); sigWS = null; }
  teardownAllPeers();
  setChip("chip-voice", "idle", "voice");
  setStatus("disconnected");
  $("connectBtn").textContent = "Connect";
  renderPeers();
}

async function createPeer(peerId, riotId, initiator) {
  destroyPeer(peerId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = {
    pc, riotId, makingOffer: false,
    polite: selfId < peerId,   // deterministic role for glare handling
    lastAudio: null,
    remote: null,              // their self-reported position
    lastNear: null,
  };
  rtcPeers.set(peerId, peer);

  // Position channel: negotiated with a fixed id so both sides create it
  // symmetrically — no offer/answer choreography needed. Unreliable +
  // unordered: a lost position report is obsolete anyway.
  const dc = pc.createDataChannel("pos",
    { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
  dc.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.t === "pos") peer.remote = { ...m, ts: performance.now() };
    } catch {}
  };
  peer.dc = dc;

  for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(peerId, { candidate });
  };
  pc.ontrack = ({ streams }) => {
    Spatial.addPeer(peerId, streams[0]);
    updateAllPeerAudio();
  };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(peerId, { description: pc.localDescription });
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) {
      Spatial.removePeer(peerId);
    }
    renderPeers();
  };
  // For the newcomer, addTrack above fires onnegotiationneeded -> offer.
  void initiator;
}

async function onSignal(fromId, data) {
  const peer = rtcPeers.get(fromId);
  if (!peer) return;
  const pc = peer.pc;
  try {
    if (data.description) {
      const collision = data.description.type === "offer" &&
        (peer.makingOffer || pc.signalingState !== "stable");
      if (collision && !peer.polite) return; // impolite: ignore their offer
      if (collision) {
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        await pc.setLocalDescription();
        sendSignal(fromId, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  } catch (e) {
    console.error("signal handling failed", e);
  }
}

function sendSignal(to, data) {
  if (sigWS?.readyState === WebSocket.OPEN) {
    sigWS.send(JSON.stringify({ type: "signal", to, data }));
  }
}

function destroyPeer(peerId) {
  const peer = rtcPeers.get(peerId);
  if (!peer) return;
  try { peer.pc.close(); } catch {}
  Spatial.removePeer(peerId);
  rtcPeers.delete(peerId);
}

function teardownAllPeers() {
  for (const id of [...rtcPeers.keys()]) destroyPeer(id);
}

// ---- UI ------------------------------------------------------------------
function setStatus(text) { $("status").textContent = text; }

function setChip(id, cls, label) {
  const el = $(id);
  el.className = `chip ${cls}`;
  el.textContent = label;
}

function fmtDistance(d) {
  if (d == null) return "—";
  return `${Math.round(d)}u`;
}

function renderPeers() {
  const list = $("peers");
  if (rtcPeers.size === 0) {
    list.innerHTML = `<div class="empty">no one else connected yet</div>`;
    return;
  }
  const rows = [];
  for (const [peerId, peer] of rtcPeers) {
    const a = peer.lastAudio || { gain: 1, distance: null, reason: "lobby" };
    const player = findPlayer(peer.riotId);
    const champ = player ? player.championName : "";
    const state = peer.pc.connectionState;
    const pct = Math.round(a.gain * 100);
    const label = a.reason ? escapeHtml(a.reason) : fmtDistance(a.distance);
    const src = a.live ? " ✓" : "";  // ✓ = position self-reported by them
    rows.push(`
      <div class="peer" data-peer="${peerId}">
        <div class="peer-head">
          <span class="speak" id="speak-${peerId}"></span>
          <span class="peer-name">${escapeHtml(peer.riotId || "?")}</span>
          <span class="peer-champ">${escapeHtml(champ)}</span>
          <span class="peer-dist">${label}${src} · ${pct}%</span>
        </div>
        <div class="vol"><div class="vol-fill" style="width:${pct}%"></div></div>
        ${state !== "connected"
          ? `<div class="peer-conn">${state}…</div>` : ""}
      </div>`);
  }
  list.innerHTML = rows.join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
              '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- vision debug ----------------------------------------------------------
function refreshVision() {
  const panel = $("vision");
  const img = $("visionImg");
  const info = $("visionInfo");
  if (!panel.open) return;
  if (!gameState.inGame) {
    info.textContent = "waiting for a game…";
    return;
  }
  if (!gameState.cvReady) {
    info.textContent = "game found — preparing champion templates…";
    return;
  }
  if (gameState.minimapVisible === false) {
    info.textContent =
      "minimap not visible (game covered/minimized?) — positions frozen";
    return;
  }
  const detected = gameState.players.filter((p) => p.pos);
  info.textContent =
    `tracking ${detected.length}/${gameState.players.length} champions` +
    (detected.length
      ? ` — ${detected.map((p) => p.championName).join(", ")}` : "");
  const probe = new Image();
  probe.onload = () => { img.src = probe.src; };
  probe.src = `/frame.jpg?t=${Date.now()}`;
}
setInterval(refreshVision, 500);

// speaking indicator pulse
setInterval(() => {
  for (const peerId of rtcPeers.keys()) {
    const el = $(`speak-${peerId}`);
    if (el) el.classList.toggle("on", Spatial.peerLevel(peerId) > 0.06);
  }
}, 150);

// ---- wire up ---------------------------------------------------------------
function describeReach(units) {
  if (units <= 1100) return "whisper — practically touching";
  if (units <= 2300) return "≈ one screen away";
  if (units <= 3800) return "a couple of screens";
  return "half the map — hard to escape";
}

function applyReach(units) {
  Spatial.maxDistance = units;
  $("maxDistVal").textContent = units;
  $("reachDesc").textContent = describeReach(units);
  updateAllPeerAudio();
}

function saveTuning() {
  localStorage.setItem("proxchat.tuning", JSON.stringify({
    mode: settings.mode,
    deathMode: settings.deathMode,
    masterVol: Math.round(settings.masterVolume * 100),
    maxDist: Spatial.maxDistance,
  }));
}

window.addEventListener("DOMContentLoaded", () => {
  connectAgent();

  // restore saved fields
  for (const f of ["serverUrl", "room", "password", "riotId"]) {
    $(f).value = localStorage.getItem(`proxchat.${f}`) || "";
    $(f).addEventListener("change",
      () => localStorage.setItem(`proxchat.${f}`, $(f).value));
  }

  // restore tuning
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("proxchat.tuning")) || {};
  } catch {}
  settings.mode = saved.mode || "distance";
  settings.deathMode = saved.deathMode || "classic";
  settings.masterVolume = (saved.masterVol ?? 100) / 100;
  $("mode").value = settings.mode;
  $("deathMode").value = settings.deathMode;
  $("masterVol").value = saved.masterVol ?? 100;
  $("masterVolVal").textContent = `${saved.masterVol ?? 100}%`;
  $("maxDist").value = saved.maxDist ?? 1800;
  applyReach(saved.maxDist ?? 1800);

  $("connectBtn").addEventListener("click", () => {
    if (sigWS && sigWS.readyState === WebSocket.OPEN) disconnect();
    else connect();
  });

  $("mode").addEventListener("change", (e) => {
    settings.mode = e.target.value;
    saveTuning();
    updateAllPeerAudio();
  });

  $("deathMode").addEventListener("change", (e) => {
    settings.deathMode = e.target.value;
    saveTuning();
    updateAllPeerAudio();
  });

  $("maxDist").addEventListener("input", (e) => {
    applyReach(Number(e.target.value));
    saveTuning();
  });

  $("masterVol").addEventListener("input", (e) => {
    settings.masterVolume = Number(e.target.value) / 100;
    $("masterVolVal").textContent = `${e.target.value}%`;
    saveTuning();
    updateAllPeerAudio();
  });
});
