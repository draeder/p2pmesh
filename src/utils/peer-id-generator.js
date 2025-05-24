// src/utils/peer-id-generator.js
import { generateNodeId as kademliaGenerateNodeId } from '../kademlia.js';

/**
 * Generates a unique peer ID using SHA-1 hash
 * @param {string} [customString] - Optional custom string to hash, otherwise uses random string
 * @returns {Promise<string>} SHA-1 hash as hex string
 */
export async function generatePeerId(customString) {
  const randomString = customString || (Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15));
  
  try {
    // Dynamic SHA-1 generation based on environment
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      // Browser environment with SubtleCrypto API
      const encoder = new TextEncoder();
      const data = encoder.encode(randomString);
      const hashBuffer = await window.crypto.subtle.digest('SHA-1', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      // Node.js environment - dynamically import crypto
      try {
        const { createHash } = await import('crypto');
        return createHash('sha1').update(randomString).digest('hex');
      } catch (e) {
        console.error('Failed to load crypto module for SHA-1 generation:', e);
        throw e; // Re-throw to be caught by outer try/catch
      }
    }
  } catch (e) {
    console.warn('Falling back to Kademlia ID generator:', e.message);
    return 'fallback-' + kademliaGenerateNodeId(); // Use Kademlia's generator as a fallback if SHA-1 fails
  }
}
