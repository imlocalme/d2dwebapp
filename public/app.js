const state = {
  ws: null,
  roomId: null,
  clientId: null,
  peers: new Map(),
  peerMeta: new Map(),
  localStream: null,
  dataChannels: new Map(),
  pendingFiles: new Map(),
  wsAttempt: 0,
  reconnectTimer: null,
  devices: {
    audioInputs: []
  }
};

const qs = (selector) => document.querySelector(selector);
const statusEl = qs('#status');
const roomInput = qs('#room');
const joinBtn = qs('#join');
const reconnectBtn = qs('#reconnect');
const startMediaBtn = qs('#start-media');
const stopMediaBtn = qs('#stop-media');
const audioInputSelect = qs('#audio-input');
const sendTextBtn = qs('#send-text');
const textInput = qs('#text-input');
const fileInput = qs('#file-input');
const localVideo = qs('#local-video');
const remoteGrid = qs('#remote-grid');
const logEl = qs('#log');

const log = (message) => {
  const entry = document.createElement('div');
  entry.textContent = message;
  logEl.prepend(entry);
};

const setStatus = (message, type = 'info') => {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', type === 'error');
};

const scheduleReconnect = () => {
  if (!state.roomId) return;
  const attempt = (state.wsAttempt ?? 0) + 1;
  state.wsAttempt = attempt;
  const delay = Math.min(5000, 500 + attempt * 500);
  setStatus(`Connection lost. Retrying in ${Math.round(delay / 1000)}s...`, 'error');
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => connectWebSocket(), delay);
};

const connectWebSocket = () => {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  setStatus('Connecting to signaling server...');
  if (state.ws) {
    state.ws.close();
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.ws = new WebSocket(`${protocol}://${location.host}`);
  const socket = state.ws;
  const timeout = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      setStatus('Signaling timeout. Retrying...', 'error');
      socket.close();
    }
  }, 5000);

  socket.addEventListener('open', () => {
    clearTimeout(timeout);
    state.wsAttempt = 0;
    setStatus('Connected to signaling server.');
    socket.send(JSON.stringify({ type: 'join', roomId: state.roomId }));
  });

  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'joined') {
      state.clientId = message.clientId;
      setStatus(`Joined room ${state.roomId}. Peers: ${message.peers.length - 1}`);
      for (const peerId of message.peers) {
        if (peerId !== state.clientId) {
          await createPeerConnection(peerId, true);
        }
      }
      return;
    }
    if (message.type === 'peer-joined') {
      if (message.clientId !== state.clientId) {
        await createPeerConnection(message.clientId, true);
      }
      return;
    }
    if (message.type === 'peer-left') {
      removePeer(message.clientId);
      return;
    }
    if (message.type === 'signal') {
      if (message.to && message.to !== state.clientId) return;
      await handleSignal(message.from, message.data);
    }
  });

  socket.addEventListener('error', () => {
    setStatus('Signaling error. Check server connection.', 'error');
  });

  socket.addEventListener('close', () => {
    setStatus('Disconnected from signaling server.', 'error');
    scheduleReconnect();
  });
};

const sendSignal = (to, data) => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: 'signal', from: state.clientId, to, data }));
};

const createPeerConnection = async (peerId, isInitiator) => {
  if (state.peers.has(peerId)) return;

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  state.peers.set(peerId, pc);
  const polite = state.clientId ? state.clientId > peerId : false;
  state.peerMeta.set(peerId, {
    isInitiator,
    polite,
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false
  });

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      pc.addTrack(track, state.localStream);
    }
  }

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      sendSignal(peerId, { type: 'ice', candidate: event.candidate });
    }
  });

  pc.addEventListener('track', (event) => {
    attachRemoteStream(peerId, event.streams[0]);
  });

  pc.addEventListener('datachannel', (event) => {
    setupDataChannel(peerId, event.channel);
  });

  pc.addEventListener('negotiationneeded', async () => {
    const meta = state.peerMeta.get(peerId);
    if (!meta || meta.makingOffer) return;
    try {
      meta.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(peerId, { type: 'offer', sdp: pc.localDescription });
    } finally {
      meta.makingOffer = false;
    }
  });

  if (isInitiator) {
    const channel = pc.createDataChannel('data');
    setupDataChannel(peerId, channel);
  }
};

const handleSignal = async (peerId, data) => {
  if (!state.peers.has(peerId)) {
    await createPeerConnection(peerId, false);
  }
  const pc = state.peers.get(peerId);
  const meta = state.peerMeta.get(peerId);
  if (!meta) return;
  if (data.type === 'offer') {
    const offerCollision =
      meta.makingOffer || pc.signalingState !== 'stable';
    meta.ignoreOffer = !meta.polite && offerCollision;
    if (meta.ignoreOffer) {
      return;
    }
    meta.isSettingRemoteAnswerPending = true;
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    meta.isSettingRemoteAnswerPending = false;
    sendSignal(peerId, { type: 'answer', sdp: pc.localDescription });
  } else if (data.type === 'answer') {
    meta.isSettingRemoteAnswerPending = false;
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'ice' && data.candidate) {
    try {
      if (!meta.ignoreOffer) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (error) {
      console.warn('ICE candidate error', error);
    }
  }
};

const setupDataChannel = (peerId, channel) => {
  state.dataChannels.set(peerId, channel);
  channel.binaryType = 'arraybuffer';

  channel.addEventListener('open', () => {
    log(`Data channel open with ${peerId}.`);
  });

  channel.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const payload = JSON.parse(event.data);
      if (payload.type === 'text') {
        log(`Peer ${peerId}: ${payload.text}`);
      }
      if (payload.type === 'file-meta') {
        state.pendingFiles.set(payload.id, {
          meta: payload,
          chunks: [],
          received: 0
        });
      }
      if (payload.type === 'file-complete') {
        const fileData = state.pendingFiles.get(payload.id);
        if (!fileData) return;
        const blob = new Blob(fileData.chunks, { type: fileData.meta.mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileData.meta.name;
        link.textContent = `Download ${fileData.meta.name} (${(fileData.meta.size / 1024 / 1024).toFixed(2)} MB)`;
        logEl.prepend(link);
        state.pendingFiles.delete(payload.id);
      }
      return;
    }

    const buffer = event.data;
    const idView = new DataView(buffer, 0, 4);
    const idLength = idView.getUint32(0);
    const decoder = new TextDecoder();
    const id = decoder.decode(buffer.slice(4, 4 + idLength));
    const chunk = buffer.slice(4 + idLength);
    const fileData = state.pendingFiles.get(id);
    if (!fileData) return;
    fileData.chunks.push(chunk);
    fileData.received += chunk.byteLength;
  });
};

const removePeer = (peerId) => {
  const pc = state.peers.get(peerId);
  if (pc) pc.close();
  state.peers.delete(peerId);
  state.peerMeta.delete(peerId);
  state.dataChannels.delete(peerId);
  const remoteVideo = qs(`#remote-${peerId}`);
  if (remoteVideo) remoteVideo.remove();
};

const attachRemoteStream = (peerId, stream) => {
  let video = qs(`#remote-${peerId}`);
  if (!video) {
    video = document.createElement('video');
    video.id = `remote-${peerId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.className = 'video-tile';
    remoteGrid.appendChild(video);
  }
  video.srcObject = stream;
};

const enumerateDevices = async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  state.devices.audioInputs = devices.filter((device) => device.kind === 'audioinput');
  audioInputSelect.innerHTML = '';
  state.devices.audioInputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    audioInputSelect.appendChild(option);
  });
};

const startLocalMedia = async () => {
  const audioDeviceId = audioInputSelect.value || undefined;
  state.localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true
  });
  localVideo.srcObject = state.localStream;
  for (const pc of state.peers.values()) {
    for (const track of state.localStream.getTracks()) {
      pc.addTrack(track, state.localStream);
    }
  }
  await renegotiatePeers();
  await enumerateDevices();
  setStatus('Local media started.');
};

const renegotiatePeers = async () => {
  const tasks = [];
  for (const [peerId, pc] of state.peers.entries()) {
    const meta = state.peerMeta.get(peerId);
    if (!meta || pc.signalingState !== 'stable') continue;
    tasks.push(
      (async () => {
        await pc.setLocalDescription();
        sendSignal(peerId, { type: 'offer', sdp: pc.localDescription });
      })()
    );
  }
  await Promise.all(tasks);
};

const stopLocalMedia = () => {
  if (!state.localStream) return;
  for (const track of state.localStream.getTracks()) {
    track.stop();
  }
  state.localStream = null;
  localVideo.srcObject = null;
  setStatus('Local media stopped.');
};

const sendText = () => {
  const text = textInput.value.trim();
  if (!text) return;
  log(`You: ${text}`);
  for (const channel of state.dataChannels.values()) {
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'text', text }));
    }
  }
  textInput.value = '';
};

const sendFile = async (file) => {
  if (!file) return;
  const id = crypto.randomUUID();
  const metadata = {
    type: 'file-meta',
    id,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream'
  };
  const encoder = new TextEncoder();
  const idBuffer = encoder.encode(id);
  const chunkSize = 16000;

  for (const channel of state.dataChannels.values()) {
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify(metadata));
    }
  }

  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + chunkSize);
    const arrayBuffer = await slice.arrayBuffer();
    const combined = new Uint8Array(4 + idBuffer.byteLength + arrayBuffer.byteLength);
    const view = new DataView(combined.buffer);
    view.setUint32(0, idBuffer.byteLength);
    combined.set(idBuffer, 4);
    combined.set(new Uint8Array(arrayBuffer), 4 + idBuffer.byteLength);

    for (const channel of state.dataChannels.values()) {
      if (channel.readyState === 'open') {
        channel.send(combined);
      }
    }
    offset += chunkSize;
  }

  for (const channel of state.dataChannels.values()) {
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'file-complete', id }));
    }
  }
  log(`Sent file ${file.name}.`);
};

joinBtn.addEventListener('click', () => {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    setStatus('Enter a room name.');
    return;
  }
  state.roomId = roomId;
  connectWebSocket();
});

reconnectBtn.addEventListener('click', () => {
  if (!state.roomId) {
    setStatus('Enter a room name first.', 'error');
    return;
  }
  connectWebSocket();
});

startMediaBtn.addEventListener('click', async () => {
  try {
    await startLocalMedia();
  } catch (error) {
    setStatus('Unable to access camera/microphone.');
  }
});

stopMediaBtn.addEventListener('click', () => {
  stopLocalMedia();
});

audioInputSelect.addEventListener('change', async () => {
  if (!state.localStream) return;
  await startLocalMedia();
});

sendTextBtn.addEventListener('click', () => sendText());
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sendText();
  }
});

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  await sendFile(file);
  fileInput.value = '';
});

(async () => {
  try {
    await enumerateDevices();
  } catch (error) {
    console.warn('Device enumeration failed', error);
  }
})();
