// examples/chat-browser/app.js
import { createMesh } from '../../src/index.js';
import { WebSocketTransport } from '../../src/transports/websocket-transport.js';

document.addEventListener('DOMContentLoaded', () => {
  const myPeerIdEl = document.getElementById('myPeerId');
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const connectedPeersEl = document.getElementById('connectedPeers');

  const signalingServerUrl = 'ws://localhost:8080';
  let mesh;
  
  // Set to track disconnected peers to prevent duplicate disconnect messages
  const disconnectedPeers = new Set();

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
      statusEl.textContent = `Status: Connecting to signaling server ${signalingServerUrl}...`;
      const transport = new WebSocketTransport(signalingServerUrl);

      transport.on('open', () => {
        statusEl.textContent = 'Status: Connected to signaling server. Joining mesh...';
      });
      transport.on('close', () => {
        statusEl.textContent = 'Status: Disconnected from signaling server.';
        addMessage('Disconnected from signaling server.', 'system');
        updateConnectedPeersList();
      });
      transport.on('error', (err) => {
        statusEl.textContent = 'Status: Signaling error.';
        addMessage(`Signaling error: ${err.message}`, 'system');
        console.error('Transport error:', err);
        updateConnectedPeersList();
      });

      mesh = await createMesh({
        transport,
        maxPeers: 3,
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      myPeerIdEl.textContent = mesh.peerId;

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
          addMessage(`Connection to peer ${peerId} timed out after ${CONNECTION_TIMEOUT/1000} seconds`, 'system');
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
      updateConnectedPeersList();

    } catch (error) {
      console.error('Failed to initialize P2PMesh:', error);
      statusEl.textContent = 'Status: Error initializing mesh.';
      addMessage(`Error: ${error.message}`, 'system');
    }
  }

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

  initMesh();
  setInterval(updateConnectedPeersList, 3000);
});
