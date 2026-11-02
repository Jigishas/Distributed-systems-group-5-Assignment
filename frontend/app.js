'use strict';

const connectPanel = document.getElementById('connectPanel');
const chatPanel = document.getElementById('chatPanel');
const usernameInput = document.getElementById('username');
const serverUrlInput = document.getElementById('serverUrl');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const messagesEl = document.getElementById('messages');
const statusText = document.getElementById('statusText');
const historyCount = document.getElementById('historyCount');
const serverBadge = document.getElementById('serverBadge');
const badgeDot = document.getElementById('badgeDot');
const badgeLabel = document.getElementById('badgeLabel');
const connectedServerLabel = document.getElementById('connectedServerLabel');
const serverTypeBadge = document.getElementById('serverTypeBadge');

const DEFAULT_SERVERS = ['http://127.0.0.1:4000', 'http://127.0.0.1:4001'];
const KNOWN_SERVERS = window.CHAT_SERVERS || DEFAULT_SERVERS;
const DEFAULT_URL = KNOWN_SERVERS[0] || DEFAULT_SERVERS[0];
const RECONNECT_DELAY_MS = 3000;

let socket = null;
let currentUser = '';
let currentUrl = '';
let serverIndex = 0;
let reconnectTimer = null;
let messageCount = 0;
const displayedMessageIds = new Set();

function escapeHtml(text) {
  const element = document.createElement('div');
  element.textContent = text;
  return element.innerHTML;
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addMessage(message, own = false) {
  if (message.id && displayedMessageIds.has(message.id)) return;
  if (message.id) displayedMessageIds.add(message.id);

  const element = document.createElement('div');
  element.className = `message ${own ? 'own' : 'other'}`;
  element.innerHTML = `
    <div>${escapeHtml(message.sender || 'Unknown')}</div>
    <div>${escapeHtml(message.text || '')}</div>
    <span class="meta">${formatTime(message.timestamp)}  •  ${escapeHtml(message.serverId || '?')}</span>
  `;
  messagesEl.appendChild(element);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  messageCount += 1;
  historyCount.textContent = `${messageCount} message(s)`;
}

function addSystemMessage(text) {
  const element = document.createElement('div');
  element.className = 'message system';
  element.textContent = text;
  messagesEl.appendChild(element);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(text, type = 'neutral') {
  statusText.textContent = text;
  badgeLabel.textContent = text;
  badgeDot.className = `badge-dot${type === 'neutral' ? '' : ` ${type}`}`;
  serverBadge.style.background = type === 'connected' ? '#dcfce7' : '';
}

function enableChat(enabled) {
  messageInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  if (enabled) messageInput.focus();
}

function showPanel(panel) {
  connectPanel.style.display = panel === 'connect' ? 'flex' : 'none';
  chatPanel.style.display = panel === 'chat' ? 'flex' : 'none';
}

function connect(url, userName) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const previousConnection = socket;
  socket = null;
  if (previousConnection) previousConnection.disconnect();

  currentUrl = url;
  currentUser = userName;
  const knownIndex = KNOWN_SERVERS.indexOf(url);
  serverIndex = knownIndex === -1 ? -1 : knownIndex;
  enableChat(false);
  setStatus('Connecting...', 'reconnecting');

  const connection = io(url, { transports: ['websocket'], reconnection: false });
  socket = connection;

  connection.on('connect', () => {
    if (socket !== connection) return;
    serverIndex = KNOWN_SERVERS.indexOf(url);
    setStatus('Connected', 'connected');
    showPanel('chat');
    enableChat(true);
    connection.emit('identify', userName);
  });

  connection.on('connect_error', (error) => {
    if (socket !== connection) return;
    setStatus(`Connection failed: ${error.message}`, 'disconnected');
    scheduleReconnect();
  });

  connection.on('disconnect', () => {
    if (socket !== connection) return;
    setStatus('Disconnected', 'disconnected');
    enableChat(false);
    scheduleReconnect();
  });

  connection.on('server:join', (payload) => {
    connectedServerLabel.textContent = payload.serverId || 'Unknown';
    const type = payload.replica ? 'replica' : 'primary';
    serverTypeBadge.textContent = type;
    serverTypeBadge.className = `server-type-badge ${type}`;
    addSystemMessage(`Connected to ${payload.name} — ${payload.serverCount} node(s) known`);
  });

  connection.on('history', (payload) => {
    messagesEl.innerHTML = '';
    displayedMessageIds.clear();
    messageCount = 0;
    historyCount.textContent = '';
    (payload.messages || []).forEach((message) => addMessage(message, message.sender === currentUser));
  });

  connection.on('chat:message', (message) => addMessage(message));
  connection.on('chat:error', (error) => addSystemMessage(error.message));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  serverIndex = (serverIndex + 1) % KNOWN_SERVERS.length;
  const nextUrl = KNOWN_SERVERS[serverIndex];
  setStatus(`Retrying ${nextUrl} in ${RECONNECT_DELAY_MS / 1000}s...`, 'reconnecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(nextUrl, currentUser);
  }, RECONNECT_DELAY_MS);
}

connectBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) {
    usernameInput.focus();
    return;
  }
  connect(serverUrlInput.value.trim() || DEFAULT_URL, name);
});

usernameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connectBtn.click();
});

disconnectBtn.addEventListener('click', () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const connection = socket;
  socket = null;
  if (connection) connection.disconnect();
  showPanel('connect');
  enableChat(false);
  setStatus('Disconnected', 'disconnected');
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !socket || !socket.connected) return;
  socket.emit('chat:message', { text });
  addMessage({ text, sender: currentUser, timestamp: new Date().toISOString() }, true);
  messageInput.value = '';
});

showPanel('connect');
usernameInput.focus();
