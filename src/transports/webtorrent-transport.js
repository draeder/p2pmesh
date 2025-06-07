// src/transports/webtorrent-transport.js

import { InitiateTransport } from './transport-interface.js';
import { WebTorrentAdapter } from '../adapters/webtorrent-adapter.js';
import { loadWebTorrent } from '../utils/simple-peer-loader.js';

/**
 * WebTorrent Transport Layer
 * Implements peer-to-peer transport using WebTorrent's DHT and peer discovery.
 * Uses WebTorrent's SHA1-based peer IDs and swarms around a dummy torrent infoHash.
 */
export class WebTorrentTransport extends InitiateTransport {
  constructor(options = {}) {
    super({ ...options, transportType: 'webtorrent' });
    
    this.infoHash = options.infoHash || this.generateDefaultInfoHash();
    this.options = options;
    this.client = null;
    this.torrent = null;
    this.localPeerId = null;
    this.connectedPeers = new Map();
    this.pendingKademliaRpcs = new Map();
    this.isConnected = false;
    this._cryptoModule = null;
    
    // Create the WebTorrent adapter
    this.adapter = new WebTorrentAdapter(options);
    this.setupAdapterEventHandlers();
    
    this.CONNECTION_TIMEOUT = 15000;
  }

  /**
   * Generate a default info hash if none provided
   */
  generateDefaultInfoHash() {
    return '1234567890abcdef1234567890abcdef12345678';
  }

  /**
   * Sets up event handlers for the WebTorrent adapter
   */
  setupAdapterEventHandlers() {
    // Forward adapter events to transport events
    this.adapter.on('signal', (data) => {
      console.log(`WebTorrent: Received signal from ${data.from}`);
      this.emit('signal', data);
    });

    this.adapter.on('connect_request', (data) => {
      console.log(`WebTorrent: Received connect request from ${data.from}`);
      this.emit('connect_request', data);
    });

    this.adapter.on('peer_ready', (data) => {
      console.log(`WebTorrent: Peer ${data.peerId} is ready via WebTorrent wire protocol`);
      
      // Track the peer
      this.connectedPeers.set(data.peerId, true);
      
      // Clear any pending connection timeout since we have a wire connection
      this.clearConnectionTimeout(data.peerId, 'wire_connected');
      
      // Emit peer discovery event FIRST with transport info
      this.emit('peer_discovered', { 
        peerId: data.peerId, 
        address: data.peerId,
        transport: 'webtorrent',
        transportId: this._multiTransportId || 'webtorrent'
      });
      
      // Emit connect request to trigger WebRTC connection establishment
      console.log(`WebTorrent: Triggering WebRTC connection request for ${data.peerId}`);
      this.emit('connect_request', {
        from: data.peerId,
        transport: 'webtorrent',
        transportId: this._multiTransportId || 'webtorrent',
        wireConnected: true
      });
      
      // Then emit peer joined with transport info
      this.emit('peer_joined', { 
        peerId: data.peerId,
        transport: 'webtorrent',
        transportId: this._multiTransportId || 'webtorrent'
      });
      
      // Also emit as bootstrap peer
      this.emit('bootstrap_peers', { 
        peers: [{ id: data.peerId, address: data.peerId }] 
      });
    });

    this.adapter.on('peer_disconnected', (data) => {
      this.connectedPeers.delete(data.peerId);
      this.emit('peer_left', data);
    });

    this.adapter.on('kademlia_rpc_message', (data) => {
      this.emit('kademlia_rpc_message', data);
    });

    this.adapter.on('kademlia_rpc_reply', (data) => {
      const rpcId = data.rpcMessage?.inReplyTo;
      if (rpcId && this.pendingKademliaRpcs.has(rpcId)) {
        const { resolve } = this.pendingKademliaRpcs.get(rpcId);
        resolve(data.rpcMessage);
        this.pendingKademliaRpcs.delete(rpcId);
      }
    });

    this.adapter.on('connection_rejected', (data) => {
      this.emit('connection_rejected', data);
    });
  }

  /**
   * Dynamically loads WebTorrent based on environment
   */
  async _loadWebTorrent() {
    try {
      return await loadWebTorrent();
    } catch (e) {
      console.error('Failed to load WebTorrent via loader:', e);
      
      // Additional fallback attempts specific to transport
      try {
        console.log('WebTorrent: Attempting transport-specific fallback...');
        
        // Try to use any existing global WebTorrent
        if (typeof window !== 'undefined' && window.WebTorrent) {
          console.log('WebTorrent: Using existing global WebTorrent');
          return window.WebTorrent;
        }
        
        // Try manual script injection as last resort
        if (typeof window !== 'undefined') {
          console.log('WebTorrent: Attempting manual script injection...');
          
          return new Promise((resolve, reject) => {
            // Create a unique callback name
            const callbackName = `webTorrentCallback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            window[callbackName] = () => {
              if (window.WebTorrent) {
                delete window[callbackName];
                resolve(window.WebTorrent);
              } else {
                delete window[callbackName];
                reject(new Error('WebTorrent still not available after manual injection'));
              }
            };
            
            const script = document.createElement('script');
            script.innerHTML = `
              (function() {
                var script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/webtorrent@2.6.8/index.min.js';
                script.onload = function() {
                  setTimeout(function() {
                    if (window.${callbackName}) window.${callbackName}();
                  }, 100);
                };
                script.onerror = function() {
                  if (window.${callbackName}) {
                    delete window.${callbackName};
                  }
                };
                document.head.appendChild(script);
              })();
            `;
            
            document.head.appendChild(script);
            
            // Timeout after 10 seconds
            setTimeout(() => {
              if (window[callbackName]) {
                delete window[callbackName];
                reject(new Error('Manual WebTorrent injection timeout'));
              }
            }, 10000);
          });
        }
        
        throw new Error('No fallback options available');
      } catch (fallbackError) {
        console.error('Transport fallback also failed:', fallbackError);
        throw new Error(`WebTorrent could not be loaded: ${e.message}. Fallback failed: ${fallbackError.message}`);
      }
    }
  }

  /**
   * Dynamically loads crypto module based on environment
   */
  async _loadCrypto() {
    try {
      if (typeof window !== 'undefined') {
        // Browser environment - use Web Crypto API
        if (window.crypto && window.crypto.subtle) {
          return {
            randomBytes: (size) => {
              const array = new Uint8Array(size);
              window.crypto.getRandomValues(array);
              return Array.from(array);
            }
          };
        } else {
          throw new Error('Web Crypto API not available');
        }
      } else {
        // Node.js environment
        const crypto = await import('crypto');
        return crypto;
      }
    } catch (e) {
      console.error('Failed to load crypto module:', e);
      throw e;
    }
  }

  /**
   * Generates a truly unique peer ID for WebTorrent client
   * WebTorrent peer IDs are 20 bytes, but we need to ensure they're completely random
   * @returns {Buffer|Uint8Array} Unique peer ID
   */
  async _generateUniquePeerId() {
    try {
      // Create maximum entropy for peer ID generation
      const peerIdBytes = new Uint8Array(20);
      
      // Fill with cryptographically secure random bytes
      if (typeof window !== 'undefined') {
        // Browser environment - use Web Crypto API
        if (window.crypto && window.crypto.getRandomValues) {
          window.crypto.getRandomValues(peerIdBytes);
        } else {
          throw new Error('Web Crypto API not available');
        }
      } else {
        // Node.js environment
        const crypto = await import('crypto');
        const randomBytes = crypto.randomBytes(20);
        peerIdBytes.set(randomBytes);
      }
      
      // Add multiple sources of entropy to ensure absolute uniqueness
      const highResTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1000000;
      const randomSeed1 = Math.random() * 0xFFFFFFFF;
      const randomSeed2 = Math.random() * 0xFFFFFFFF;
      const processEntropy = typeof process !== 'undefined' ? process.hrtime ? process.hrtime()[1] : process.pid || 0 : 0;
      
      // Mix in additional entropy throughout the peer ID
      for (let i = 0; i < 20; i++) {
        const entropySource1 = ((highResTime + randomSeed1) >> (i * 3)) & 0xFF;
        const entropySource2 = ((processEntropy + randomSeed2) >> (i * 2)) & 0xFF;
        const entropySource3 = (Math.random() * 256) & 0xFF;
        
        // XOR multiple entropy sources with the random bytes
        peerIdBytes[i] ^= entropySource1 ^ entropySource2 ^ entropySource3;
      }
      
      // Ensure the first byte is never zero and varies significantly
      peerIdBytes[0] = (peerIdBytes[0] | 0x80) ^ ((Date.now() & 0xFF));
      
      console.log(`Generated truly unique peer ID bytes:`, Array.from(peerIdBytes.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(''));
      
      // Convert to Buffer for Node.js compatibility if possible
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(peerIdBytes);
      }
      
      return peerIdBytes;
    } catch (e) {
      console.error('Failed to generate unique peer ID:', e);
      // Enhanced fallback with maximum randomness
      const fallbackId = new Uint8Array(20);
      const timestamp = Date.now();
      const randomBase1 = Math.random() * 0xFFFFFFFF;
      const randomBase2 = Math.random() * 0xFFFFFFFF;
      
      for (let i = 0; i < 20; i++) {
        // Use multiple random sources for fallback
        const byte1 = ((timestamp + randomBase1) * (i + 1)) & 0xFF;
        const byte2 = ((randomBase2 + Math.random() * 256) * (i + 3)) & 0xFF;
        const byte3 = (Math.random() * 256) & 0xFF;
        fallbackId[i] = byte1 ^ byte2 ^ byte3;
      }
      
      // Ensure non-zero first byte
      fallbackId[0] = (fallbackId[0] | 0x80) ^ ((Date.now() & 0xFF));
      
      return fallbackId;
    }
  }

  /**
   * Converts a P2PMesh peer ID to 20-byte Buffer/Uint8Array for WebTorrent
   * @param {string} peerId - P2PMesh peer ID (hex string)
   * @returns {Buffer|Uint8Array} 20-byte peer ID for WebTorrent
   */
  _convertPeerIdToBytes(peerId) {
    try {
      // P2PMesh peer IDs are hex strings, convert to bytes
      const hexStr = peerId.replace(/[^0-9a-fA-F]/g, '');
      
      // Create a 20-byte array (WebTorrent standard)
      const peerIdBytes = new Uint8Array(20);
      
      // Fill the array with bytes from the hex string
      let bytesWritten = 0;
      for (let i = 0; i < hexStr.length && bytesWritten < 20; i += 2) {
        const byte = parseInt(hexStr.substr(i, 2), 16);
        peerIdBytes[bytesWritten] = byte;
        bytesWritten++;
      }
      
      // If we didn't fill all 20 bytes, pad with hash of the original peer ID
      if (bytesWritten < 20) {
        // Use a simple hash to fill remaining bytes
        let hash = 0;
        for (let i = 0; i < peerId.length; i++) {
          hash = ((hash << 5) - hash + peerId.charCodeAt(i)) & 0xffffffff;
        }
        
        // Fill remaining bytes with hash-derived values
        for (let i = bytesWritten; i < 20; i++) {
          peerIdBytes[i] = (hash + i * 7) & 0xFF;
          hash = (hash * 1103515245 + 12345) & 0xffffffff; // Simple LCG
        }
      }
      
      // Convert to Buffer for Node.js compatibility if possible
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(peerIdBytes);
      }
      
      return peerIdBytes;
    } catch (e) {
      console.error('Failed to convert peer ID to bytes:', e);
      // Fallback: create deterministic 20-byte ID from peer ID string
      const fallbackBytes = new Uint8Array(20);
      let hash = 0;
      for (let i = 0; i < peerId.length; i++) {
        hash = ((hash << 5) - hash + peerId.charCodeAt(i)) & 0xffffffff;
      }
      
      for (let i = 0; i < 20; i++) {
        fallbackBytes[i] = (hash + i * 13) & 0xFF;
        hash = (hash * 1103515245 + 12345) & 0xffffffff;
      }
      
      return fallbackBytes;
    }
  }

  /**
   * Connects to the WebTorrent network and starts swarming around the infoHash
   * @param {string} localPeerId - Peer ID from P2PMesh - WILL BE USED as WebTorrent peer ID
   * @param {object} options - Additional connection options
   */
  async connect(localPeerId, options = {}) {
    // Call parent connect to start cleanup timer
    await super.connect(localPeerId).catch(() => {}); // Ignore the "must be implemented" error
    
    return new Promise(async (resolve, reject) => {
      try {
        console.log(`WebTorrent: Loading WebTorrent library...`);
        
        const WebTorrent = await this._loadWebTorrent();
        
        // Validate that WebTorrent is actually a constructor
        if (!WebTorrent || typeof WebTorrent !== 'function') {
          throw new Error('WebTorrent is not a valid constructor function');
        }
        
        this._cryptoModule = await this._loadCrypto();
        
        const p2pmeshPeerIdBytes = this._convertPeerIdToBytes(localPeerId);
        
        console.log(`Using P2PMesh peer ID: ${localPeerId}`);
        console.log(`Converted to bytes:`, Array.from(p2pmeshPeerIdBytes.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(''));
        
        this.adapter.setLocalPeerId(localPeerId);
        
        // Force maximum uniqueness by adding more entropy sources
        const instanceId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Create WebTorrent client with P2PMesh peer ID and better options
        const clientOptionsWithPeerId = {
          ...this.options,
          peerId: p2pmeshPeerIdBytes,
          nodeId: p2pmeshPeerIdBytes,
          userAgent: `P2PMesh-${instanceId}`,
          downloadLimit: -1,
          uploadLimit: -1,
          maxConns: 50, // Reduced from 200+ to avoid overwhelming
          // Remove DHT options that might cause issues
          dht: true,
          // Add tracker options
          tracker: {
            announce: [
              'wss://tracker.webtorrent.io',
              'wss://tracker.openwebtorrent.com'
            ]
          }
        };
        
        console.log(`Creating WebTorrent client with P2PMesh peer ID: ${localPeerId}`);
        
        try {
          this.client = new WebTorrent(clientOptionsWithPeerId);
        } catch (constructorError) {
          console.error('WebTorrent constructor failed:', constructorError);
          
          // Try with minimal options
          console.log('WebTorrent: Trying with minimal options...');
          this.client = new WebTorrent({
            peerId: p2pmeshPeerIdBytes,
            dht: true
          });
        }
        
        // Use the P2PMesh peer ID as the final peer ID (as a string)
        this.localPeerId = localPeerId;
        
        // Override WebTorrent's properties with our peer ID
        try {
          this.client.peerId = p2pmeshPeerIdBytes;
          this.client.nodeId = p2pmeshPeerIdBytes;
          if (this.client.dht) {
            this.client.dht.nodeId = p2pmeshPeerIdBytes;
          }
          
          console.log(`Successfully forced WebTorrent to use P2PMesh peer ID: ${localPeerId}`);
        } catch (e) {
          console.warn(`Failed to override WebTorrent peer ID properties:`, e.message);
        }
        
        console.log(`WebTorrent client created with P2PMesh peer ID: ${this.localPeerId}`);
        
        this.client.on('error', (err) => {
          console.error('WebTorrent client error:', err);
          this.emit('error', err);
        });
        
        // Listen for torrent events at the client level for better peer discovery
        this.client.on('torrent', (torrent) => {
          console.log(`WebTorrent: Torrent added: ${torrent.infoHash}`);
          
          // Set up torrent-level wire handling - delegate to adapter
          torrent.on('wire', (wire) => {
            console.log(`WebTorrent: New wire connection from client-level torrent event`);
            this.adapter.handleNewWire(wire, this._formatPeerId(wire.peerId));
          });
          
          // Periodically check for new peers
          const peerCheckInterval = setInterval(() => {
            if (torrent.wires && torrent.wires.length > 0) {
              console.log(`WebTorrent: Active wires: ${torrent.wires.length}`);
              torrent.wires.forEach((wire) => {
                const formattedPeerId = this._formatPeerId(wire.peerId);
                if (!this.connectedPeers.has(formattedPeerId)) {
                  this.adapter.handleNewWire(wire, formattedPeerId);
                }
              });
            }
          }, 2000);
          
          // Clean up interval when torrent is destroyed
          torrent.on('destroy', () => {
            clearInterval(peerCheckInterval);
          });
        });

        // Start seeding/downloading a dummy torrent with the specified infoHash
        this.addDummyTorrent()
          .then(() => {
            console.log(`Joined WebTorrent swarm for infoHash: ${this.infoHash}`);
            this.isConnected = true;
            this.emit('open');
            resolve();
          })
          .catch((err) => {
            console.error('Failed to add dummy torrent:', err);
            reject(err);
          });

        // Timeout after 15 seconds - fail if not connected
        setTimeout(() => {
          if (!this.isConnected) {
            const timeoutError = new Error('WebTorrent connection timeout - failed to join swarm');
            console.error('WebTorrent:', timeoutError.message);
            reject(timeoutError);
          }
        }, 15000);

      } catch (error) {
        console.error('Failed to create WebTorrent client:', error);
        reject(error);
      }
    });
  }

  /**
   * Adds a dummy torrent to the WebTorrent client for the specified infoHash
   */
  async addDummyTorrent() {
    return new Promise((resolve, reject) => {
      try {
        // Create a magnet URI with the exact infoHash we want to join (optimized with more trackers)
        const magnetURI = `magnet:?xt=urn:btih:${this.infoHash}&dn=p2pmesh-room-${this.infoHash.substring(0, 8)}&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.opentrackr.org:1337&tr=wss://tracker.btorrent.xyz&tr=wss://tracker.openwebtorrent.com&tr=udp://tracker.internetwarriors.net:6969&tr=udp://tracker.leechers-paradise.org:6969&tr=wss://tracker.webtorrent.io&tr=udp://explodie.org:6969`;
        
        console.log(`WebTorrent: Joining swarm via magnet URI: ${magnetURI}`);
        
        // Try to join the swarm using the magnet URI
        this.torrent = this.client.add(magnetURI);
        
        let fallbackTriggered = false;
        
        // Handle torrent events
        this.torrent.on('ready', () => {
          console.log(`WebTorrent: Successfully joined swarm!`);
          console.log(`WebTorrent: InfoHash: ${this.torrent.infoHash}`);
          console.log(`WebTorrent: Magnet URI: ${this.torrent.magnetURI}`);
          resolve();
        });

        this.torrent.on('wire', (wire) => {
          console.log(`WebTorrent: New peer connected to swarm`);
          this.adapter.handleNewWire(wire, this._formatPeerId(wire.peerId));
        });

        this.torrent.on('error', (err) => {
          console.log(`WebTorrent: Could not join existing swarm (${err.message}), creating new one...`);
          
          if (!fallbackTriggered) {
            fallbackTriggered = true;
            this.createAndSeedNewTorrent().then(resolve).catch(reject);
          }
        });

        // If no peers found after 3 seconds, try to seed our own torrent (reduced from 5 seconds)
        setTimeout(() => {
          if (!fallbackTriggered && (!this.torrent.ready || this.torrent.wires.length === 0)) {
            fallbackTriggered = true;
            console.log('WebTorrent: No existing peers found, seeding new torrent...');
            this.createAndSeedNewTorrent().then(resolve).catch(reject);
          }
        }, 3000);

      } catch (error) {
        console.error('WebTorrent: Error in addDummyTorrent:', error);
        // Fall back to creating our own torrent
        this.createAndSeedNewTorrent().then(resolve).catch(reject);
      }
    });
  }

  /**
   * Creates and seeds a new torrent with deterministic content
   */
  async createAndSeedNewTorrent() {
    return new Promise((resolve, reject) => {
      try {
        // Create deterministic content so all peers create the same torrent
        const roomData = `P2PMesh-Room-${this.infoHash}`;
        const fileName = `p2pmesh-${this.infoHash.substring(0, 8)}.txt`;
        
        let file;
        if (typeof window !== 'undefined') {
          // Browser environment
          const encoder = new TextEncoder();
          const fileData = encoder.encode(roomData);
          file = new File([fileData], fileName, { type: 'text/plain' });
        } else {
          // Node.js environment
          const fileData = Buffer.from(roomData, 'utf8');
          file = {
            name: fileName,
            path: fileName,
            length: fileData.length,
            createReadStream: () => {
              // Use dynamic import to avoid browser errors
              return import('stream').then(({ Readable }) => {
                const stream = new Readable();
                stream.push(fileData);
                stream.push(null);
                return stream;
              });
            }
          };
        }

        // Seed the file with deterministic options
        console.log(`WebTorrent: Seeding new torrent for room ${this.infoHash.substring(0, 8)}...`);
        this.torrent = this.client.seed([file], {
          name: `p2pmesh-${this.infoHash.substring(0, 8)}`,
          comment: `P2PMesh room ${this.infoHash}`,
          private: false,
          announceList: [
            ['udp://tracker.openbittorrent.com:80'],
            ['udp://tracker.opentrackr.org:1337'],
            ['wss://tracker.btorrent.xyz'],
            ['wss://tracker.openwebtorrent.com'],
            ['udp://tracker.internetwarriors.net:1337'],
            ['udp://tracker.leechers-paradise.org:6969'],
            ['wss://tracker.webtorrent.io'],
            ['udp://explodie.org:6969']
          ]
        });

        // Handle torrent events
        this.torrent.on('ready', () => {
          console.log(`WebTorrent: New torrent seeded successfully!`);
          console.log(`WebTorrent: Generated InfoHash: ${this.torrent.infoHash}`);
          console.log(`WebTorrent: Target InfoHash: ${this.infoHash}`);
          console.log(`WebTorrent: Magnet URI: ${this.torrent.magnetURI}`);
          
          // Update our infoHash to match the generated torrent
          console.log(`WebTorrent: Updating infoHash from ${this.infoHash} to ${this.torrent.infoHash}`);
          this.infoHash = this.torrent.infoHash;
          
          resolve();
        });

        this.torrent.on('wire', (wire) => {
          console.log(`WebTorrent: New peer connected to our seeded torrent`);
          this.adapter.handleNewWire(wire, this._formatPeerId(wire.peerId));
        });

        this.torrent.on('error', (err) => {
          console.error('WebTorrent seeding error:', err);
          reject(err);
        });

        // Set a timeout for torrent readiness (reduced for faster startup)
        setTimeout(() => {
          if (!this.torrent || !this.torrent.ready) {
            console.log('WebTorrent: Seeding timeout, but continuing anyway');
            resolve();
          }
        }, 5000);

      } catch (error) {
        console.error('WebTorrent: Error creating and seeding new torrent:', error);
        reject(error);
      }
    });
  }

  /**
   * Disconnects from the WebTorrent network
   */
  async disconnect() {
    // Call parent disconnect for cleanup
    await super.disconnect().catch(() => {}); // Ignore the "must be implemented" error
    
    return new Promise((resolve) => {
      this.isConnected = false;

      if (this.adapter) {
        this.adapter.disconnect();
      }

      if (this.torrent) {
        this.torrent.destroy(() => {
          console.log('WebTorrent torrent destroyed');
        });
        this.torrent = null;
      }

      if (this.client) {
        this.client.destroy(() => {
          console.log('WebTorrent client destroyed');
          this.emit('close');
          resolve();
        });
        this.client = null;
      } else {
        resolve();
      }

      this.connectedPeers.clear();
      this.pendingKademliaRpcs.clear();
    });
  }

  /**
   * Sends a message to a specific peer via WebTorrent wire protocol
   */
  send(toPeerId, message) {
    if (!this.adapter) {
      console.warn(`WebTorrent: Adapter not available`);
      return false;
    }

    return this.adapter.send(toPeerId, message);
  }

  /**
   * Sends a Kademlia RPC message and waits for a reply
   */
  async sendKademliaRpc(toPeerId, kademliaRpcMessage) {
    if (!this.adapter) {
      throw new Error('WebTorrent adapter not available');
    }

    // Use the adapter but also track the pending RPC for timeout handling
    const rpcId = this.generateRpcId();
    const timeoutMs = 5000;

    // Store the pending RPC in transport for consistency
    const timeout = setTimeout(() => {
      this.pendingKademliaRpcs.delete(rpcId);
    }, timeoutMs);

    this.pendingKademliaRpcs.set(rpcId, {
      resolve: (reply) => {
        clearTimeout(timeout);
      },
      reject: (error) => {
        clearTimeout(timeout);
      }
    });

    // Add rpcId to the message if not present
    const messageWithRpcId = {
      ...kademliaRpcMessage,
      rpcId: rpcId
    };

    try {
      const result = await this.adapter.sendKademliaRpc(toPeerId, messageWithRpcId);
      this.pendingKademliaRpcs.delete(rpcId);
      clearTimeout(timeout);
      return result;
    } catch (error) {
      this.pendingKademliaRpcs.delete(rpcId);
      clearTimeout(timeout);
      throw error;
    }
  }

  /**
   * Gets the address information for a peer (WebTorrent peer ID)
   */
  getPeerAddress(peerId) {
    return peerId; // WebTorrent peer ID is the address
  }

  /**
   * Generates a unique RPC ID for Kademlia messages
   */
  generateRpcId() {
    if (this._cryptoModule && this._cryptoModule.randomBytes) {
      // Node.js environment
      return this._cryptoModule.randomBytes(16).toString('hex');
    } else if (this._cryptoModule && this._cryptoModule.randomBytes) {
      // Browser environment with our custom randomBytes
      const bytes = this._cryptoModule.randomBytes(16);
      return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      // Fallback to simple random generation
      console.warn('Crypto module not loaded, using fallback RPC ID generation');
      return Math.random().toString(36).substr(2, 16) + Math.random().toString(36).substr(2, 16);
    }
  }

  /**
   * Gets current connection statistics
   */
  getStats() {
    return {
      isConnected: this.isConnected,
      peerId: this.localPeerId,
      infoHash: this.infoHash,
      connectedPeers: this.connectedPeers.size,
      pendingRpcs: this.pendingKademliaRpcs.size,
      torrentStats: this.torrent ? {
        numPeers: this.torrent.numPeers,
        downloaded: this.torrent.downloaded,
        uploaded: this.torrent.uploaded
      } : null
    };
  }

  /**
   * Discovers peers through WebTorrent's DHT and swarm
   */
  discoverPeers(bootstrapUrls = []) {
    console.log(`WebTorrent: discoverPeers() called - checking WebTorrent client state`);
    
    if (!this.client) {
      console.warn('WebTorrent: Cannot discover peers, client not initialized');
      return;
    }
    
    if (!this.torrent) {
      console.warn('WebTorrent: Cannot discover peers, not connected to swarm');
      return;
    }

    // WebTorrent automatically discovers peers through DHT and trackers
    console.log(`WebTorrent: Active peer discovery through DHT and swarm`);
    console.log(`WebTorrent: Current swarm size: ${this.torrent.wires ? this.torrent.wires.length : 0} peers`);
    
    // Check for active wires and emit them as discovered peers
    if (this.torrent.wires && this.torrent.wires.length > 0) {
      console.log(`WebTorrent: Found ${this.torrent.wires.length} active wires, processing as discovered peers`);
      
      this.torrent.wires.forEach((wire) => {
        const formattedPeerId = this._formatPeerId(wire.peerId);
        if (formattedPeerId && formattedPeerId !== this.localPeerId) {
          console.log(`WebTorrent: Processing wire ${formattedPeerId} for WebRTC connection`);
          
          // Start connection timeout tracking
          this.startConnectionTimeout(formattedPeerId, {
            initiator: true,
            reason: 'wire_discovery'
          });
          
          // Emit peer discovery event with transport info
          this.emit('peer_discovered', { 
            peerId: formattedPeerId, 
            address: formattedPeerId,
            transport: 'webtorrent',
            transportId: this._multiTransportId || 'webtorrent'
          });
          
          // Emit connect request to trigger WebRTC establishment
          console.log(`WebTorrent: Emitting connect_request for wire peer ${formattedPeerId}`);
          this.emit('connect_request', {
            from: formattedPeerId,
            transport: 'webtorrent',
            transportId: this._multiTransportId || 'webtorrent',
            wireConnected: true
          });
          
          // Make sure the adapter handles this wire if it hasn't already
          if (!this.adapter.hasPeer(formattedPeerId)) {
            this.adapter.handleNewWire(wire, formattedPeerId);
          }
        }
      });
    }
    
    // Emit current connected peers as discovered and trigger connections
    const currentPeers = Array.from(this.connectedPeers.keys()).map(peerId => {
      const formattedPeerId = this._formatPeerId(peerId);
      return formattedPeerId;
    }).filter(Boolean);
    
    if (currentPeers.length > 0) {
      console.log(`WebTorrent: Processing ${currentPeers.length} connected peers for WebRTC:`, currentPeers.slice(0, 3).map(p => p.substring(0, 8)));
      
      // Emit as individual peer discovery events and connection requests
      currentPeers.forEach(peerId => {
        // Start connection timeout tracking
        this.startConnectionTimeout(peerId, {
          initiator: true,
          reason: 'connected_peer_discovery'
        });
        
        this.emit('peer_discovered', { 
          peerId: peerId, 
          address: peerId,
          transport: 'webtorrent',
          transportId: this._multiTransportId || 'webtorrent'
        });
        
        // Emit connect request for WebRTC establishment
        console.log(`WebTorrent: Emitting connect_request for connected peer ${peerId}`);
        this.emit('connect_request', {
          from: peerId,
          transport: 'webtorrent',
          transportId: this._multiTransportId || 'webtorrent',
          wireConnected: true
        });
      });
      
      // Also emit as bootstrap batch
      this.emit('bootstrap_peers', { 
        peers: currentPeers.map(peerId => ({ 
          id: peerId, 
          address: peerId 
        }))
      });
    }
    
    // Also emit adapter's connected peers with transport info and connection requests
    const adapterPeers = this.adapter.getConnectedPeers();
    if (adapterPeers.length > 0) {
      console.log(`WebTorrent: Processing ${adapterPeers.length} adapter peers for WebRTC:`, adapterPeers.slice(0, 3).map(p => p.substring(0, 8)));
      
      adapterPeers.forEach(peerId => {
        // Start connection timeout tracking
        this.startConnectionTimeout(peerId, {
          initiator: true,
          reason: 'adapter_peer_discovery'
        });
        
        this.emit('peer_discovered', { 
          peerId: peerId, 
          address: peerId,
          transport: 'webtorrent',
          transportId: this._multiTransportId || 'webtorrent'
        });
        
        // Emit connect request for WebRTC establishment
        console.log(`WebTorrent: Emitting connect_request for adapter peer ${peerId}`);
        this.emit('connect_request', {
          from: peerId,
          transport: 'webtorrent',
          transportId: this._multiTransportId || 'webtorrent',
          wireConnected: true
        });
      });
    }
    
    // Force torrent to re-announce to trackers
    if (this.torrent && this.torrent.discovery) {
      try {
        // Check what methods are available on the discovery object
        if (typeof this.torrent.discovery.updateInterest === 'function') {
          this.torrent.discovery.updateInterest();
          console.log(`WebTorrent: Forced re-announce to trackers via discovery.updateInterest`);
        } else if (typeof this.torrent.discovery.announce === 'function') {
          this.torrent.discovery.announce();
          console.log(`WebTorrent: Forced re-announce to trackers via discovery.announce`);
        } else {
          console.log(`WebTorrent: No specific discovery methods available, torrent will use default discovery`);
        }
      } catch (e) {
        console.warn(`WebTorrent: Failed to force re-announce via discovery:`, e.message);
      }
    } else if (this.torrent && typeof this.torrent.announce === 'function') {
      try {
        this.torrent.announce();
        console.log(`WebTorrent: Forced announce to trackers`);
      } catch (e) {
        console.warn(`WebTorrent: Failed to force announce:`, e.message);
      }
    }
  }

  /**
   * Formats a WebTorrent peer ID to P2PMesh-compatible format
   */
  _formatPeerId(peerId) {
    if (!peerId) return null;
    
    let formattedPeerId = peerId;
    
    // Convert Buffer or Uint8Array to hex string if needed
    if (typeof peerId !== 'string') {
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(peerId)) {
        formattedPeerId = peerId.toString('hex');
      } else if (peerId instanceof Uint8Array) {
        formattedPeerId = Array.from(peerId).map(b => b.toString(16).padStart(2, '0')).join('');
      } else if (Array.isArray(peerId)) {
        formattedPeerId = Array.from(peerId).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        formattedPeerId = String(peerId);
      }
    }
    
    // Ensure the peer ID is exactly 40 characters (20 bytes) for P2PMesh compatibility
    if (formattedPeerId.length < 40) {
      // Pad with zeros if too short
      formattedPeerId = formattedPeerId.padEnd(40, '0');
    } else if (formattedPeerId.length > 40) {
      // Truncate if too long
      formattedPeerId = formattedPeerId.substring(0, 40);
    }
    
    return formattedPeerId;
  }

  /**
   * Gets connected peers with transport information
   */
  getConnectedPeersWithTransport() {
    return Array.from(this.connectedPeers.keys()).map(peerId => ({
      peerId,
      transport: 'webtorrent',
      transportId: this._multiTransportId || 'webtorrent',
      address: peerId
    }));
  }

  /**
   * Check if a specific peer is connected via this transport
   */
  hasPeerConnected(peerId) {
    return this.connectedPeers.has(peerId);
  }
}
