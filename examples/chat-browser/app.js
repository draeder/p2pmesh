// examples/chat-browser/app.js
import { createMesh } from '../../src/index.js';
import { generateDeterministicRoomId } from '../../src/utils/room-id-generator.js';

document.addEventListener('DOMContentLoaded', () => {
  const myPeerIdEl = document.getElementById('myPeerId');
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const connectedPeersEl = document.getElementById('connectedPeers');
  const peersSection = document.getElementById('peersSection');
  
  // Settings panel elements
  const transportSelect = document.getElementById('transportSelect');
  const signalingUrl = document.getElementById('signalingUrl');
  const roomName = document.getElementById('roomName');
  const websocketSettings = document.getElementById('websocketSettings');
  const webtorrentSettings = document.getElementById('webtorrentSettings');
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');

  let mesh;
  
  // Set to track disconnected peers to prevent duplicate disconnect messages
  const disconnectedPeers = new Set();

  // Handle transport selection UI
  transportSelect.addEventListener('change', () => {
    const selectedTransport = transportSelect.value;
    if (selectedTransport === 'websocket') {
      websocketSettings.style.display = 'block';
      webtorrentSettings.style.display = 'none';
    } else if (selectedTransport === 'webtorrent') {
      websocketSettings.style.display = 'none';
      webtorrentSettings.style.display = 'block';
    }
  });

  myPeerIdEl.textContent = 'Initializing ID...';
  statusEl.textContent = 'Status: Initializing...';

  function addMessage(text, type = 'remote', peer = 'System') {
    const li = document.createElement('li');
    li.textContent = text;
    li.className = type;
    if (type === 'remote') {
      const peerInfo = document.createElement('span');
      peerInfo.className = 'peer-info';
      peerInfo.textContent = `${peer}: `;
      li.prepend(peerInfo);
    }
    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function updateConnectedPeersList() {
    connectedPeersEl.innerHTML = '';
    if (mesh && mesh.peers.size > 0) {
      mesh.peers.forEach((peer, peerId) => {
        const li = document.createElement('li');
        li.textContent = `${peerId} (${peer.connected ? 'Connected' : 'Connecting...'})`;
        connectedPeersEl.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.textContent = 'No peers connected.';
      connectedPeersEl.appendChild(li);
    }
  }

    async function initMesh() {
    try {
      const selectedTransport = transportSelect.value;
      let meshConfig;
      
      if (selectedTransport === 'websocket') {
        const serverUrl = signalingUrl.value.trim();
        if (!serverUrl) {
          throw new Error('Please enter a signaling server URL');
        }
        
        statusEl.textContent = `Status: Connecting to signaling server ${serverUrl}...`;
        
        meshConfig = {
          transportName: 'websocket',
          transportOptions: {
            signalingServerUrl: serverUrl
          },
          maxPeers: 3,
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        };
      } else if (selectedTransport === 'webtorrent') {
        const roomNameValue = roomName.value.trim();
        if (!roomNameValue) {
          throw new Error('Please enter a room name');
        }
        
        statusEl.textContent = `Status: Generating room ID for "${roomNameValue}"...`;
        
        // Generate deterministic room ID from room name
        const roomId = await generateDeterministicRoomId(roomNameValue);
        statusEl.textContent = `Status: Connecting to WebTorrent swarm (${roomId.substring(0, 8)}...)...`;
        
        meshConfig = {
          transportName: 'webtorrent',
          transportOptions: {
            infoHash: roomId
          },
          maxPeers: 10 // WebTorrent can handle more peers
        };
      }
      
      mesh = await createMesh(meshConfig);
      
      // Update UI state
      myPeerIdEl.textContent = mesh.peerId;
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'inline-block';
      messageForm.style.display = 'flex';
      peersSection.style.display = 'block';
      transportSelect.disabled = true;
      signalingUrl.disabled = true;
      roomName.disabled = true;

      mesh.on('peer:connect', (peerId) => {
        addMessage(`Connected to peer: ${peerId}`, 'system');
        statusEl.textContent = `Status: Connected to peer ${peerId}. Mesh active.`;
        // Reset the disconnected state when a peer connects/reconnects
        disconnectedPeers.delete(peerId);
        updateConnectedPeersList();
      });

      mesh.on('peer:disconnect', (peerId) => {
        // Add tracking to prevent duplicate disconnect messages
        if (!disconnectedPeers.has(peerId)) {
          disconnectedPeers.add(peerId);
          addMessage(`Disconnected from peer: ${peerId}`, 'system');
          statusEl.textContent = 'Status: Peer disconnected. Mesh active.';
          updateConnectedPeersList();
        }
      });

      mesh.on('peer:timeout', (peerId) => {
        // Add tracking to prevent duplicate timeout/disconnect messages
        if (!disconnectedPeers.has(peerId)) {
          disconnectedPeers.add(peerId);
          addMessage(`Connection to peer ${peerId} timed out`, 'system');
          statusEl.textContent = 'Status: Peer connection timed out. Mesh active.';
          updateConnectedPeersList();
        }
      });

      mesh.on('message', ({ from, data }) => {
        let displayData = data;
        try {
          let messageObject = data;
          if (typeof data === 'string') {
            try {
              messageObject = JSON.parse(data);
            } catch {
              messageObject = data;
            }
          }

          if (messageObject && typeof messageObject.payload !== 'undefined') {
            displayData = messageObject.payload;
          } else {
            displayData = messageObject;
          }

          if (typeof displayData === 'object' && displayData !== null) {
            displayData = JSON.stringify(displayData, null, 2);
          }
        } catch (e) {
          console.error('Error processing message:', e);
          displayData = String(data);
        }

        addMessage(String(displayData), 'remote', from);
      });

      // Override internal peer event listeners for UI updates
      const originalSetupPeerEvents = mesh._connectToPeer.toString().includes('setupPeerEvents')
        ? (peer, remotePeerId) => {
            peer.on('connect', () => {
              console.log(`UI: Connected to peer: ${remotePeerId}`);
              addMessage(`Successfully established connection with ${remotePeerId}.`, 'system');
              // Reset the disconnected state when a peer connects/reconnects
              disconnectedPeers.delete(remotePeerId);
              mesh.emit('peer:connect', remotePeerId);
              updateConnectedPeersList();
            });
            peer.on('data', (data) => {
              const dataString = data.toString();
              console.log(`UI: Received data from ${remotePeerId}: ${dataString}`);
              
              // Filter out internal protocol messages before emitting to UI
              try {
                const parsedData = JSON.parse(dataString);
                
                // Only filter out specific internal protocol messages
                if (parsedData.type === 'gossip_ack') {
                  console.log(`UI: Filtered out internal gossip_ack message from ${remotePeerId}`);
                  return; // Don't forward acknowledgments to application layer
                }
                
                // Make sure to explicitly pass through broadcast messages
                if (parsedData.type === 'gossip' || parsedData.type === 'broadcast' || 
                    (parsedData.type === 'broadcast' && parsedData.topic === 'chat_message')) {
                  console.log(`UI: Passing through broadcast/gossip message from ${remotePeerId}`);
                }
              } catch (e) {
                // If not JSON, continue with raw data
                console.log(`UI: Non-JSON data from ${remotePeerId}, passing through`);
              }
              
              mesh.emit('message', { from: remotePeerId, data: dataString });
            });
            peer.on('close', () => {
              console.log(`UI: Connection closed with peer: ${remotePeerId}`);
              // Only emit the event if the peer hasn't been marked as disconnected
              if (!disconnectedPeers.has(remotePeerId)) {
                disconnectedPeers.add(remotePeerId);
                mesh.emit('peer:disconnect', remotePeerId);
              }
              updateConnectedPeersList();
            });
            peer.on('error', (err) => {
              console.error(`UI: Error with peer ${remotePeerId}:`, err);
              addMessage(`Error with peer ${remotePeerId}: ${err.message}`, 'system');
              // Only emit the event if the peer hasn't been marked as disconnected
              if (!disconnectedPeers.has(remotePeerId)) {
                disconnectedPeers.add(remotePeerId);
                mesh.emit('peer:disconnect', remotePeerId); // Treat error as disconnect for simplicity
              }
              updateConnectedPeersList();
            });
          }
        : null;

      if (mesh.peers && originalSetupPeerEvents) {
        const originalConnect = mesh._connectToPeer;
        mesh._connectToPeer = (targetPeerId) => {
          originalConnect(targetPeerId);
          if (mesh.peers.has(targetPeerId)) {
            const peerInstance = mesh.peers.get(targetPeerId);
            if (!peerInstance._uiEventsAttached) {
              originalSetupPeerEvents(peerInstance, targetPeerId);
              peerInstance._uiEventsAttached = true;
            }
          }
        };
      }

      await mesh.join();
      statusEl.textContent = 'Status: Mesh joined. Waiting for peers...';
      addMessage('Mesh joined. Your ID: ' + mesh.peerId, 'system');
      
      // Subscribe to the same 'chat_message' topic as Node.js clients to ensure consistency
      mesh.subscribe('chat_message', (message) => {
        console.log('FIXED: Received gossip message:', message);
        
        let displayData = message;
        let senderPeerId = 'Unknown';
        
        try {
          if (typeof message === 'object' && message !== null) {
            // FIXED: Check multiple possible fields for sender ID
            senderPeerId = message.from || message.originPeerId || message.messageId?.split('-')[0] || 'Unknown';
            
            if (typeof message.data !== 'undefined') {
              displayData = message.data;
            } else if (typeof message.payload !== 'undefined') {
              displayData = message.payload;
            }
            
            if (typeof displayData === 'object' && displayData !== null) {
              displayData = JSON.stringify(displayData, null, 2);
            }
          }
        } catch (e) {
          console.error('Error processing broadcast message:', e);
          displayData = String(message);
        }
        
        // FIXED: Always show the sender peer ID instead of "Unknown"
        console.log(`FIXED: Displaying message from ${senderPeerId}: ${displayData}`);
        addMessage(String(displayData), 'remote', senderPeerId);
      });
      
      updateConnectedPeersList();

    } catch (error) {
      console.error('Failed to initialize P2PMesh:', error);
      statusEl.textContent = 'Status: Error initializing mesh.';
      addMessage(`Error: ${error.message}`, 'system');
    }
  }

  async function disconnectMesh() {
    if (mesh) {
      try {
        await mesh.leave();
        mesh = null;
        
        // Reset UI state
        myPeerIdEl.textContent = 'Not connected';
        statusEl.textContent = 'Status: Disconnected';
        connectBtn.style.display = 'inline-block';
        disconnectBtn.style.display = 'none';
        messageForm.style.display = 'none';
        peersSection.style.display = 'none';
        transportSelect.disabled = false;
        signalingUrl.disabled = false;
        roomName.disabled = false;
        
        // Clear peers list
        connectedPeersEl.innerHTML = '';
        disconnectedPeers.clear();
        
        addMessage('Disconnected from mesh', 'system');
      } catch (error) {
        console.error('Error disconnecting:', error);
        statusEl.textContent = 'Status: Error disconnecting';
        addMessage(`Disconnect error: ${error.message}`, 'system');
      }
    }
  }

  // Button event listeners
  connectBtn.addEventListener('click', initMesh);
  disconnectBtn.addEventListener('click', disconnectMesh);

  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const messageText = messageInput.value.trim();
    if (messageText && mesh) {
      mesh.sendBroadcast('chat_message', messageText);
      addMessage(messageText, 'local');
      messageInput.value = '';
    } else if (!mesh) {
      addMessage('Not connected to the mesh. Cannot send message.', 'system');
    }
  });

  // Auto-update peers list when connected
  setInterval(() => {
    if (mesh) {
      updateConnectedPeersList();
    }
  }, 3000);
});
