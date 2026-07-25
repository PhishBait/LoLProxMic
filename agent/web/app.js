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
let gameState = { inGame: false, players: [], selfRiotId: null, cvReady: false };
// peerId -> { pc, riotId, polite, makingOffer, stream }
const rtcPeers = new Map();

const $ = (id) => document.getElementById(id);
const settings = {
  mode: "distance",   // 'distance' | 'team'
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

/** Returns {gain, pan, distance|null, reason} for one peer. */
function computeAudio(peerRiotId) {
  const FULL = { gain: 1, pan: 0, distance: null };

  if (!gameState.inGame || !gameState.cvReady) {
    return { ...FULL, reason: "lobby" };  // out-of-game: everyone full volume
  }
  const me = findPlayer($("riotId").value || gameState.selfRiotId);
  const them = findPlayer(peerRiotId);
  if (!me || !them) return { ...FULL, reason: "not in this game" };

  if (settings.mode === "team" && me.team !== them.team) {
    return { gain: 0, pan: 0, distance: null, reason: "enemy (team mode)" };
  }
  // Death rules: the dead hear everyone; the living don't hear the dead.
  if (me.isDead) return { ...FULL, reason: "you are dead" };
  if (them.isDead) {
    return { gain: 0, pan: 0, distance: null, reason: "dead" };
  }

  if (!me.pos || !them.pos) {
    // No position (fog of war / not detected yet) -> can't be "near".
    return { gain: 0, pan: 0, distance: null, reason: "unseen" };
  }
  const dx = them.pos.x - me.pos.x;
  const dy = them.pos.y - me.pos.y;
  const d = Math.hypot(dx, dy);
  return {
    gain: Spatial.distanceToGain(d),
    pan: Math.max(-1, Math.min(1, dx / Spatial.maxDistance)),
    distance: d,
    reason: null,
  };
}

function updateAllPeerAudio() {
  for (const [peerId, peer] of rtcPeers) {
    const a = computeAudio(peer.riotId);
    peer.lastAudio = a;
    Spatial.setPeerAudio(peerId, a.gain * settings.masterVolume, a.pan);
  }
}

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
  };
  rtcPeers.set(peerId, peer);

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
    rows.push(`
      <div class="peer" data-peer="${peerId}">
        <div class="peer-head">
          <span class="speak" id="speak-${peerId}"></span>
          <span class="peer-name">${escapeHtml(peer.riotId || "?")}</span>
          <span class="peer-champ">${escapeHtml(champ)}</span>
          <span class="peer-dist">${a.reason ? escapeHtml(a.reason)
                                             : fmtDistance(a.distance)}</span>
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
window.addEventListener("DOMContentLoaded", () => {
  connectAgent();

  // restore saved fields
  for (const f of ["serverUrl", "room", "password", "riotId"]) {
    $(f).value = localStorage.getItem(`proxchat.${f}`) || "";
    $(f).addEventListener("change",
      () => localStorage.setItem(`proxchat.${f}`, $(f).value));
  }

  $("connectBtn").addEventListener("click", () => {
    if (sigWS && sigWS.readyState === WebSocket.OPEN) disconnect();
    else connect();
  });

  $("mode").addEventListener("change", (e) => {
    settings.mode = e.target.value;
    updateAllPeerAudio();
  });

  $("maxDist").addEventListener("input", (e) => {
    Spatial.maxDistance = Number(e.target.value);
    $("maxDistVal").textContent = e.target.value;
    updateAllPeerAudio();
  });

  $("masterVol").addEventListener("input", (e) => {
    settings.masterVolume = Number(e.target.value) / 100;
    updateAllPeerAudio();
  });
});
