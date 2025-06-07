// src/transports/transport-registry.js

/**
 * Transport Registry - Manages named transport instances
 */
class TransportRegistry {
  constructor() {
    this.transports = new Map();
    this.isInitialized = false;
    this.initPromise = this.registerBuiltInTransports();
  }

  /**
   * Ensure registry is initialized before use
   */
  async ensureInitialized() {
    if (!this.isInitialized) {
      await this.initPromise;
    }
  }

  /**
   * Register built-in transports
   */
  async registerBuiltInTransports() {
    // Register WebSocket transport
    try {
      const { WebSocketTransport } = await import('./websocket-transport.js');
      this.transports.set('websocket', WebSocketTransport);
      console.log('Registered WebSocket transport');
    } catch (error) {
      console.warn('WebSocket transport not available:', error.message);
    }
    
    // Register WebTorrent transport if available
    try {
      const { WebTorrentTransport } = await import('./webtorrent-transport.js');
      this.transports.set('webtorrent', WebTorrentTransport);
      console.log('Registered WebTorrent transport');
    } catch (error) {
      console.warn('WebTorrent transport not available:', error.message);
    }

    this.isInitialized = true;
    const availableTransports = Array.from(this.transports.keys());
    console.log('Transport registration completed. Available transports:', availableTransports);
    return availableTransports;
  }

  /**
   * Register a transport class with a name
   * @param {string} name - Transport name
   * @param {class} TransportClass - Transport class constructor
   */
  register(name, TransportClass) {
    this.transports.set(name, TransportClass);
  }

  /**
   * Check if a transport is registered
   * @param {string} name - Transport name
   * @returns {Promise<boolean>}
   */
  async has(name) {
    await this.ensureInitialized();
    return this.transports.has(name);
  }

  /**
   * Get a transport class by name
   * @param {string} name - Transport name
   * @returns {Promise<class|null>}
   */
  async get(name) {
    await this.ensureInitialized();
    return this.transports.get(name) || null;
  }

  /**
   * Get all registered transport names
   * @returns {Promise<Array<string>>}
   */
  async getNames() {
    await this.ensureInitialized();
    return Array.from(this.transports.keys());
  }

  /**
   * Create a transport instance from options object
   * @param {string} name - Transport name
   * @param {object} options - Transport options
   * @returns {Promise<object|null>}
   */
  async createFromOptions(name, options = {}) {
    await this.ensureInitialized();
    
    const TransportClass = this.transports.get(name);
    if (!TransportClass) {
      const availableNames = Array.from(this.transports.keys());
      console.error(`Transport '${name}' not found. Available: ${availableNames.join(', ')}`);
      return null;
    }

    try {
      // Handle different transport option patterns
      if (name === 'websocket') {
        return new TransportClass(options.signalingServerUrl || options.url, options);
      } else if (name === 'webtorrent') {
        return new TransportClass(options);
      } else {
        // Generic constructor with options
        return new TransportClass(options);
      }
    } catch (error) {
      console.error(`Error creating transport '${name}':`, error);
      return null;
    }
  }

  /**
   * Create a transport instance with constructor arguments
   * @param {string} name - Transport name
   * @param {...any} args - Constructor arguments
   * @returns {Promise<object|null>}
   */
  async create(name, ...args) {
    await this.ensureInitialized();
    
    const TransportClass = this.transports.get(name);
    if (!TransportClass) {
      const availableNames = Array.from(this.transports.keys());
      console.error(`Transport '${name}' not found. Available: ${availableNames.join(', ')}`);
      return null;
    }

    try {
      return new TransportClass(...args);
    } catch (error) {
      console.error(`Error creating transport '${name}':`, error);
      return null;
    }
  }

  /**
   * Create multiple transport instances from configuration array
   * @param {Array} configs - Array of transport configurations
   * @returns {Promise<Array>} Array of transport instances
   */
  async createMultipleFromConfigs(configs) {
    await this.ensureInitialized();
    
    const instances = [];
    
    for (const config of configs) {
      if (!config.name) {
        console.error('Transport config missing name:', config);
        continue;
      }
      
      const instance = await this.createFromOptions(config.name, config.options || {});
      if (instance) {
        // Use safe method to set multi-transport ID if provided
        if (config.id) {
          const { InitiateTransport } = await import('./transport-interface.js');
          const success = InitiateTransport.safeSetMultiTransportId(instance, config.id);
          if (!success) {
            console.warn(`Failed to set multi-transport ID for ${config.name}`);
          }
        }
        instances.push(instance);
      }
    }
    
    return instances;
  }
}

// Create and export singleton instance
const transportRegistry = new TransportRegistry();
export default transportRegistry;