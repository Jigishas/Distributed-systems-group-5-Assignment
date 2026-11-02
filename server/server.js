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

const { register, unregister } = require('./registry');
const { append } = require('./store');

// ---------------------------------------------------------------------------
// CLI / configuration
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || (process.argv.includes('--replica') ? 4001 : 4000);
const IS_REPLICA = process.argv.includes('--replica');
const SERVER_ID = process.env.SERVER_ID || (IS_REPLICA ? 'server-2' : 'server-1');
const SERVER_NAME = process.env.SERVER_NAME || (IS_REPLICA ? 'Replica Server' : 'Primary Server');

const app = express();
const serverHttp = http.createServer(app);
const io = new Server(serverHttp, { cors: { origin: '*' } });

const ADDRESS_HOST = process.env.HOST || '127.0.0.1';
const ADDRESS_PORT = PORT;

// Serve the frontend (chat UI) from the frontend directory.
app.use(express.static(path.join(__dirname, '../frontend')));

// Root route: serve the chat UI.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

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



// ---------------------------------------------------------------------------
// Socket.io connection handling
// ---------------------------------------------------------------------------

const clients = new Map(); // socket.id -> socket

io.on('connection', (socket) => {
  // Identify the client when they arrive.
  socket.on('identify', (clientName) => {
    const id = socket.id;
    clients.set(id, socket);

    socket.emit('server:join', {
      type: 'joined',
      serverId: SERVER_ID,
      name: clientName,
      timestamp: new Date().toISOString(),
      serverCount: require('./registry').getServerCount(),
    });

    // Fetch persisted history so the client can replay messages after
    // reconnecting on another server node.
    const history = require('./store').readAll();
    socket.emit('history', { messages: history });

    log(`client "${clientName}" (${id}) connected to ${SERVER_ID} (total clients: ${clients.size})`);
  });

  // Broadcast: forward any chat message to all other connected clients.
  socket.on('chat:message', (payload) => {
    const senderId = socket.id;
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId,
      serverId: SERVER_ID,
      timestamp: new Date().toISOString(),
      ...payload,
    };

    // Persist to disk (best-effort; a crash may lose this one message).
    append(message);

    // Fan-out to every connected client EXCEPT the sender.
    for (const [id, client] of clients) {
      if (id !== senderId) {
        client.emit('chat:message', message);
      }
    }

    log(`broadcast to ${clients.size - 1} clients on ${SERVER_ID}`);
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
  require('./store').close();
  unregister(SERVER_ID);
  serverHttp.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  log('received SIGTERM, shutting down...');
  require('./store').close();
  unregister(SERVER_ID);
  serverHttp.close(() => process.exit(0));
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

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
});

function log(message) {
  const now = new Date().toISOString();
  process.stdout.write(`[server:${now}] ${message}\n`);
}
