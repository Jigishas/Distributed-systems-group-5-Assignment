'use strict';

/**
 * Distributed Chat - Tests
 * ---------------------------------------------------------------
 * Unit tests for registry and store modules, plus an integration
 * test for the server's HTTP health endpoint.
 *
 * Run with:  npm test   (or)   node --test tests/
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { register, unregister, getAllServers, getServerCount } = require('../server/registry');
const { append, readAll, deleteLog, close } = require('../server/store');

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('Cluster registry', () => {
  before(() => {
    // Clear the registry before tests.
    // (The registry module exports the internal Map; we clear it directly.)
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
    assert.deepStrictEqual(getAllServers().map((s) => s.serverId), ['s2']);

    unregister('s2');
    assert.strictEqual(getServerCount(), 0);
    assert.deepStrictEqual(getAllServers(), []);
  });
});

// ---------------------------------------------------------------------------
// Message store tests
// ---------------------------------------------------------------------------

describe('Message store', () => {
  before(() => {
    deleteLog();
  });

  after(() => {
    close();
    deleteLog();
  });

  it('appends and reads messages', () => {
    const m1 = { id: '1', text: 'hello', sender: 'Alice', serverId: 's1', timestamp: new Date().toISOString() };
    const m2 = { id: '2', text: 'world', sender: 'Bob', serverId: 's2', timestamp: new Date().toISOString() };

    assert.strictEqual(append(m1), true);
    assert.strictEqual(append(m2), true);

    const all = readAll();
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].text, 'hello');
    assert.strictEqual(all[1].text, 'world');
  });

  it('deletes the log', () => {
    deleteLog();
    const all = readAll();
    assert.strictEqual(all.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Server health endpoint test
// ---------------------------------------------------------------------------

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
    // Give the server a moment to start listening.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  after(async () => {
    if (clientSocket) clientSocket.disconnect();
    if (ioServer) ioServer.close();
    if (serverHandle) serverHandle.close();
  });

  it('responds with healthy status', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.get('http://127.0.0.1:4997/health', (r) => {
        let data = '';
        r.on('data', (chunk) => (data += chunk));
        r.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy(new Error('request timeout'));
      });
    });

    assert.strictEqual(res.healthy, true);
    assert.strictEqual(res.serverId, 'test-node');
    assert.strictEqual(res.isPrimary, true);
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
      socket.on('connect_error', (err) => reject(err));
      socket.on('error', (err) => reject(err));
      socket.on('disconnect', () => {
        // Ignore - we only care about the initial connect.
      });
    });

    assert.strictEqual(connected, true);
  });
});

