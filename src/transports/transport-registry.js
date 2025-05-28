// src/transports/transport-registry.js

/**
 * Transport Registry
 * Manages named transport implementations for P2PMesh.
 * 
 * This registry allows transports to be registered with a name and then
 * retrieved by name, making the system more flexible and allowing for
 * dynamic loading of transport modules.
 */

class TransportRegistry {
  constructor() {
    this.transports = new Map();
  }

  /**
   * Register a transport implementation with a name.
   * @param {string} name - The name to register the transport under.
   * @param {Function} transportClass - The transport class constructor.
   * @returns {void}
   */
  register(name, transportClass) {
    if (this.transports.has(name)) {
      console.warn(`Transport with name '${name}' is already registered. Overwriting.`);
    }
    this.transports.set(name, transportClass);
  }

  /**
   * Get a transport implementation by name.
   * @param {string} name - The name of the transport to retrieve.
   * @returns {Function|null} The transport class constructor or null if not found.
   */
  get(name) {
    return this.transports.get(name) || null;
  }

  /**
   * Check if a transport with the given name is registered.
   * @param {string} name - The name to check.
   * @returns {boolean} True if the transport is registered, false otherwise.
   */
  has(name) {
    return this.transports.has(name);
  }

  /**
   * Create a new instance of a transport by name with the given arguments.
   * @param {string} name - The name of the transport to create.
   * @param {...any} args - Arguments to pass to the transport constructor.
   * @returns {object|null} A new instance of the transport or null if not found.
   */
  create(name, ...args) {
    const TransportClass = this.get(name);
    if (!TransportClass) {
      return null;
    }
    return new TransportClass(...args);
  }

  /**
   * Get all registered transport names.
   * @returns {Array<string>} Array of registered transport names.
   */
  getNames() {
    return Array.from(this.transports.keys());
  }

  /**
   * Remove a transport from the registry.
   * @param {string} name - The name of the transport to remove.
   * @returns {boolean} True if the transport was removed, false otherwise.
   */
  unregister(name) {
    return this.transports.delete(name);
  }
}

// Create a singleton instance
const registry = new TransportRegistry();

// Register the built-in transports
import { WebSocketTransport } from './websocket-transport.js';
import { WebTorrentTransport } from './webtorrent-transport.js';

// Register all built-in transports
registry.register('websocket', WebSocketTransport);
registry.register('webtorrent', WebTorrentTransport);

// Auto-register any additional transports that might be added in the future
// This is a hook for module developers to register their transports

/**
 * Helper function to get a transport instance with proper configuration
 * This is useful for backward compatibility with code that expects a transport instance
 * @param {string} name - The name of the transport to create
 * @param {object} options - Configuration options for the transport
 * @returns {object|null} A configured transport instance or null if not found
 */
registry.createFromOptions = function(name, options = {}) {
  if (!this.has(name)) {
    return null;
  }
  
  // Handle specific transport types with their expected parameters
  if (name === 'websocket') {
    // WebSocketTransport expects the signaling server URL as first parameter
    return this.create(name, options.signalingServerUrl || options.url);
  }
  
  if (name === 'webtorrent') {
    // WebTorrentTransport expects infoHash as first parameter
    return this.create(name, options.infoHash || options.roomId, options);
  }
  
  // Default case: pass all options as arguments
  return this.create(name, ...Object.values(options));
};

export default registry;