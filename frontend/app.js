/* ==========================================================================
   Distributed Chat — Frontend Application Logic
   ========================================================================== */

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_URL = 'http://127.0.0.1:4000';
const REPLICA_URL = 'http://127.0.0.1:4001';
const KNOWN_SERVERS = [DEFAULT_URL, REPLICA_URL];
const RECONNECT_DELAY_MS = 3000;

let socket = null;
let currentUser = '';
let currentUrl = '';
let serverIndex = 0;
let isConnected = false;
let reconnectTimer = null;
let messageCount = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addMessage(message, options = {}) {
  const isOwn = options.own === true;
  const isSystem = options.system === true;
  const div = document.createElement('div');
  div.className = `message ${isOwn ? 'own' : isSystem ? 'system' : 'other'}`;
  const time = formatTime(message.timestamp);
  const sender = escapeHtml(message.sender || 'System');
  const text = escapeHtml(message.text || message.message || '');
  div.innerHTML = `
    <div>${sender}</div>
    <div>${text}</div>
    <span class="meta">${time}  •  ${message.serverId || '?'}</span>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
  messageCount++;
  if (historyCount) historyCount.textContent = `${messageCount} message(s)`;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function clearMessages() {
  messagesEl.innerHTML = '';
  messageCount = 0;
  if (historyCount) historyCount.textContent = '';
}

function enableChatUI(enabled) {
  messageInput.disabled = !enabled;
function connect(url, userName) {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  currentUrl = url;
  currentUser = userName;
  isConnected = false;
  enableChatUI(false);

  console.log(`[frontend] connecting to ${url} as ${userName}`);
  setStatus('Connecting…', 'neutral');

  socket = io(url, { transports: ['websocket'], reconnection: false });

  socket.on('connect', () => {
    isConnected = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    console.log(`[frontend] connected to ${url}`);
    setStatus('Connected', 'connected');
    serverBadge.style.background = '#dcfce7';
    socket.emit('identify', userName);
    showPanel('chat');
    enableChatUI(true);
    addSystemMessage(`Connected to ${url}`);
  });

  socket.on('connect_error', (err) => {
    console.log(`[frontend] connection error: ${err.message}`);
    setStatus('Connection failed', 'disconnected');
    scheduleReconnect();
  });

  socket.on('disconnect', (reason) => {
    isConnected = false;
    console.log(`[frontend] disconnected (${reason})`);
    setStatus('Disconnected', 'disconnected');
    showPanel('connect');
    enableChatUI(false);
    scheduleReconnect();
  });

  socket.on('server:join', (payload) => {
    connectedServerLabel.textContent = payload.serverId || 'Unknown';
    serverTypeBadge.textContent = payload.replica ? 'replica' : 'primary';
    serverTypeBadge.className = 'server-type-badge ' + (payload.replica ? 'replica' : 'primary');
    addSystemMessage(`${payload.name} joined — ${payload.serverCount} node(s) known`);
  });

  socket.on('history', (payload) => {
    const messages = payload.messages || [];
    if (messages.length > 0) {
      addSystemMessage(`Replaying ${messages.length} message(s) from history`);
      messages.forEach((m) => addMessage(m, { own: m.senderId === socket.id }));
    }
  });

  socket.on('chat:message', (message) => {
    addMessage(message, { own: message.senderId === socket.id });
  });

  socket.on('error', (err) => {
    console.log(`[frontend] socket error: ${err.message}`);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  serverIndex = (serverIndex + 1) % KNOWN_SERVERS.length;
  const nextUrl = KNOWN_SERVERS[serverIndex];
// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

connectBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  const url = serverUrlInput.value.trim() || DEFAULT_URL;
  if (!name) {
    usernameInput.focus();
    return;
  }
  connect(url, name);
});

usernameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

disconnectBtn.addEventListener('click', () => {
  if (socket) socket.disconnect();
  showPanel('connect');
  enableChatUI(false);
  setStatus('Disconnected', 'disconnected');
  clearMessages();
});

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !isConnected || !socket) return;
  socket.emit('chat:message', { text, sender: currentUser });
  addMessage({ text, sender: currentUser, timestamp: new Date().toISOString() }, { own: true });
  messageInput.value = '';
});

// Initialize
showPanel('connect');
usernameInput.focus();

  setStatus(`Retrying ${nextUrl} in ${RECONNECT_DELAY_MS / 1000}s…`, 'reconnecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(nextUrl, currentUser);
  }, RECONNECT_DELAY_MS);
}

  sendBtn.disabled = !enabled;
  if (enabled) messageInput.focus();
}

function setStatus(text, type = 'neutral') {
  statusText.textContent = text;
  badgeDot.className = 'badge-dot';
  badgeLabel.textContent = text;
  if (type === 'connected') {
    badgeDot.classList.add('connected');
    badgeLabel.textContent = 'Connected';
  } else if (type === 'disconnected') {
    badgeDot.classList.add('disconnected');
    badgeLabel.textContent = 'Disconnected';
  } else if (type === 'reconnecting') {
    badgeDot.classList.add('reconnecting');
    badgeLabel.textContent = 'Reconnecting...';
  }
}

function showPanel(panel) {
  connectPanel.style.display = panel === 'connect' ? 'flex' : 'none';
  chatPanel.style.display = panel === 'chat' ? 'flex' : 'none';
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

