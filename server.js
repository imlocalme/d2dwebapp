import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const server = createServer(async (req, res) => {
  try {
    const urlPath = req.url === '/' ? '/index.html' : req.url;
    const filePath = path.join(publicDir, decodeURIComponent(urlPath));
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (error) {
    res.writeHead(404);
    res.end('Not found');
  }
});

const rooms = new Map();
const clients = new Map();

const broadcastToRoom = (roomId, senderId, payload) => {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const clientId of room.values()) {
    if (clientId !== senderId) {
      sendMessage(clientId, payload);
    }
  }
};

const sendMessage = (clientId, payload) => {
  const client = clients.get(clientId);
  if (!client) return;
  const message = JSON.stringify(payload);
  const frame = createWebSocketFrame(message);
  client.socket.write(frame);
};

const createWebSocketFrame = (message) => {
  const payload = Buffer.from(message);
  const payloadLength = payload.length;
  let header = [];
  header.push(0x81);
  if (payloadLength < 126) {
    header.push(payloadLength);
  } else if (payloadLength < 65536) {
    header.push(126, (payloadLength >> 8) & 0xff, payloadLength & 0xff);
  } else {
    header.push(
      127,
      0,
      0,
      0,
      0,
      (payloadLength >> 24) & 0xff,
      (payloadLength >> 16) & 0xff,
      (payloadLength >> 8) & 0xff,
      payloadLength & 0xff
    );
  }
  return Buffer.concat([Buffer.from(header), payload]);
};

const parseFrames = (buffer) => {
  let offset = 0;
  const messages = [];
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const isMasked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLength = buffer.readUInt32BE(offset + 6);
      headerLength = 10;
    }

    const maskOffset = offset + headerLength;
    const dataOffset = maskOffset + (isMasked ? 4 : 0);
    const frameEnd = dataOffset + payloadLength;
    if (frameEnd > buffer.length) break;

    let payload = buffer.subarray(dataOffset, frameEnd);
    if (isMasked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    if ((first & 0x0f) === 0x1) {
      messages.push(payload.toString('utf8'));
    }
    offset = frameEnd;
  }
  return { messages, remaining: buffer.subarray(offset) };
};

server.on('upgrade', (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  console.log('WebSocket upgrade request received.', req.url);
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\\r\\n')
  );

  const clientId = crypto.randomUUID();
  clients.set(clientId, { socket, buffer: Buffer.alloc(0), roomId: null });

  socket.on('data', (chunk) => {
    const client = clients.get(clientId);
    if (!client) return;
    client.buffer = Buffer.concat([client.buffer, chunk]);
    const { messages, remaining } = parseFrames(client.buffer);
    client.buffer = remaining;
    for (const raw of messages) {
      try {
        const message = JSON.parse(raw);
        if (message.type === 'join') {
          const { roomId } = message;
          if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
          }
          const room = rooms.get(roomId);
          room.add(clientId);
          client.roomId = roomId;
          sendMessage(clientId, { type: 'joined', clientId, peers: Array.from(room.values()) });
          broadcastToRoom(roomId, clientId, { type: 'peer-joined', clientId });
          continue;
        }
        if (message.type === 'signal' && client.roomId) {
          broadcastToRoom(client.roomId, clientId, message);
        }
      } catch (error) {
        console.error('Failed to parse message', error);
      }
    }
  });

  socket.on('close', () => {
    const client = clients.get(clientId);
    if (!client) return;
    const roomId = client.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.delete(clientId);
      broadcastToRoom(roomId, clientId, { type: 'peer-left', clientId });
      if (room.size === 0) rooms.delete(roomId);
    }
    clients.delete(clientId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
