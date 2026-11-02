# Distributed Chat Application — Report

## 1. Architecture

The application uses Node.js, Express, and Socket.IO. Each server process
accepts browser and command-line clients over WebSocket and maintains an
outbound Socket.IO connection to each configured peer node.

| Component | Responsibility |
|-----------|----------------|
| Client | Identifies itself, sends and displays messages, and tries another configured server after a disconnect. |
| Server node | Handles concurrent sockets, validates client names and messages, broadcasts locally, exposes health and node-information endpoints, and persists message history. |
| Peer connection | Authenticated server-to-server socket used to relay a message to other nodes. A receiving node persists and delivers it to its local clients without relaying it again. |
| Message store | Per-node append-only JSON Lines history. Relayed messages are also saved by receiving nodes so history follows clients during failover. |

### Normal message flow

1. A client connects to either server and sends its display name.
2. Its server validates the message, assigns the sender identity and metadata,
   appends it to the local history file, and delivers it to other local clients.
3. The server relays the message to connected peers. Each peer saves it and
   delivers it to its own local clients.
4. On reconnect, a client requests the history stored by its current node.

### Failure handling

Clients try the other address in their configured server list after losing a
connection. Nodes continue serving local clients if a peer is unavailable;
peer sockets retry their connections. Messages sent while nodes are
disconnected are not queued for later delivery, but each node retains its own
persisted history. This is basic failover, not consensus or guaranteed
exactly-once delivery.

## 2. Challenges and solutions

### Cross-node delivery

Local-only fan-out meant that clients connected to separate servers could not
chat. The solution is an authenticated peer socket: the origin server sends a
message to connected peers, which deliver locally and do not forward it again.
This keeps the two-node flow simple and avoids relay loops.

### Reconnect and history consistency

Failover would be less useful if the backup server lacked recent messages.
Each node therefore appends both locally originated and peer-relayed messages
to its own JSON Lines file. Logs are separated by node to avoid multiple
processes writing to the same file.

### Client behavior and input handling

The CLI client had a misplaced function boundary that stopped its connection
setup from running, and the browser client had malformed function structure.
Both clients now connect, identify, render history, and schedule failover.
Servers reject unidentified senders, blank or oversized names, and blank or
oversized messages; sender names are taken from the established socket rather
than trusted from each message.

## 3. Evaluation

`npm test` includes unit tests for the registry and message store, a health
endpoint check, and a two-process integration test. The integration test starts
two nodes with isolated data directories, waits for their peer connections,
sends a message from a client on one node to a client on the other, and verifies
that a new client on the receiving node can retrieve that message from history.

This verifies the required multi-node relay and persistence paths. It is not a
throughput benchmark: no production-scale load or latency figures are claimed.
For a repeatable load evaluation, increase the number of connected clients and
messages in the integration test and record message delivery time, missed
messages, and CPU/memory use on the test machine.

### Limitations and improvements

1. The peer topology is configured statically. A larger cluster would benefit
   from service discovery and a scalable message broker such as Redis Pub/Sub.
2. Messages are not queued or reconciled when a peer is disconnected, and
   retries can leave a brief delivery gap during failover.
3. JSON Lines history is read in full on reconnect, so large logs need rotation
   or a database with paginated history.
4. The registry is process-local and does not discover peers; client failover
   uses known URLs. A cluster manager could provide dynamic membership.
5. The shared development token must be replaced with a secret in deployments,
   and production use would also require TLS, authorization, and rate limits.

## 4. Conclusion

The application provides two chat server nodes, concurrent client connections,
real-time cross-node message relay, client reconnection, and replicated
append-only message history. The integration test checks the core distributed
path. Durable peer queues, dynamic discovery, and measured high-load behavior
remain possible extensions.
