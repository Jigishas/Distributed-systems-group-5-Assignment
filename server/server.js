'use strict';

/**
 * Server Node
 * ---------------------------------------------------------------
 * A single chat server node in the distributed chat system.
 *
 * Each server:
 *   1. Registers itself with the cluster registry.
 *   2. Creates a socket.io (WebSocket) server on an HTTP port.
 *   3. Accepts multiple client connections concurrently using the
 *      asynchronous I/O provided by socket.io + Node's event loop.
 *   4. Broadcasts every received message to ALL other connected clients.
 *   5. Runs a background heart-beat + health endpoint so failures can be
 *      detected and used for failover.
 *   6. Persists every broadcast to the message log.
 */

const http = require('http');
const express = require('express');
const path = require('path');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

const PORT = Number(process.env.PORT || (process.argv.includes('--replica') ? 4001 : 4000));
const IS_REPLICA = process.argv.includes('--replica');
const SERVER_ID = process.env.SERVER_ID || (IS_REPLICA ? 'server-2' : 'server-1');
const SERVER_NAME = process.env.SERVER_NAME || (IS_REPLICA ? 'Replica Server' : 'Primary Server');
const CLUSTER_TOKEN = process.env.CLUSTER_TOKEN || 'development-cluster-token';
const DEFAULT_PEER = IS_REPLICA ? 'http://127.0.0.1:4000' : 'http://127.0.0.1:4001';
const PEER_URLS = (process.env.PEER_URLS || DEFAULT_PEER)
  .split(',')
  .map((url) => url.trim().replace(/\/+$/, ''))
  .filter((url) => url && url !== `http://127.0.0.1:${PORT}`);

const { register, unregister } = require('./registry');
const { append } = require('./store');

const app = express();
const serverHttp = http.createServer(app);
const io = new Server(serverHttp, { cors: { origin: '*' } });
const peerSockets = new Set();
const peerClients = [];

const ADDRESS_HOST = process.env.HOST || '127.0.0.1';
const ADDRESS_PORT = PORT;

// Serve the frontend (chat UI) from the frontend directory.
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/client-config.js', (_req, res) => {
  const publicUrl = process.env.PUBLIC_URL || `http://${ADDRESS_HOST}:${ADDRESS_PORT}`;
  res.type('application/javascript').send(
    `window.CHAT_SERVERS = ${JSON.stringify([publicUrl, ...PEER_URLS])};`
  );
});

// Root route: serve the chat UI.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

function deliverToLocalClients(message, excludedSocketId) {
  for (const [id, client] of clients) {
    if (id !== excludedSocketId) client.emit('chat:message', message);
  }
}

// ---------------------------------------------------------------------------
// Heart-beat / health
// ---------------------------------------------------------------------------


const healthState = {
  healthy: true,
  lastSeen: Date.now(),
  reports: 0,
};

function heartbeat() {
  healthState.lastSeen = Date.now();
  healthState.reports += 1;
}

function isHealthy() {
  return healthState.healthy && (Date.now() - healthState.lastSeen) < 5000;
}

// Every server exposes a self-check endpoint clients / the registry can hit.
app.get('/health', (req, res) => {
  const ok = isHealthy();
  res.json({
    serverId: SERVER_ID,
    name: SERVER_NAME,
    isPrimary: !IS_REPLICA,
    replica: IS_REPLICA,
    healthy: ok,
    uptimeSeconds: Math.floor(process.uptime()),
    heartbeatReports: healthState.reports,
    connectedPeers: peerSockets.size,
    address: `${ADDRESS_HOST}:${ADDRESS_PORT}`,
  });
});

// Cluster discovery: fetch the registry list.
app.get('/servers', (req, res) => {
  const fromRegistry = [...require('./registry').getAllServers()];
  res.json({
    serverId: SERVER_ID,
    isPrimary: !IS_REPLICA,
    replica: IS_REPLICA,
    servers: fromRegistry,
    timestamp: new Date().toISOString(),
  });
});

const heartbeatTimer = setInterval(heartbeat, 1000);
heartbeatTimer.unref();

// ---------------------------------------------------------------------------
// Socket.io connection handling
// ---------------------------------------------------------------------------

const clients = new Map(); // socket.id -> socket

io.use((socket, next) => {
  if (socket.handshake.auth.role === 'peer' && socket.handshake.auth.token !== CLUSTER_TOKEN) {
    next(new Error('Unauthorized cluster peer'));
    return;
  }
  next();
});

io.on('connection', (socket) => {
  if (socket.handshake.auth.role === 'peer') {
    peerSockets.add(socket);
    socket.on('cluster:message', (message) => {
      append(message);
      deliverToLocalClients(message);
    });
    socket.on('disconnect', () => peerSockets.delete(socket));
    log(`cluster peer connected to ${SERVER_ID}`);
    return;
  }

  // Identify the client when they arrive.
  socket.on('identify', (clientName) => {
    if (typeof clientName !== 'string' || !clientName.trim() || clientName.length > 30) {
      socket.emit('chat:error', { message: 'Name must be between 1 and 30 characters.' });
      return;
    }
    const id = socket.id;
    socket.data.clientName = clientName.trim();
    clients.set(id, socket);

    socket.emit('server:join', {
      type: 'joined',
      serverId: SERVER_ID,
      name: socket.data.clientName,
      replica: IS_REPLICA,
      timestamp: new Date().toISOString(),
      serverCount: require('./registry').getServerCount() + peerSockets.size,
    });

    // Fetch persisted history so the client can replay messages after
    // reconnecting on another server node.
    const history = require('./store').readAll();
    socket.emit('history', { messages: history });

    log(`client "${clientName}" (${id}) connected to ${SERVER_ID} (total clients: ${clients.size})`);
  });

  // Broadcast: forward any chat message to all other connected clients.
  socket.on('chat:message', (payload) => {
    if (!clients.has(socket.id) || !payload || typeof payload.text !== 'string') {
      socket.emit('chat:error', { message: 'Connect with a valid name before sending a message.' });
      return;
    }
    const text = payload.text.trim();
    if (!text || text.length > 2000) {
      socket.emit('chat:error', { message: 'Messages must be between 1 and 2000 characters.' });
      return;
    }

    const senderId = socket.id;
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId,
      serverId: SERVER_ID,
      timestamp: new Date().toISOString(),
      sender: socket.data.clientName,
      text,
    };

    // Persist locally and replicate to connected nodes before delivery.
    append(message);
    deliverToLocalClients(message, senderId);
    for (const peer of peerClients) peer.emit('cluster:message', message);
    log(`broadcast to ${clients.size - 1} local clients and ${peerClients.length} peer(s) on ${SERVER_ID}`);
  });

  // Client wants to leave.
  socket.on('disconnect', () => {
    clients.delete(socket.id);
    log(`client disconnected from ${SERVER_ID} (remaining clients: ${clients.size})`);
  });
});

// ---------------------------------------------------------------------------
// Shutdown handling
// ---------------------------------------------------------------------------

process.on('SIGINT', () => {
  log('received SIGINT, shutting down...');
  for (const peer of peerClients) peer.disconnect();
  clearInterval(heartbeatTimer);
  require('./store').close();
  unregister(SERVER_ID);
  serverHttp.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  log('received SIGTERM, shutting down...');
  for (const peer of peerClients) peer.disconnect();
  clearInterval(heartbeatTimer);
  require('./store').close();
  unregister(SERVER_ID);
  serverHttp.close(() => process.exit(0));
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function connectToPeers() {
  for (const url of PEER_URLS) {
    const peer = ioClient(url, {
      auth: { role: 'peer', token: CLUSTER_TOKEN },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    peer.on('connect', () => log(`connected to cluster peer ${url}`));
    peer.on('connect_error', (error) => log(`cluster peer ${url} unavailable: ${error.message}`));
    peerClients.push(peer);
  }
}

serverHttp.listen(PORT, ADDRESS_HOST, () => {
  register(SERVER_ID, {
    name: SERVER_NAME,
    host: ADDRESS_HOST,
    port: ADDRESS_PORT,
    isPrimary: !IS_REPLICA,
    healthUrl: `http://${ADDRESS_HOST}:${ADDRESS_PORT}/health`,
  });

  log(
    `server node "${SERVER_NAME}" (${SERVER_ID}) listening on http://${ADDRESS_HOST}:${ADDRESS_PORT}` +
      ` (${IS_REPLICA ? 'replica' : 'primary'})`
  );
  log(`health at http://${ADDRESS_HOST}:${ADDRESS_PORT}/health`);
  log(`discover peers at http://${ADDRESS_HOST}:${ADDRESS_PORT}/servers`);
  connectToPeers();
});

function log(message) {
  const now = new Date().toISOString();
  process.stdout.write(`[server:${now}] ${message}\n`);
}
