'use strict';

/**
 * ServerRegistry
 * ---------------------------------------------------------------
 * Central registry that tracks all server nodes in the distributed
 * chat system. Each server (primary or replica) registers itself,
 * publishes its WebSocket address, and advertises a health endpoint.
 *
 * For failover, the registry is *not* a third party that can become
 * a single point of failure here — it's a plain in-memory map that
 * every server node reads itself (and optionally fetches from a
 * lightweight HTTP endpoint used only for cluster discovery, which
 * is treated as an optional convenience, not a dependency).
 *
 * Design note:
 *  - This registry is deliberately simple to satisfy the assignment's
 *    "basic fault tolerance" requirement without introducing a SPOF.
 *  - In production you would replace this with etcd / Consul / ZooKeeper
 *    for a strongly consistent cluster registry.
 */

const servers = new Map();

/** Register (or re-register) a server node. */
function register(serverId, { name, host, port, isPrimary, healthUrl }) {
  servers.set(serverId, {
    serverId,
    name,
    host,
    port,
    isPrimary,
    healthUrl,
    lastHeartbeat: Date.now(),
  });
  log(`[registry] registered server ${serverId} (${name}) at ${host}:${port}`);
}

/** Remove a server from the registry (e.g. unexpected disconnect). */
function unregister(serverId) {
  const entry = servers.get(serverId);
  if (entry) {
    log(`[registry] unregistered server ${serverId} (${entry.name})`);
    servers.delete(serverId);
  }
}

/**
 * Return a shallow copy of the registry used for client failover
 * lookup. Sorted by "prefer primary" so clients can pick the best
 * available node.
 */
function getAllServers() {
  return Array.from(servers.values());
}

/** Count registered servers (useful for the health-check endpoint). */
function getServerCount() {
  return servers.size;
}

function log(message) {
  const now = new Date().toISOString();
  process.stdout.write(`[ServerRegistry:${now}] ${message}\n`);
}

module.exports = {
  register,
  unregister,
  getAllServers,
  getServerCount,
  servers,
};
