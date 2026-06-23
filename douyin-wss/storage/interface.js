/**
 * Storage Interface
 *
 * All storage backends must implement this interface.
 * Messages with `storable: true` are the only ones passed to storage.
 */

class StorageBackend {
  /** Initialize the backend (create tables, connect, etc.) */
  async init() {
    throw new Error('Not implemented');
  }

  /** Save a single message */
  async save(msg) {
    throw new Error('Not implemented');
  }

  /** Save multiple messages in batch */
  async saveBatch(msgs) {
    throw new Error('Not implemented');
  }

  /** Query messages by room and date range */
  async query(roomId, startDate, endDate, options = {}) {
    throw new Error('Not implemented');
  }

  /** Get aggregated stats for a room on a given date */
  async getStats(roomId, date) {
    throw new Error('Not implemented');
  }

  /** Archive data older than cutoffDate (for cold storage tier) */
  async archive(cutoffDate) {
    throw new Error('Not implemented');
  }

  /** Restore archived data for a date range */
  async restore(roomId, startDate, endDate) {
    throw new Error('Not implemented');
  }

  /** Delete data older than retentionDate */
  async prune(retentionDate) {
    throw new Error('Not implemented');
  }

  /** Get storage statistics */
  async getStorageStats() {
    throw new Error('Not implemented');
  }

  /** Cleanup on shutdown */
  async close() {
    throw new Error('Not implemented');
  }
}

module.exports = { StorageBackend };
