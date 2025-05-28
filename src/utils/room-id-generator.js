// src/utils/room-id-generator.js

/**
 * Generates a SHA1-based room ID (infoHash) for WebTorrent transport
 * @param {string} roomName - Human-readable room name
 * @returns {Promise<string>} SHA1 hash as hex string (40 characters)
 */
export async function generateRoomId(roomName) {
  const input = `p2pmesh-room-${roomName}-${Date.now()}`;
  
  try {
    // Dynamic SHA-1 generation based on environment
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      // Browser environment with SubtleCrypto API
      const encoder = new TextEncoder();
      const data = encoder.encode(input);
      const hashBuffer = await window.crypto.subtle.digest('SHA-1', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      // Node.js environment - dynamically import crypto
      try {
        const { createHash } = await import('crypto');
        return createHash('sha1').update(input).digest('hex');
      } catch (e) {
        console.error('Failed to load crypto module for SHA-1 generation:', e);
        throw e;
      }
    }
  } catch (e) {
    console.warn('Falling back to simple hash generation:', e.message);
    // Simple fallback hash generation
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Convert to hex and pad to 40 characters
    return Math.abs(hash).toString(16).padStart(40, '0');
  }
}

/**
 * Generates a room ID from a simple room name (deterministic)
 * @param {string} roomName - Simple room name
 * @returns {Promise<string>} SHA1 hash as hex string
 */
export async function generateDeterministicRoomId(roomName) {
  const input = `p2pmesh-room-${roomName}`;
  
  try {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(input);
      const hashBuffer = await window.crypto.subtle.digest('SHA-1', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      const { createHash } = await import('crypto');
      return createHash('sha1').update(input).digest('hex');
    }
  } catch (e) {
    // Simple fallback
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(40, '0');
  }
}

/**
 * Validates that a room ID is a valid SHA1 hash
 * @param {string} roomId - Room ID to validate
 * @returns {boolean} True if valid SHA1 hash format
 */
export function isValidRoomId(roomId) {
  return typeof roomId === 'string' && 
         roomId.length === 40 && 
         /^[a-fA-F0-9]{40}$/.test(roomId);
}
