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
- **Message broadcasting**: When a client sends a message, the server fans it
  out to all other connected clients on the same node.
- **Registry**: Each server node registers itself in an in-memory cluster
  registry so clients can discover available nodes for failover.
- **Health endpoint**: `GET /health` on each server returns liveness status.
- **Persistence**: Messages are appended to `data/messages.jsonl` (JSON Lines)
  so history can be replayed after a reconnect or crash.
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
└── data/                    # Created at runtime; message log
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
npm test                  # runs node --test tests/
```

## Fault Tolerance Demo

1. Start both servers (primary on 4000, replica on 4001).
2. Connect two clients (one to each server).
3. Kill the primary server (`Ctrl+C`).
4. The client connected to the primary will automatically reconnect to the
   replica within ~3 seconds and can continue chatting.

## Report

See `docs/report.md` for the architecture, challenges, performance
evaluation, and potential improvements.

