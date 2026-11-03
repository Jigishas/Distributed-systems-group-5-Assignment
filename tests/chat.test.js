'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

const { register, unregister, getAllServers, getServerCount } = require('../server/registry');
const { append, readAll, deleteLog, close } = require('../server/store');

describe('Cluster registry', () => {
  before(() => {
    const { servers } = require('../server/registry');
    servers.clear();
  });

  it('registers and retrieves a server', () => {
    register('s1', {
      name: 'Primary',
      host: '127.0.0.1',
      port: 4000,
      isPrimary: true,
      healthUrl: 'http://127.0.0.1:4000/health',
    });

    const servers = getAllServers();
    assert.strictEqual(servers.length, 1);
    assert.strictEqual(servers[0].serverId, 's1');
    assert.strictEqual(servers[0].name, 'Primary');
    assert.strictEqual(servers[0].isPrimary, true);
  });

  it('counts registered servers', () => {
    register('s2', {
      name: 'Replica',
      host: '127.0.0.1',
      port: 4001,
      isPrimary: false,
      healthUrl: 'http://127.0.0.1:4001/health',
    });

    assert.strictEqual(getServerCount(), 2);
    unregister('s1');
    assert.strictEqual(getServerCount(), 1);
    assert.deepStrictEqual(getAllServers().map((server) => server.serverId), ['s2']);
    unregister('s2');
    assert.strictEqual(getServerCount(), 0);
    assert.deepStrictEqual(getAllServers(), []);
  });
});

describe('Message store', () => {
  before(() => deleteLog());
  after(() => {
    close();
    deleteLog();
  });

  it('appends and reads messages', () => {
    const first = { id: '1', text: 'hello', sender: 'Alice', serverId: 's1', timestamp: new Date().toISOString() };
    const second = { id: '2', text: 'world', sender: 'Bob', serverId: 's2', timestamp: new Date().toISOString() };

    assert.strictEqual(append(first), true);
    assert.strictEqual(append(second), true);
    const messages = readAll();
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].text, 'hello');
    assert.strictEqual(messages[1].text, 'world');
  });

  it('deletes the log', () => {
    deleteLog();
    assert.strictEqual(readAll().length, 0);
  });
});

describe('Server health endpoint', () => {
  let serverHandle;
  let ioServer;
  let clientSocket;

  before(async () => {
    const app = require('express')();
    const server = http.createServer(app);
    ioServer = new Server(server, { cors: { origin: '*' } });
    app.get('/health', (_req, res) => {
      res.json({ serverId: 'test-node', healthy: true, isPrimary: true });
    });
    serverHandle = server.listen(4997, () => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  after(async () => {
    if (clientSocket) clientSocket.disconnect();
    if (ioServer) ioServer.close();
    if (serverHandle) serverHandle.close();
  });

  it('responds with healthy status', async () => {
    const response = await fetch('http://127.0.0.1:4997/health');
    const health = await response.json();
    assert.strictEqual(health.healthy, true);
    assert.strictEqual(health.serverId, 'test-node');
    assert.strictEqual(health.isPrimary, true);
  });

  it('socket.io accepts a client connection', async () => {
    const connected = await new Promise((resolve, reject) => {
      const socket = ioClient('http://127.0.0.1:4997', {
        transports: ['websocket'],
        timeout: 3000,
      });
      socket.on('connect', () => {
        clientSocket = socket;
        resolve(true);
      });
      socket.on('connect_error', reject);
      socket.on('error', reject);
    });
    assert.strictEqual(connected, true);
  });
});

describe('Distributed server nodes', () => {
  it('relays messages and persists history across nodes', { timeout: 30000 }, async () => {
    const port1 = await getFreePort();
    const port2 = await getFreePort();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distributed-chat-'));
    const token = 'integration-test-token';
    const url1 = `http://127.0.0.1:${port1}`;
    const url2 = `http://127.0.0.1:${port2}`;
    const server1 = startNode('integration-1', port1, url2, token, path.join(tempDir, 'node1'));
    const server2 = startNode('integration-2', port2, url1, token, path.join(tempDir, 'node2'));
    const clients = [];

    try {
      await Promise.all([waitForHealth(url1), waitForHealth(url2)]);
      await Promise.all([waitForPeer(url1), waitForPeer(url2)]);

      const alice = await connectClient(url1, 'Alice');
      const bob = await connectClient(url2, 'Bob');
      clients.push(alice, bob);
      const received = waitForEvent(bob, 'chat:message');
      alice.emit('chat:message', { text: 'hello from the primary' });
      let message;
      try {
        message = await received;
      } catch (error) {
        error.message += `\nserver 1: ${server1.output}\nserver 2: ${server2.output}`;
        throw error;
      }

      assert.strictEqual(message.sender, 'Alice');
      assert.strictEqual(message.text, 'hello from the primary');
      assert.strictEqual(message.serverId, 'integration-1');

      const historyClient = await connectClient(url2, 'History');
      clients.push(historyClient);
      const history = await historyClient.initialHistory;
      assert.ok(history.messages.some((item) => item.id === message.id));
    } finally {
      for (const client of clients) client.disconnect();
      await Promise.all([stopNode(server1), stopNode(server2)]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const listener = http.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startNode(serverId, port, peerUrl, token, dataDir) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_ID: serverId,
      SERVER_NAME: serverId,
      PEER_URLS: peerUrl,
      CLUSTER_TOKEN: token,
      CHAT_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => (child.output += chunk));
  child.stderr.on('data', (chunk) => (child.output += chunk));
  return child;
}

async function waitForHealth(url) {
  return waitFor(async () => (await fetch(`${url}/health`)).ok, `server at ${url} did not start`);
}

async function waitForPeer(url) {
  return waitFor(async () => {
    const response = await fetch(`${url}/health`);
    const health = await response.json();
    return health.connectedPeers > 0;
  }, `server at ${url} did not connect to its peer`);
}

async function waitFor(check, errorMessage) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      // A server can be unreachable briefly while it starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(errorMessage);
}

async function connectClient(url, name) {
  const client = ioClient(url, { transports: ['websocket'], timeout: 5000 });
  client.initialHistory = waitForEvent(client, 'history');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`client ${name} connect timed out`)), 7000);
    client.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.once('connect', () => client.emit('identify', name));
    client.once('server:join', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return client;
}

function waitForEvent(socket, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${eventName} event timed out`)), 5000);
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function stopNode(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
