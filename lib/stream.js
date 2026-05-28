/**
 * Stream API for NeDB Promise
 * Provides Node.js Readable/Writable streams for large dataset operations
 * Modernized P1: ES6+ classes, async generators, for...of
 */

const { Readable, Writable, Transform } = require('stream');
const model = require('./model');


/**
 * Create a readable stream that yields documents matching a query
 * Usage:
 *   const stream = db.createReadStream({ query: { age: { $gte: 18 } } });
 *   stream.on('data', (doc) => { ... });
 *   stream.on('end', () => { ... });
 *   // or pipe:
 *   db.createReadStream().pipe(writableStream);
 */
class DataReadStream extends Readable {
  constructor(db, options = {}) {
    super({ objectMode: true, highWaterMark: options.highWaterMark || 16 });
    this.db = db;
    this.query = options.query || {};
    this._docs = null;
    this._index = 0;
    this._started = false;
  }

  _read() {
    if (!this._started) {
      this._started = true;
      // Get all candidates and filter — runs once at start
      this.db.getCandidates(this.query, (err, candidates) => {
        if (err) {
          this.destroy(err);
          return;
        }
        // Filter candidates that match the query
        this._docs = candidates.filter(doc => model.match(doc, this.query));
        this._pushDocs();
      });
      return;
    }
    this._pushDocs();
  }

  _pushDocs() {
    if (!this._docs) { return; }

    while (this._index < this._docs.length) {
      const doc = model.deepCopy(this._docs[this._index]);
      this._index++;
      if (!this.push(doc)) { return; }
    }
    this.push(null);
  }
}


/**
 * Create a writable stream that inserts documents into the database
 * Usage:
 *   const writeStream = db.createWriteStream();
 *   writeStream.write({ name: 'Alice', age: 30 });
 *   writeStream.write({ name: 'Bob', age: 25 });
 *   writeStream.end();
 *   writeStream.on('finish', () => { ... });
 */
class DataWriteStream extends Writable {
  constructor(db, options = {}) {
    super({ objectMode: true, highWaterMark: options.highWaterMark || 16 });
    this.db = db;
    this._inserted = 0;
  }

  _write(doc, encoding, callback) {
    this.db.insert(doc, (err) => {
      if (err) { return callback(err); }
      this._inserted++;
      callback();
    });
  }

  _writev(chunks, callback) {
    const docs = chunks.map(chunk => chunk.chunk);
    this.db.insert(docs, (err) => {
      if (err) { return callback(err); }
      this._inserted += docs.length;
      callback();
    });
  }
}


/**
 * Create a transform stream that updates documents passing through
 * Usage:
 *   const updateStream = db.createUpdateStream({ update: { $set: { status: 'active' } } });
 *   db.createReadStream({ query: { status: 'inactive' } })
 *     .pipe(updateStream);
 */
class DataUpdateStream extends Transform {
  constructor(db, options = {}) {
    super({ objectMode: true, highWaterMark: options.highWaterMark || 16 });
    this.db = db;
    this.updateQuery = options.update || {};
    this.updateOptions = options.options || {};
    this._updated = 0;
  }

  _transform(doc, encoding, callback) {
    this.db.update({ _id: doc._id }, this.updateQuery, this.updateOptions, (err) => {
      if (err) { return callback(err); }
      this._updated++;
      callback(null, doc); // Pass through the original doc
    });
  }
}


/**
 * Create a transform stream that removes documents passing through
 * Usage:
 *   const removeStream = db.createRemoveStream();
 *   db.createReadStream({ query: { expired: true } })
 *     .pipe(removeStream);
 */
class DataRemoveStream extends Transform {
  constructor(db, options = {}) {
    super({ objectMode: true, highWaterMark: options.highWaterMark || 16 });
    this.db = db;
    this.removeOptions = options.options || {};
    this._removed = 0;
  }

  _transform(doc, encoding, callback) {
    this.db.remove({ _id: doc._id }, this.removeOptions, (err) => {
      if (err) { return callback(err); }
      this._removed++;
      callback(null, { _id: doc._id, removed: true });
    });
  }
}


// Factory methods to be mixed into Datastore prototype
const streamMixins = {
  /**
   * Create a readable stream for querying documents
   * @param {Object} options
   * @param {Object} options.query - Query filter (default: {})
   * @param {Number} options.highWaterMark - Buffer size (default: 16)
   * @returns {DataReadStream}
   */
  createReadStream(options = {}) {
    return new DataReadStream(this, options);
  },

  /**
   * Create a writable stream for inserting documents
   * @param {Object} options
   * @param {Number} options.highWaterMark - Buffer size (default: 16)
   * @returns {DataWriteStream}
   */
  createWriteStream(options = {}) {
    return new DataWriteStream(this, options);
  },

  /**
   * Create a transform stream for updating documents
   * @param {Object} options
   * @param {Object} options.update - Update query (e.g. { $set: { field: value } })
   * @param {Object} options.options - Update options (multi, upsert, etc.)
   * @returns {DataUpdateStream}
   */
  createUpdateStream(options = {}) {
    return new DataUpdateStream(this, options);
  },

  /**
   * Create a transform stream for removing documents
   * @param {Object} options
   * @param {Object} options.options - Remove options (multi, etc.)
   * @returns {DataRemoveStream}
   */
  createRemoveStream(options = {}) {
    return new DataRemoveStream(this, options);
  }
};


module.exports = {
  DataReadStream,
  DataWriteStream,
  DataUpdateStream,
  DataRemoveStream,
  streamMixins
};
