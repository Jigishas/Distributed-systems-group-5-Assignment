'use strict';

/**
 * Chat Client
 * ---------------------------------------------------------------
 * A simple command-line chat client that connects to a distributed
 * chat server via socket.io (WebSocket).
 *
 * Features:
 *   - Connect to a server node (primary or replica)
 *   - Send chat messages to all other connected clients
 *   - Receive and display broadcast messages in real time
 *   - Auto-reconnect / failover to another server node if the
 *     current connection drops
 *   - Replay persisted message history on reconnect
 *
 * Usage (run from the project root):
 *   node client/client.js                          # default server (port 4000)
 *   node client/client.js --url http://127.0.0.1:4001  # connect to replica
 *   node client/client.js --name Alice              # set your display name
 *
 * Commands at the prompt:
 *   <type and press Enter>   send a chat message
 *   /quit                    exit the client
 */

const io = require('socket.io-client');
const readline = require('readline');

// ---------------------------------------------------------------------------
// CLI / configuration
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let serverUrl = 'http://127.0.0.1:4000';
let clientName = 'Anonymous';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) {
    serverUrl = args[i + 1];
    i += 1;
  } else if (args[i] === '--name' && args[i + 1]) {
    clientName = args[i + 1];
    i += 1;
  }
}

// List of known server nodes for failover (order = priority).
const KNOWN_SERVERS = [
  'http://127.0.0.1:4000', // primary
  'http://127.0.0.1:4001', // replica
];

let currentUrlIndex = KNOWN_SERVERS.indexOf(serverUrl);
if (currentUrlIndex === -1) {
  currentUrlIndex = 0;
}

let socket = null;
let isConnected = false;
let reconnectTimer = null;
const RECONNECT_DELAY_MS = 3000;

// ---------------------------------------------------------------------------
// Readline interface (stdin / stdout)
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${clientName}> `,
});

function log(message) {
  process.stdout.write(`\r${message}\n${clientName}> `);

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function connect(url) {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  serverUrl = url;
  isConnected = false;

  console.log(`\n[client] connecting to ${serverUrl}...`);
  socket = io(url, { transports: ['websocket'], reconnection: false });

  socket.on('connect', () => {
    isConnected = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log(`[client] connected to ${serverUrl}`);
    socket.emit('identify', clientName);
    rl.prompt();
  });

  socket.on('connect_error', (err) => {
    console.log(`[client] connection error: ${err.message}`);
    scheduleReconnect();
  });

  socket.on('disconnect', (reason) => {
    isConnected = false;
    console.log(`\n[client] disconnected from ${serverUrl} (${reason})`);
    scheduleReconnect();
  });

  socket.on('server:join', (payload) => {
    console.log(`\n[server] ${payload.name} joined (${payload.serverId}), ${payload.serverCount} node(s) known`);
    rl.prompt();
  });

  socket.on('history', (payload) => {
    const messages = payload.messages || [];
    if (messages.length > 0) {
      console.log(`\n[history] ${messages.length} message(s) from server log:`);
      messages.forEach((m) => {
        console.log(`  [${m.timestamp.slice(11, 19)}] ${m.sender || 'unknown'}: ${m.text}`);
      });
    }
    rl.prompt();
  });

  socket.on('chat:message', (message) => {
    const time = message.timestamp.slice(11, 19);
    const sender = message.sender || 'unknown';
    console.log(`\n[${time}] ${sender}: ${message.text}`);
    rl.prompt();
  });

  socket.on('error', (err) => {
    console.log(`\n[client] socket error: ${err.message}`);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const nextIndex = (currentUrlIndex + 1) % KNOWN_SERVERS.length;
  currentUrlIndex = nextIndex;
  const nextUrl = KNOWN_SERVERS[nextIndex];
  console.log(`[client] will retry ${nextUrl} in ${RECONNECT_DELAY_MS / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(nextUrl);
  }, RECONNECT_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Stdin handler
// ---------------------------------------------------------------------------

rl.on('line', (line) => {
  const input = line.trim();

  if (input === '/quit' || input === '/exit') {
    console.log('[client] goodbye!');
    if (socket) socket.disconnect();
    rl.close();
    process.exit(0);
    return;
  }

  if (!isConnected || !socket) {
    console.log('[client] not connected to a server. Waiting for reconnection...');
    rl.prompt();
    return;
  }

  if (input.length > 0) {
    socket.emit('chat:message', { text: input, sender: clientName });
  }

  rl.prompt();
});

rl.on('close', () => {
  if (socket) socket.disconnect();
  process.exit(0);
});

printWelcome();
connect(serverUrl);

  rl.prompt(true);
}

function printWelcome() {
  console.log('========================================');
  console.log('  Distributed Chat Client');
  console.log(`  Server: ${serverUrl}`);
  console.log(`  Name:   ${clientName}`);
  console.log('  Type a message and press Enter to send.');
  console.log("  Type '/quit' to exit.");
  console.log('========================================\n');
}

