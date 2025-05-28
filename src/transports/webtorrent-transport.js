// src/transports/webtorrent-transport.js

import { AbstractTransport } from './transport-interface.js';

/**
 * WebTorrent Transport Layer
 * Implements the AbstractTransport interface using WebTorrent's DHT and peer discovery.
 * Uses WebTorrent's SHA1-based peer IDs and swarms around a dummy torrent infoHash.
 */
export class WebTorrentTransport extends AbstractTransport {
  /**
   * @param {string} infoHash - The torrent infoHash to swarm around (acts as room ID)
   * @param {object} options - WebTorrent client options
   */
  constructor(infoHash, options = {}) {
    super();
    
    if (!infoHash) {
      throw new Error('WebTorrentTransport requires an infoHash (room ID).');
    }
    
    this.infoHash = infoHash;
    this.options = options;
    this.client = null;
    this.torrent = null;
    this.localPeerId = null;
    this.connectedPeers = new Map(); // peerId -> wire
    this.pendingKademliaRpcs = new Map(); // For tracking Kademlia RPC replies
    this.sentHellos = new Set(); // Track peers we've sent hello messages to
    this.isConnected = false;
    this._cryptoModule = null; // Cache for crypto module
    
    // WebTorrent-specific settings with forced randomness
    this.clientOptions = {
      dht: true,
      tracker: true,
      // Force random ports to avoid conflicts
      port: 0,
      dhtPort: 0,
      // Disable any caching that might cause ID reuse
      maxConns: 200,
      // Add random identifier to force uniqueness
      _p2pmeshInstance: Math.random().toString(36),
      ...options
    };
    
    console.log(`WebTorrentTransport initialized for infoHash: ${infoHash}`);
  }

  /**
   * Dynamically loads WebTorrent based on environment
   */
  async _loadWebTorrent() {
    try {
      if (typeof window !== 'undefined') {
        // Browser environment - try to import from CDN or bundled version
        if (window.WebTorrent) {
          return window.WebTorrent;
        }
        
        // Try dynamic import for bundled version
        try {
          const module = await import('webtorrent');
          return module.default || module;
        } catch (e) {
          console.warn('Failed to dynamically import WebTorrent, trying global:', e.message);
          
          // Fallback: load from CDN if not available
          if (!window.WebTorrent) {
            throw new Error('WebTorrent is not available. Please include WebTorrent script or install the package.');
          }
          return window.WebTorrent;
        }
      } else {
        // Node.js environment
        try {
          const module = await import('webtorrent');
          return module.default || module;
        } catch (e) {
          console.error('Failed to load WebTorrent in Node.js environment:', e.message);
          throw new Error('WebTorrent package not installed. Run: npm install webtorrent');
        }
      }
    } catch (e) {
      console.error('Failed to load WebTorrent:', e);
      throw e;
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
    return new Promise(async (resolve, reject) => {
      try {
        // Load WebTorrent dynamically
        const WebTorrent = await this._loadWebTorrent();
        
        // Load and cache crypto module
        this._cryptoModule = await this._loadCrypto();
        
        // Convert P2PMesh peer ID to 20-byte Buffer/Uint8Array for WebTorrent
        const p2pmeshPeerIdBytes = this._convertPeerIdToBytes(localPeerId);
        
        console.log(`Using P2PMesh peer ID: ${localPeerId}`);
        console.log(`Converted to bytes:`, Array.from(p2pmeshPeerIdBytes.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(''));
        
        // Force maximum uniqueness by adding more entropy sources
        const instanceId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Create WebTorrent client with P2PMesh peer ID
        const clientOptionsWithPeerId = {
          ...this.clientOptions,
          peerId: p2pmeshPeerIdBytes,
          // Add additional options to force uniqueness
          nodeId: p2pmeshPeerIdBytes, // Some versions use nodeId instead of peerId
          port: 0, // Use random port
          dhtPort: 0, // Use random DHT port
          // Add random user agent to further differentiate instances
          userAgent: `P2PMesh-${instanceId}`,
          // Add more random options to force different client instances
          downloadLimit: -1,
          uploadLimit: -1,
          maxConns: 200 + Math.floor(Math.random() * 100), // Randomize max connections
          // Force random DHT bootstrap nodes order
          dhtBootstrap: [
            'router.bittorrent.com:6881',
            'dht.transmissionbt.com:6881'
          ].sort(() => Math.random() - 0.5)
        };
        
        console.log(`Creating WebTorrent client with P2PMesh peer ID: ${localPeerId}`);
        
        this.client = new WebTorrent(clientOptionsWithPeerId);
        
        // FORCE our P2PMesh peer ID - override WebTorrent's generated one
        console.log(`Forcing WebTorrent to use P2PMesh peer ID: ${localPeerId}`);
        
        // Use the P2PMesh peer ID as the final peer ID (as a string)
        this.localPeerId = localPeerId;
        
        // Override WebTorrent's properties with our peer ID
        try {
          // Force all possible peer ID properties
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
          
          // Set up torrent-level wire handling
          torrent.on('wire', (wire) => {
            console.log(`WebTorrent: New wire connection from client-level torrent event`);
            this.handleNewWire(wire);
          });
          
          // Periodically check for new peers
          const peerCheckInterval = setInterval(() => {
            if (torrent.wires && torrent.wires.length > 0) {
              console.log(`WebTorrent: Active wires: ${torrent.wires.length}`);
              torrent.wires.forEach((wire) => {
                if (wire.peerId && !this.connectedPeers.has(this._formatPeerId(wire.peerId))) {
                  console.log(`WebTorrent: Found new peer via periodic check`);
                  this.handleNewWire(wire);
                }
              });
            }
          }, 5000);
          
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
            this.emit('error', err);
            reject(err);
          });

        // Timeout after 20 seconds
        setTimeout(() => {
          if (!this.isConnected) {
            console.log('WebTorrent: Connection timeout, but proceeding with transport');
            // Don't reject, just mark as connected and proceed
            this.isConnected = true;
            this.emit('open');
            resolve();
          }
        }, 20000);

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
        // Create a magnet URI with the exact infoHash we want to join
        const magnetURI = `magnet:?xt=urn:btih:${this.infoHash}&dn=p2pmesh-room-${this.infoHash.substring(0, 8)}&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.opentrackr.org:1337&tr=wss://tracker.btorrent.xyz&tr=wss://tracker.openwebtorrent.com`;
        
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
          this.handleNewWire(wire);
        });

        this.torrent.on('error', (err) => {
          console.log(`WebTorrent: Could not join existing swarm (${err.message}), creating new one...`);
          
          if (!fallbackTriggered) {
            fallbackTriggered = true;
            this.createAndSeedNewTorrent().then(resolve).catch(reject);
          }
        });

        // If no peers found after 5 seconds, try to seed our own torrent
        setTimeout(() => {
          if (!fallbackTriggered && (!this.torrent.ready || this.torrent.wires.length === 0)) {
            fallbackTriggered = true;
            console.log('WebTorrent: No existing peers found, seeding new torrent...');
            this.createAndSeedNewTorrent().then(resolve).catch(reject);
          }
        }, 5000);

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
          const fileData = this.createBuffer(roomData, 'utf8');
          file = {
            name: fileName,
            path: fileName,
            length: fileData.length,
            createReadStream: () => {
              const { Readable } = require('stream');
              const stream = new Readable();
              stream.push(fileData);
              stream.push(null);
              return stream;
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
            ['wss://tracker.openwebtorrent.com']
          ]
        });

        // Handle torrent events
        this.torrent.on('ready', () => {
          console.log(`WebTorrent: New torrent seeded successfully!`);
          console.log(`WebTorrent: Generated InfoHash: ${this.torrent.infoHash}`);
          console.log(`WebTorrent: Target InfoHash: ${this.infoHash}`);
          console.log(`WebTorrent: Magnet URI: ${this.torrent.magnetURI}`);
          
          // FIXED: Update our infoHash to match the generated torrent
          // This ensures all peers with the same room name will use the same actual infoHash
          console.log(`WebTorrent: Updating infoHash from ${this.infoHash} to ${this.torrent.infoHash}`);
          this.infoHash = this.torrent.infoHash;
          
          resolve();
        });

        this.torrent.on('wire', (wire) => {
          console.log(`WebTorrent: New peer connected to our seeded torrent`);
          this.handleNewWire(wire);
        });

        this.torrent.on('error', (err) => {
          console.error('WebTorrent seeding error:', err);
          reject(err);
        });

        // Set a timeout for torrent readiness
        setTimeout(() => {
          if (!this.torrent || !this.torrent.ready) {
            console.log('WebTorrent: Seeding timeout, but continuing anyway');
            resolve();
          }
        }, 10000);

      } catch (error) {
        console.error('WebTorrent: Error creating and seeding new torrent:', error);
        reject(error);
      }
    });
  }

  /**
   * Creates a simple dummy torrent for the P2P mesh room
   */
  async createSimpleDummyTorrent() {
    try {
      // Create a minimal file for the torrent
      const fileName = `p2pmesh-room-${this.infoHash.substring(0, 8)}.txt`;
      const fileContent = `P2PMesh room: ${this.infoHash}\nCreated: ${new Date().toISOString()}`;
      
      let fileData;
      if (typeof Buffer !== 'undefined') {
        // Node.js environment
        fileData = Buffer.from(fileContent, 'utf8');
      } else {
        // Browser environment
        const encoder = new TextEncoder();
        fileData = encoder.encode(fileContent);
      }

      // Create a simple File object for WebTorrent
      let file;
      if (typeof window !== 'undefined' && typeof File !== 'undefined') {
        // Browser environment
        file = new File([fileData], fileName, { type: 'text/plain' });
      } else {
        // Node.js environment - create a file-like object
        file = {
          name: fileName,
          length: fileData.length,
          createReadStream: () => {
            // Return a readable stream for Node.js
            const { Readable } = require('stream');
            const stream = new Readable();
            stream.push(fileData);
            stream.push(null);
            return stream;
          }
        };
      }

      return file;
    } catch (error) {
      console.error('Error creating dummy torrent:', error);
      throw error;
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
   * Handles new wire connections from WebTorrent
   */
  handleNewWire(wire) {
    let remotePeerId = this._formatPeerId(wire.peerId);
    
    if (!remotePeerId || remotePeerId === this.localPeerId) {
      if (!remotePeerId) {
        console.log(`WebTorrent: Generating temporary peer ID for wire without peer ID`);
        remotePeerId = this.generateTempPeerId();
      } else {
        console.log(`WebTorrent: Ignoring wire to self`);
        return;
      }
    }

    // Check if we already have this peer
    if (this.connectedPeers.has(remotePeerId)) {
      console.log(`WebTorrent: Already have connection to peer ${remotePeerId}, ignoring duplicate wire`);
      return;
    }

    console.log(`WebTorrent: New wire connection from peer: ${remotePeerId}`);
    
    // Store the wire connection
    this.connectedPeers.set(remotePeerId, wire);

    // Set up wire event handlers
    wire.on('close', () => {
      console.log(`WebTorrent: Wire closed for peer: ${remotePeerId}`);
      this.connectedPeers.delete(remotePeerId);
      this.sentHellos.delete(remotePeerId);
      this.emit('peer_left', { peerId: remotePeerId });
    });

    wire.on('error', (err) => {
      console.error(`WebTorrent: Wire error for peer ${remotePeerId}:`, err);
      this.connectedPeers.delete(remotePeerId);
      this.sentHellos.delete(remotePeerId);
    });

    // Handle extended protocol for P2PMesh messages
    this.setupExtendedProtocol(wire, remotePeerId);

    // Emit peer joined event - this will be picked up by P2PMesh's transport handlers
    this.emit('peer_joined', { peerId: remotePeerId });
    
    // Also emit as bootstrap peers for P2PMesh's Kademlia bootstrapping
    this.emit('bootstrap_peers', { 
      peers: [{ id: remotePeerId, address: remotePeerId }] 
    });
  }

  /**
   * Generates a temporary peer ID if one is not available (P2PMesh compatible format)
   */
  generateTempPeerId() {
    // Generate a 40-character hex string (20 bytes) compatible with P2PMesh
    const randomBytes = new Uint8Array(20);
    
    if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
      // Browser environment
      window.crypto.getRandomValues(randomBytes);
    } else {
      // Fallback random generation
      for (let i = 0; i < 20; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    
    return Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Sets up BitTorrent extended protocol for P2PMesh messages
   */
  setupExtendedProtocol(wire, remotePeerId) {
    const extensionName = 'p2pmesh';
    
    try {
      console.log(`WebTorrent: Setting up extension protocol with ${remotePeerId}`);
      
      // Create a proper WebTorrent extension constructor
      const self = this;
      function P2PMeshExtension(wire) {          // Handle incoming extension messages
          this.onMessage = function(buf) {
            try {
              // Log receiving message without exposing content
              console.log(`WebTorrent: Received raw extension message from ${remotePeerId}, length: ${buf?.length || 0} bytes`);
              
              // Convert buffer to string with proper encoding
              let messageStr;
              if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buf)) {
                messageStr = buf.toString('utf8');
              } else if (buf instanceof Uint8Array) {
                messageStr = new TextDecoder('utf8').decode(buf);
              } else {
                messageStr = buf.toString();
              }
              
              // Clean up the message string - remove any null bytes or extra characters
              messageStr = messageStr.trim().replace(/\0/g, '');
              
              // Find the JSON part if there are extra bytes
              let jsonStart = messageStr.indexOf('{');
              let jsonEnd = messageStr.lastIndexOf('}');
              
              if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                messageStr = messageStr.substring(jsonStart, jsonEnd + 1);
              }
              
              // Parse the message without logging the full content
              const message = JSON.parse(messageStr);
              console.log(`WebTorrent: Parsed extension message from ${remotePeerId}, type: ${message.type || 'unknown'}`);
              self.handleP2PMeshMessage(remotePeerId, message);
            } catch (error) {
              console.error(`Failed to parse P2PMesh message from ${remotePeerId}:`, error.message);
              // Don't log the raw buffer content to avoid leaking sensitive data
              console.error(`Error occurred while processing a ${buf?.length || 0}-byte message`);
            }
          };
        
        // Send method for the extension
        this.send = function(message) {
          try {
            // Log only the message type, not the full content
            console.log(`WebTorrent: Sending extension message to ${remotePeerId}, type: ${message.type || 'unknown'}`);
            
            const messageText = JSON.stringify(message);
            let messageBuffer;
            
            if (typeof Buffer !== 'undefined') {
              messageBuffer = Buffer.from(messageText, 'utf8');
            } else {
              const encoder = new TextEncoder();
              messageBuffer = encoder.encode(messageText);
            }
            
            console.log(`WebTorrent: Prepared message buffer for ${remotePeerId}, length: ${messageBuffer.length} bytes`);
            
            wire.extended(extensionName, messageBuffer);
            console.log(`WebTorrent: Extension message sent to ${remotePeerId}`);
          } catch (error) {
            console.error(`WebTorrent: Failed to send extension message:`, error.message);
          }
        };
      }
      
      // Set the extension name on the constructor
      P2PMeshExtension.prototype.name = extensionName;
      
      // Register the extension with WebTorrent
      if (wire.use && typeof wire.use === 'function') {
        try {
          wire.use(P2PMeshExtension);
          console.log(`WebTorrent: Successfully registered p2pmesh extension for ${remotePeerId}`);
        } catch (useError) {
          console.error(`WebTorrent: Failed to use extension for ${remotePeerId}:`, useError);
          this.setupFallbackExtension(wire, remotePeerId, extensionName);
        }
      } else {
        // Fallback: manually set up extension handling
        console.log(`WebTorrent: Wire.use not available, using fallback extension setup for ${remotePeerId}`);
        this.setupFallbackExtension(wire, remotePeerId, extensionName);
      }

      // Store extension info for sending
      wire._p2pmeshExtension = extensionName;
      wire._p2pmeshSend = (message) => {
        try {
          // Log only the message type for privacy
          console.log(`WebTorrent: Preparing to send message to ${remotePeerId}, type: ${message.type || 'unknown'}`);
          
          const messageText = JSON.stringify(message);
          let messageBuffer;
          
          if (typeof Buffer !== 'undefined') {
            messageBuffer = Buffer.from(messageText);
          } else {
            const encoder = new TextEncoder();
            messageBuffer = encoder.encode(messageText);
          }
          
          // Try to send via extension
          if (wire.extended) {
            wire.extended(extensionName, messageBuffer);
            console.log(`WebTorrent: Extension message sent to ${remotePeerId}`);
          } else {
            console.warn(`WebTorrent: No extended method available for ${remotePeerId}`);
          }
        } catch (error) {
          console.error(`WebTorrent: Failed to send extension message to ${remotePeerId}:`, error.message);
        }
      };
      
      // Wait a bit for handshake to complete, then send hello message
      setTimeout(() => {
        this.sendHelloMessage(remotePeerId);
      }, 1000);
      
    } catch (error) {
      console.error(`WebTorrent: Failed to setup extension protocol with ${remotePeerId}:`, error);
      // Use fallback extension setup
      this.setupFallbackExtension(wire, remotePeerId, extensionName);
    }
  }

  /**
   * Sets up fallback extension handling when wire.use() fails
   */
  setupFallbackExtension(wire, remotePeerId, extensionName) {
    try {
      console.log(`WebTorrent: Setting up fallback extension for ${remotePeerId}`);
      
      // Register extension in handshake
      if (!wire.extendedHandshake) {
        wire.extendedHandshake = {};
      }
      wire.extendedHandshake[extensionName] = 1;

      // Handle extended messages
      wire.on('extended', (ext, buf) => {
        if (ext === extensionName || (typeof ext === 'number' && wire.peerExtendedMapping && wire.peerExtendedMapping[ext] === extensionName)) {
          try {
            // Safely handle the message by parsing with minimal logging
            const message = JSON.parse(buf.toString());
            console.log(`WebTorrent: Received fallback extension message from ${remotePeerId}, type: ${message.type || 'unknown'}`);
            this.handleP2PMeshMessage(remotePeerId, message);
          } catch (error) {
            console.error(`Failed to parse P2PMesh message from ${remotePeerId}:`, error.message);
          }
        }
      });
      
      console.log(`WebTorrent: Fallback extension setup complete for ${remotePeerId}`);
      
    } catch (error) {
      console.error(`WebTorrent: Failed to setup fallback extension for ${remotePeerId}:`, error);
    }
  }

  /**
   * Sends initial hello message to establish P2PMesh communication
   */
  sendHelloMessage(remotePeerId) {
    // Prevent duplicate hello messages
    if (this.sentHellos.has(remotePeerId)) {
      return;
    }
    
    console.log(`WebTorrent: Sending hello message to peer ${remotePeerId}`);
    
    const helloMessage = {
      type: 'hello',
      from: this.localPeerId,
      timestamp: Date.now(),
      p2pmeshProtocol: '1.0'
    };
    
    this.send(remotePeerId, helloMessage);
    this.sentHellos.add(remotePeerId);
    
    // Also send a connect request to initiate WebRTC handshake
    setTimeout(() => {
      console.log(`WebTorrent: Sending connect request to peer ${remotePeerId}`);
      this.send(remotePeerId, {
        type: 'connect_request',
        from: this.localPeerId
      });
    }, 500);
  }

  /**
   * Handles P2PMesh protocol messages received via WebTorrent
   */
  handleP2PMeshMessage(fromPeerId, message) {
    // Log only the message type and peer ID to avoid exposing sensitive message contents
    console.log(`WebTorrent: Received P2PMesh message from ${fromPeerId}, type: ${message.type || 'unknown'}`);

    switch (message.type) {
      case 'hello':
        console.log(`WebTorrent: Received hello from ${fromPeerId}, sending response`);
        // Respond with our own hello response if we haven't sent a hello to this peer yet
        if (!this.sentHellos.has(fromPeerId)) {
          this.sendHelloResponse(fromPeerId);
        }
        break;
        
      case 'hello_response':
        console.log(`WebTorrent: Received hello response from ${fromPeerId}`);
        // Mark peer as ready for P2PMesh communication
        this.markPeerReady(fromPeerId);
        break;

      case 'signal':
        this.emit('signal', {
          from: fromPeerId,
          signal: message.signal
        });
        break;

      case 'connect_request':
        console.log(`WebTorrent: Received connect request from ${fromPeerId}`);
        this.emit('connect_request', {
          from: fromPeerId,
          data: message.data
        });
        break;

      case 'kademlia_rpc':
        // Process Kademlia RPC messages
        console.log(`WebTorrent: Received Kademlia RPC from ${fromPeerId}, type: ${message.rpcMessage?.type || 'unknown'}`);
        this.emit('kademlia_rpc_message', {
          from: fromPeerId,
          rpcMessage: message.rpcMessage
        });
        break;

      case 'kademlia_rpc_reply':
        // Process Kademlia RPC replies
        console.log(`WebTorrent: Received Kademlia RPC reply from ${fromPeerId}`);
        const rpcId = message.rpcMessage?.inReplyTo;
        if (rpcId && this.pendingKademliaRpcs.has(rpcId)) {
          const { resolve } = this.pendingKademliaRpcs.get(rpcId);
          resolve(message.rpcMessage);
          this.pendingKademliaRpcs.delete(rpcId);
        } else {
          console.warn(`WebTorrent: Received Kademlia RPC reply with unknown or missing rpcId`);
        }
        break;

      case 'connection_rejected':
        this.emit('connection_rejected', {
          from: fromPeerId,
          reason: message.reason,
          alternatives: message.alternatives
        });
        break;

      default:
        console.warn(`WebTorrent: Unknown P2PMesh message type: ${message.type}`);
    }
  }

  /**
   * Sends hello response message
   */
  sendHelloResponse(remotePeerId) {
    console.log(`WebTorrent: Sending hello response to peer ${remotePeerId}`);
    
    const response = {
      type: 'hello_response',
      from: this.localPeerId,
      timestamp: Date.now(),
      p2pmeshProtocol: '1.0'
    };
    
    this.send(remotePeerId, response);
    this.sentHellos.add(remotePeerId);
    
    // Also send a connect request to initiate WebRTC handshake
    setTimeout(() => {
      console.log(`WebTorrent: Sending connect request to peer ${remotePeerId} (from hello response)`);
      this.send(remotePeerId, {
        type: 'connect_request',
        from: this.localPeerId
      });
    }, 500);
  }

  /**
   * Marks a peer as ready for P2PMesh communication
   */
  markPeerReady(peerId) {
    console.log(`WebTorrent: Peer ${peerId} is ready for P2PMesh communication`);
    // This peer has completed the handshake and is ready for WebRTC signaling
  }

  /**
   * Disconnects from the WebTorrent network
   */
  async disconnect() {
    return new Promise((resolve) => {
      this.isConnected = false;

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
      this.sentHellos.clear();
    });
  }

  /**
   * Sends a message to a specific peer via WebTorrent wire protocol
   */
  send(toPeerId, message) {
    const wire = this.connectedPeers.get(toPeerId);
    
    if (!wire) {
      console.warn(`WebTorrent: No wire connection to peer ${toPeerId}`);
      return false;
    }

    try {
      // Log only the message type for privacy
      console.log(`WebTorrent: Sending message to ${toPeerId}, type: ${message.type || 'unknown'}`);
      
      // Use the improved extension sender if available
      if (wire._p2pmeshSend) {
        wire._p2pmeshSend(message);
        return true;
      }
      
      // Fallback to manual extension sending
      const messageText = JSON.stringify(message);
      let messageBuffer;
      
      if (typeof Buffer !== 'undefined') {
        // Node.js environment
        messageBuffer = Buffer.from(messageText);
      } else {
        // Browser environment - use Uint8Array
        const encoder = new TextEncoder();
        messageBuffer = encoder.encode(messageText);
      }
      
      // Send via BitTorrent extended protocol
      if (wire._p2pmeshExtension && wire.extended) {
        wire.extended(wire._p2pmeshExtension, messageBuffer);
        console.log(`WebTorrent: Sent fallback extension message to ${toPeerId}, type: ${message.type || 'unknown'}`);
        return true;
      } else {
        console.warn(`WebTorrent: P2PMesh extension not available for peer ${toPeerId}`);
        return false;
      }
    } catch (error) {
      console.error(`WebTorrent: Failed to send message to ${toPeerId}:`, error);
      return false;
    }
  }

  /**
   * Sends a Kademlia RPC message and waits for a reply
   */
  async sendKademliaRpc(toPeerId, kademliaRpcMessage) {
    return new Promise((resolve, reject) => {
      const rpcId = this.generateRpcId();
      const timeoutMs = 5000; // 5 second timeout

      // Store the pending RPC
      const timeout = setTimeout(() => {
        this.pendingKademliaRpcs.delete(rpcId);
        reject(new Error(`Kademlia RPC timeout for peer ${toPeerId}`));
      }, timeoutMs);

      this.pendingKademliaRpcs.set(rpcId, {
        resolve: (reply) => {
          clearTimeout(timeout);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      // Send the RPC message
      const message = {
        type: 'kademlia_rpc',
        rpcMessage: {
          ...kademliaRpcMessage,
          rpcId: rpcId
        }
      };

      // Log sending RPC but avoid exposing the full message content
      console.log(`WebTorrent: Sending Kademlia RPC to ${toPeerId}, type: ${kademliaRpcMessage.type || 'unknown'}, rpcId: ${rpcId}`);
      
      const sent = this.send(toPeerId, message);
      if (!sent) {
        clearTimeout(timeout);
        this.pendingKademliaRpcs.delete(rpcId);
        reject(new Error(`Failed to send Kademlia RPC to peer ${toPeerId}`));
      }
    });
  }

  /**
   * Gets the address information for a peer (WebTorrent peer ID)
   */
  getPeerAddress(peerId) {
    return peerId; // WebTorrent peer ID is the address
  }

  /**
   * Discovers peers through WebTorrent's DHT and swarm
   */
  discoverPeers(bootstrapUrls = []) {
    if (!this.torrent) {
      console.warn('WebTorrent: Cannot discover peers, not connected to swarm');
      return;
    }

    // WebTorrent automatically discovers peers through DHT and trackers
    console.log(`WebTorrent: Active peer discovery through DHT and swarm`);
    console.log(`WebTorrent: Current swarm size: ${this.torrent.wires.length} peers`);
    
    // Emit current peers as bootstrap peers with P2PMesh-compatible format
    const currentPeers = Array.from(this.connectedPeers.keys()).map(peerId => {
      const formattedPeerId = this._formatPeerId(peerId);
      return formattedPeerId;
    }).filter(Boolean); // Remove any null/undefined peer IDs
    
    if (currentPeers.length > 0) {
      console.log(`WebTorrent: Emitting ${currentPeers.length} bootstrap peers:`, currentPeers.slice(0, 3).map(p => p.substring(0, 8)));
      
      // Emit as both individual peer events and bootstrap batch
      currentPeers.forEach(peerId => {
        this.emit('peer_discovered', { 
          peerId: peerId, 
          address: peerId,
          transport: 'webtorrent'
        });
      });
      
      this.emit('bootstrap_peers', { 
        peers: currentPeers.map(peerId => ({ 
          id: peerId, 
          address: peerId 
        }))
      });
    }
    
    // Force torrent to announce itself to trackers
    if (this.torrent.announce) {
      try {
        this.torrent.announce();
        console.log(`WebTorrent: Forced announce to trackers`);
      } catch (e) {
        console.warn(`WebTorrent: Failed to force announce:`, e.message);
      }
    }
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
}
