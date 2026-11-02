# Distributed Chat Application

A simple distributed chat application built with **Node.js + socket.io** that
demonstrates client-server communication, real-time message broadcasting, and
basic fault tolerance across multiple server nodes.

## Architecture

```
┌─────────────┐      WS       ┌──────────────┐      WS       ┌─────────────┐
│  Client A   │ <───────────> │  Server-1    │ <───────────> │  Client B   │
│             │   (primary)   │   (port 4000)│               │             │
└─────────────┘               └──────────────┘               └─────────────┘
                                   ▲
                                   │ WS (failover)
                                   │
┌─────────────┐               ┌──────────────┐
│  Client C   │ <───────────> │  Server-2    │
│             │   (replica)   │   (port 4001)│
└─────────────┘               └──────────────┘
```

- **Server nodes**: Each server runs an Express HTTP server + socket.io
  WebSocket server. Clients connect via WebSocket.
- **Message broadcasting**: Each server delivers a message to its local clients
  and relays it to configured peer nodes over authenticated Socket.IO
  connections. A receiving peer persists and delivers it locally without
  forwarding it again.
- **Registry**: Each process has a small in-memory registry for its own node.
  Clients use a configured priority list for failover; the registry is not a
  distributed service-discovery system.
- **Health endpoint**: `GET /health` on each server returns liveness status.
- **Persistence**: Each node appends messages to its own JSON Lines log under
  `data/<server-id>/messages.jsonl`, so replicated history can be replayed
  after a reconnect or process restart.
- **Failover**: If a server goes down, clients auto-reconnect to the next
  known server node (primary → replica → primary …).

## Project Structure

```
Assignment/
├── package.json             # npm manifest + scripts
├── package-lock.json
├── server/
│   ├── server.js            # Single server node (primary or replica)
│   ├── registry.js          # Cluster node registry
│   └── store.js             # Message persistence (JSON Lines)
├── frontend/
│   ├── index.html        # Web chat GUI
│   ├── style.css         # Styling
│   └── app.js            # Socket.io client logic with auto-failover
├── client/
│   └── client.js         # CLI chat client with auto-failover
├── tests/
│   └── chat.test.js         # Integration + unit tests
├── docs/
│   └── report.md            # Architecture, challenges, performance
└── data/                    # Created at runtime; one message log per node
```

## Prerequisites

- Node.js v18+ (tested on v22.18.0)
- npm (bundled with Node.js)

## Setup

From the project root:

```bash
npm install
```

This installs `express`, `socket.io`, and `socket.io-client`.

## Running the Application

### 1. Start the primary server

```bash
npm run server            # port 4000, primary
# or explicitly:
node server/server.js
```

### 2. Start the replica server (in another terminal)

```bash
node server/server.js --replica   # port 4001, replica
```

The default nodes connect to each other on ports 4000 and 4001. For nodes on
different machines or custom ports, configure each process with the URL(s) of
its peer nodes in `PEER_URLS` (comma-separated), and use the same
`CLUSTER_TOKEN` on every node. For example:

```powershell
$env:PORT = "4000"
$env:HOST = "0.0.0.0"
$env:PEER_URLS = "http://192.168.1.12:4001"
$env:PUBLIC_URL = "http://192.168.1.11:4000"
$env:CLUSTER_TOKEN = "softwaregroup6"
node server/server.js
```

Set the peer server's `PEER_URLS` to the first node's reachable address.
`HOST` controls the local bind address; use a reachable address in client
`--url` values. `PUBLIC_URL` is the address the browser client advertises for
the current node. To configure CLI failover on another network, set
`CHAT_SERVERS` to the ordered comma-separated server URLs before running the
client. The built-in token is for local development only; set a private shared
token before exposing nodes to a network.

### 3. Start clients

```bash
npm run client            # default name, connect to port 4000
# or with a custom name / server:
node client/client.js --name Alice --url http://127.0.0.1:4000
node client/client.js --name Bob   --url http://127.0.0.1:4001
```

### 4. Chatting

Type a message at the `name>` prompt and press Enter to broadcast it to all
connected clients. Type `/quit` to exit.

### Web Frontend (GUI)

Instead of the CLI client, you can use the browser-based chat UI served directly
by each server node.

1. Start the primary server (and optionally the replica).
2. Open your browser to `http://127.0.0.1:4000/` (primary) or
   `http://127.0.0.1:4001/` (replica).
3. Enter your name and click **Connect**.
4. Type messages in the input box and press Enter to broadcast.
5. The UI shows which server you're connected to (primary/replica badge) and
   auto-fails over to the replica if the primary goes down.

## Testing

```bash
npm test                  # unit tests and two-node relay/history integration test
```

## Fault Tolerance Demo

1. Start both servers (primary on 4000, replica on 4001).
2. Connect two clients (one to each server) and verify messages are delivered
   across nodes.
3. Stop the primary server (`Ctrl+C`).
4. A client connected to the primary will try the replica after the reconnect
   delay. It can continue chatting while the replica is available.

## Report

See `docs/report.md` for the architecture, challenges, performance
evaluation, and potential improvements.
