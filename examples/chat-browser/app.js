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
  const multiTransportSettings = document.getElementById('multiTransportSettings');
  const additionalServersContainer = document.getElementById('additionalServersContainer');
  const addServerBtn = document.getElementById('addServerBtn');
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');

  let mesh;
  let additionalServerCount = 0;
  
  // Set to track disconnected peers to prevent duplicate disconnect messages
  const disconnectedPeers = new Set();

  // Handle transport selection UI
  transportSelect.addEventListener('change', () => {
    const selectedTransport = transportSelect.value;
    websocketSettings.style.display = 'none';
    webtorrentSettings.style.display = 'none';
    multiTransportSettings.style.display = 'none';
    
    if (selectedTransport === 'websocket') {
      websocketSettings.style.display = 'block';
      multiTransportSettings.style.display = 'block';
    } else if (selectedTransport === 'webtorrent') {
      webtorrentSettings.style.display = 'block';
    } else if (selectedTransport === 'multi') {
      websocketSettings.style.display = 'block';
      webtorrentSettings.style.display = 'block';
      multiTransportSettings.style.display = 'block';
    }
  });

  // Add server button functionality
  addServerBtn.addEventListener('click', () => {
    additionalServerCount++;
    const serverDiv = document.createElement('div');
    serverDiv.className = 'additional-server';
    serverDiv.innerHTML = `
      <label>WebSocket Server ${additionalServerCount + 1}:</label>
      <input type="url" class="additional-server-url" placeholder="wss://example.com/ws" value="ws://localhost:808${additionalServerCount}">
      <button type="button" class="remove-server-btn">Remove</button>
    `;
    
    const removeBtn = serverDiv.querySelector('.remove-server-btn');
    removeBtn.addEventListener('click', () => {
      additionalServersContainer.removeChild(serverDiv);
    });
    
    additionalServersContainer.appendChild(serverDiv);
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
    
    // FIXED: Call the new transport-aware peer list update
    updatePeerList();
  }

  function updatePeerList() {
    const connectedPeersDiv = document.getElementById('connectedPeers');
    const peerCountDiv = document.getElementById('peerCount');
    const transportConnectivityDiv = document.getElementById('transportConnectivity');

    if (!mesh || !connectedPeersDiv || !peerCountDiv) return;

    // FIXED: Get peers from the actual mesh.peers Map, not getConnectedPeers()
    const meshPeers = mesh.peers ? Array.from(mesh.peers.keys()).filter(peerId => {
      const peer = mesh.peers.get(peerId);
      return peer && peer.connected;
    }) : [];
    
    const peerConnections = mesh.getConnectionStates ? mesh.getConnectionStates() : {};
    
    peerCountDiv.textContent = `Connected Peers (${meshPeers.length})`;

    // Get transport information
    const transportBridge = mesh.transportBridge;
    const transports = transportBridge ? transportBridge.getTransports() : [];
    
    // Count peers per transport
    const transportPeerCounts = {};
    const peerTransportInfo = {};
    
    // Initialize transport counts
    transports.forEach(transport => {
      const transportId = transport.getMultiTransportId ? transport.getMultiTransportId() : transport.getTransportType();
      transportPeerCounts[transportId] = 0;
    });

    // FIXED: For each connected peer, determine transport by checking the mesh's connection tracking
    meshPeers.forEach(peerId => {
      const connectionState = peerConnections[peerId];
      let peerTransports = [];
      
      // FIXED: Since we're using WebRTC through signaling, connected peers are likely through websocket transport
      // Check each transport more aggressively
      transports.forEach(transport => {
        const transportId = transport.getMultiTransportId ? transport.getMultiTransportId() : transport.getTransportType();
        
        // FIXED: For WebSocket transport, if peer is connected via WebRTC, it came through WebSocket signaling
        if (transportId.startsWith('websocket')) {
          // All WebRTC connected peers in this setup came through WebSocket signaling
          peerTransports.push(transportId);
          transportPeerCounts[transportId]++;
        }
        
        // Check WebtorrentTransport specifically
        if (transport.hasPeerConnected && transport.hasPeerConnected(peerId)) {
          if (!peerTransports.includes(transportId)) {
            peerTransports.push(transportId);
            transportPeerCounts[transportId]++;
          }
        } else if (transport.connectedPeers && transport.connectedPeers.has(peerId)) {
          if (!peerTransports.includes(transportId)) {
            peerTransports.push(transportId);
            transportPeerCounts[transportId]++;
          }
        } else if (transport.getConnectedPeersWithTransport) {
          const transportPeers = transport.getConnectedPeersWithTransport();
          if (transportPeers.some(p => p.peerId === peerId)) {
            if (!peerTransports.includes(transportId)) {
              peerTransports.push(transportId);
              transportPeerCounts[transportId]++;
            }
          }
        }
      });
      
      // FIXED: If no transport detected but peer is connected, assume primary transport
      if (peerTransports.length === 0 && transports.length > 0) {
        const primaryTransport = transports[0];
        const primaryTransportId = primaryTransport.getMultiTransportId ? primaryTransport.getMultiTransportId() : primaryTransport.getTransportType();
        peerTransports.push(primaryTransportId);
        transportPeerCounts[primaryTransportId]++;
        console.log(`TRANSPORT-DEBUG: Assuming peer ${peerId} connected via primary transport ${primaryTransportId}`);
      }
      
      peerTransportInfo[peerId] = peerTransports;
    });

    // Update peer list with transport information
    if (meshPeers.length === 0) {
      connectedPeersDiv.innerHTML = '<div class="peer-item">No peers connected</div>';
    } else {
      connectedPeersDiv.innerHTML = meshPeers.map(peerId => {
        const connectionState = peerConnections[peerId];
        const transports = peerTransportInfo[peerId] || [];
        const transportText = transports.length > 0 ? ` (${transports.join(', ')})` : ' (unknown transport)';
        
        const stateText = connectionState ? 
          ` - ${connectionState.state} ${connectionState.channel ? '(data channel ready)' : ''}` : 
          ' - Connected';
        
        return `<div class="peer-item">
          <span class="peer-id">${peerId.substring(0, 8)}...${peerId.slice(-8)}</span>
          <span class="peer-transport">${transportText}</span>
          <span class="peer-status">${stateText}</span>
        </div>`;
      }).join('');
    }

    // Update transport connectivity section
    if (transportConnectivityDiv) {
      const totalPeers = meshPeers.length;
      const activeTransports = transports.length;
      const multiTransportPeers = Object.values(peerTransportInfo).filter(transports => transports.length > 1).length;
      
      let connectivityHTML = `
        <div class="connectivity-summary">
          <div><strong>Total Peers:</strong> ${totalPeers}</div>
          <div><strong>Active Transports:</strong> ${activeTransports}</div>
          <div><strong>Multi-Transport Peers:</strong> ${multiTransportPeers}</div>
          <div><strong>Transport Bridge:</strong> ${transportBridge ? 'Active' : 'Inactive'}</div>
        </div>
        <div class="transport-breakdown">
      `;
      
      // Show breakdown by transport
      transports.forEach(transport => {
        const transportId = transport.getMultiTransportId ? transport.getMultiTransportId() : transport.getTransportType();
        const peerCount = transportPeerCounts[transportId] || 0;
        connectivityHTML += `
          <div class="transport-item">
            <strong>${transportId}</strong>: ${peerCount} peers
          </div>
        `;
      });
      
      connectivityHTML += '</div>';
      
      if (multiTransportPeers > 0) {
        connectivityHTML += '<div class="multi-transport-peers"><h4>Multi-Transport Peers:</h4>';
        Object.entries(peerTransportInfo).forEach(([peerId, transports]) => {
          if (transports.length > 1) {
            connectivityHTML += `
              <div class="multi-peer-item">
                ${peerId.substring(0, 8)}...${peerId.slice(-8)}: ${transports.join(', ')}
              </div>
            `;
          }
        });
        connectivityHTML += '</div>';
      } else {
        connectivityHTML += '<div class="no-multi-transport">No multi-transport peers detected</div>';
      }
      
      transportConnectivityDiv.innerHTML = connectivityHTML;
    }
}

function updateTransportInfo() {
    const transportSummaryElement = document.getElementById('transport-summary');
    const peerTransportDetailsElement = document.getElementById('peer-transport-details');
    
    if (!mesh) {
        if (transportSummaryElement) {
            transportSummaryElement.innerHTML = `
                <div class="transport-summary">
                    <div class="stat"><strong>Status:</strong> Not Connected</div>
                </div>
            `;
        }
        return;
    }
    
    const peerCount = mesh.peers ? mesh.peers.size : 0;
    const hasTransportBridge = mesh.transportBridge != null;
    const transportCount = mesh.transportInstances ? mesh.transportInstances.length : 1;
    
    if (transportSummaryElement) {
        if (hasTransportBridge) {
            const summary = mesh.transportBridge.getConnectivitySummary();
            const peerTransportInfo = mesh.transportBridge.getPeerTransportInfo();
            
            transportSummaryElement.innerHTML = `
                <div class="transport-summary">
                    <div class="stat"><strong>Total Peers:</strong> ${summary.totalPeers}</div>
                    <div class="stat"><strong>Active Transports:</strong> ${summary.totalTransports}</div>
                    <div class="stat"><strong>Multi-Transport Peers:</strong> ${summary.multiTransportPeers}</div>
                    <div class="stat"><strong>Transport Bridge:</strong> Active</div>
                    <div class="transport-breakdown">
                        ${Object.entries(summary.transportBreakdown).map(([transportId, count]) => 
                            `<div class="transport-stat">
                                <span class="transport-badge transport-${transportId.split('-')[0]}">${transportId}</span>: ${count} peers
                            </div>`
                        ).join('')}
                    </div>
                </div>
            `;
            
            if (peerTransportDetailsElement) {
                const multiTransportPeers = Object.entries(peerTransportInfo)
                    .filter(([peerId, info]) => info.isMultiTransport);
                
                if (multiTransportPeers.length > 0) {
                    peerTransportDetailsElement.innerHTML = `
                        <h4>Multi-Transport Peers</h4>
                        ${multiTransportPeers.map(([peerId, info]) => `
                            <div class="peer-transport-detail">
                                <span class="peer-id">${peerId}</span>
                                <div class="transport-list">
                                    ${info.transports.map(transportId => 
                                        `<span class="transport-badge transport-${transportId.split('-')[0]} ${transportId === info.preferredTransport ? 'preferred' : ''}">${transportId}</span>`
                                    ).join(' ')}
                                </div>
                            </div>
                        `).join('')}
                    `;
                } else {
                    peerTransportDetailsElement.innerHTML = '<p>No multi-transport peers detected</p>';
                }
            }
        } else {
            transportSummaryElement.innerHTML = `
                <div class="transport-summary">
                    <div class="stat"><strong>Total Peers:</strong> ${peerCount}</div>
                    <div class="stat"><strong>Configured Transports:</strong> ${transportCount}</div>
                    <div class="stat"><strong>Transport Bridge:</strong> ${transportCount > 1 ? 'Initializing...' : 'Single Transport Mode'}</div>
                    <div class="stat"><strong>Bridge Status:</strong> ${hasTransportBridge ? 'Active' : 'Not Available'}</div>
                </div>
            `;
        }
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
        
        // Check for additional servers
        const additionalUrls = Array.from(document.querySelectorAll('.additional-server-url'))
          .map(input => input.value.trim())
          .filter(url => url);
        
        if (additionalUrls.length > 0) {
          // Multi-WebSocket setup
          const allUrls = [serverUrl, ...additionalUrls];
          statusEl.textContent = `Status: Connecting to ${allUrls.length} WebSocket servers...`;
          
          meshConfig = {
            transportConfigs: allUrls.map((url, index) => ({
              name: 'websocket',
              id: `websocket-${index}`,
              options: { signalingServerUrl: url }
            })),
            maxPeers: 3,
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
          };
        } else {
          // Single WebSocket setup
          statusEl.textContent = `Status: Connecting to signaling server ${serverUrl}...`;
          
          meshConfig = {
            transportName: 'websocket',
            transportOptions: {
              signalingServerUrl: serverUrl
            },
            maxPeers: 3,
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
          };
        }
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
      } else if (selectedTransport === 'multi') {
        // Multi-transport setup (WebSocket + WebTorrent)
        const serverUrl = signalingUrl.value.trim();
        const roomNameValue = roomName.value.trim();
        
        if (!serverUrl && !roomNameValue) {
          throw new Error('Please enter at least one transport configuration');
        }
        
        const transportConfigs = [];
        
        if (serverUrl) {
          const additionalUrls = Array.from(document.querySelectorAll('.additional-server-url'))
            .map(input => input.value.trim())
            .filter(url => url);
          
          const allUrls = [serverUrl, ...additionalUrls];
          allUrls.forEach((url, index) => {
            transportConfigs.push({
              name: 'websocket',
              id: `websocket-${index}`,
              options: { signalingServerUrl: url }
            });
          });
        }
        
        if (roomNameValue) {
          const roomId = await generateDeterministicRoomId(roomNameValue);
          transportConfigs.push({
            name: 'webtorrent',
            id: 'webtorrent-0',
            options: { infoHash: roomId }
          });
        }
        
        statusEl.textContent = `Status: Connecting to ${transportConfigs.length} transports...`;
        
        meshConfig = {
          transportConfigs,
          maxPeers: 10
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
      addServerBtn.disabled = true;
      
      // Disable additional server inputs
      document.querySelectorAll('.additional-server-url').forEach(input => {
        input.disabled = true;
      });

      mesh.on('peer:connect', (peerId) => {
        addMessage(`Connected to peer: ${peerId}`, 'system');
        statusEl.textContent = `Status: Connected to peer ${peerId}. Mesh active.`;
        // Reset the disconnected state when a peer connects/reconnects
        disconnectedPeers.delete(peerId);
        updateConnectedPeersList();
        // FIXED: Force update transport info when peer connects
        setTimeout(updateTransportInfo, 500);
      });

      mesh.on('peer:disconnect', (peerId) => {
        // Add tracking to prevent duplicate disconnect messages
        if (!disconnectedPeers.has(peerId)) {
          disconnectedPeers.add(peerId);
          addMessage(`Disconnected from peer: ${peerId}`, 'system');
          statusEl.textContent = 'Status: Peer disconnected. Mesh active.';
          updateConnectedPeersList();
          // FIXED: Force update transport info when peer disconnects
          setTimeout(updateTransportInfo, 500);
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
      
      // FIXED: Initialize transport info display
      updateTransportInfo();
      
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
        addServerBtn.disabled = false;
        
        // Re-enable additional server inputs
        document.querySelectorAll('.additional-server-url').forEach(input => {
          input.disabled = false;
        });
        
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
      // FIXED: Also update transport info periodically
      updateTransportInfo();
    }
  }, 3000);
});
