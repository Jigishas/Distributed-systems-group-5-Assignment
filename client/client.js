'use strict';
const io = require('socket.io-client');
const readline = require('readline');

const DEFAULT_SERVERS = ['http://127.0.0.1:4000', 'http://127.0.0.1:4001'];
const KNOWN_SERVERS = (process.env.CHAT_SERVERS || DEFAULT_SERVERS.join(','))
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// CLI / configuration
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let serverUrl = KNOWN_SERVERS[0] || DEFAULT_SERVERS[0];
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
let currentUrlIndex = KNOWN_SERVERS.indexOf(serverUrl);

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
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function connect(url) {
  const previousConnection = socket;
  socket = null;
  if (previousConnection) previousConnection.disconnect();
  serverUrl = url;
  isConnected = false;

  console.log(`\n[client] connecting to ${serverUrl}...`);
  const connection = io(url, { transports: ['websocket'], reconnection: false });
  socket = connection;

  connection.on('connect', () => {
    if (socket !== connection) return;
    isConnected = true;
    currentUrlIndex = KNOWN_SERVERS.indexOf(url);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log(`[client] connected to ${serverUrl}`);
    connection.emit('identify', clientName);
    rl.prompt();
  });

  connection.on('connect_error', (err) => {
    if (socket !== connection) return;
    console.log(`[client] connection error: ${err.message}`);
    scheduleReconnect();
  });

  connection.on('disconnect', (reason) => {
    if (socket !== connection) return;
    isConnected = false;
    console.log(`\n[client] disconnected from ${serverUrl} (${reason})`);
    scheduleReconnect();
  });

  connection.on('server:join', (payload) => {
    console.log(`\n[server] ${payload.name} joined (${payload.serverId}), ${payload.serverCount} node(s) known`);
    rl.prompt();
  });

  connection.on('history', (payload) => {
    const messages = payload.messages || [];
    if (messages.length > 0) {
      console.log(`\n[history] ${messages.length} message(s) from server log:`);
      messages.forEach((m) => {
        console.log(`  [${m.timestamp.slice(11, 19)}] ${m.sender || 'unknown'}: ${m.text}`);
      });
    }
    rl.prompt();
  });

  connection.on('chat:message', (message) => {
    const time = message.timestamp.slice(11, 19);
    const sender = message.sender || 'unknown';
    console.log(`\n[${time}] ${sender}: ${message.text}`);
    rl.prompt();
  });

  connection.on('error', (err) => {
    console.log(`\n[client] socket error: ${err.message}`);
  });

  connection.on('chat:error', (err) => {
    console.log(`\n[server] ${err.message}`);
    rl.prompt();
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
rl.prompt();

function printWelcome() {
  console.log('========================================');
  console.log('  Distributed Chat Client');
  console.log(`  Server: ${serverUrl}`);
  console.log(`  Name:   ${clientName}`);
  console.log('  Type a message and press Enter to send.');
  console.log("  Type '/quit' to exit.");
  console.log('========================================\n');
}
