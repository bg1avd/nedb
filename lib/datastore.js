const customUtils = require('./customUtils');
const model = require('./model');
const Executor = require('./executor');
const Index = require('./indexes');
const Persistence = require('./persistence');
const Cursor = require('./cursor');
const EventEmitter = require('events').EventEmitter;
const { streamMixins } = require('./stream');

// --- Helper: replaces underscore utilities ---
function intersection(a, b) {
  return a.filter(x => b.includes(x));
}

/**
 * Create a new collection
 * @param {String} options.filename Optional, datastore will be in-memory only if not provided
 * @param {Boolean} options.timestampData Optional, defaults to false.
 * @param {Boolean} options.inMemoryOnly Optional, defaults to false
 * @param {Boolean} options.autoload Optional, defaults to false
 * @param {Function} options.onload Optional
 * @param {Function} options.afterSerialization/options.beforeDeserialization Optional, serialization hooks
 * @param {Number} options.corruptAlertThreshold Optional
 * @param {Function} options.compareStrings Optional, string comparison function
 *
 * Event Emitter - Events
 * * compaction.done - Fired whenever a compaction operation was finished
 */
class Datastore extends EventEmitter {
  constructor(options) {
    super();

    let onload;

    // Retrocompatibility with v0.6 and before
    if (typeof options === 'string') {
      this.filename = options;
      this.inMemoryOnly = false;
      this.autoload = false;
      this.timestampData = false;
    } else {
      const {
        filename,
        inMemoryOnly = false,
        autoload = false,
        timestampData = false,
        nodeWebkitAppName,
        afterSerialization,
        beforeDeserialization,
        corruptAlertThreshold,
        compareStrings,
        onload: _onload
      } = options || {};

      onload = _onload;

      // Determine whether in memory or persistent
      if (!filename || typeof filename !== 'string' || filename.length === 0) {
        this.filename = null;
        this.inMemoryOnly = true;
      } else {
        this.filename = filename;
        this.inMemoryOnly = inMemoryOnly;
      }

      this.autoload = autoload;
      this.timestampData = timestampData;
      this.compareStrings = compareStrings;

      // Persistence handling
      this.persistence = new Persistence({
        db: this,
        nodeWebkitAppName,
        afterSerialization,
        beforeDeserialization,
        corruptAlertThreshold
      });
    }

    // This new executor is ready if we don't use persistence
    this.executor = new Executor();
    if (this.inMemoryOnly) { this.executor.ready = true; }

    // Indexed by field name, dot notation can be used
    this.indexes = {};
    this.indexes._id = new Index({ fieldName: '_id', unique: true });
    this.ttlIndexes = {};

    // Queue a load of the database right away
    if (this.autoload) {
      this.loadDatabase(onload || function (err) {
        if (err) { throw err; }
      });
    }
  }

  /**
   * Load the database from the datafile
   */
  loadDatabase(cb) {
    if (cb) {
      this.executor.push({ this: this.persistence, fn: this.persistence.loadDatabase, arguments }, true);
      return undefined;
    }
    return new Promise((resolve, reject) => {
      this.executor.push({
        this: this.persistence,
        fn: this.persistence.loadDatabase,
        arguments: [function (err, result) {
          if (err) return reject(err);
          resolve(result);
        }]
      }, true);
    });
  }

  /**
   * Get an array of all the data in the database
   */
  getAllData() {
    return this.indexes._id.getAll();
  }

  /**
   * Reset all currently defined indexes
   */
  resetIndexes(newData) {
    for (const key of Object.keys(this.indexes)) {
      this.indexes[key].reset(newData);
    }
  }

  /**
   * Ensure an index is kept for this field
   * @param {String} options.fieldName
   * @param {Boolean} options.unique
   * @param {Boolean} options.sparse
   * @param {Number} options.expireAfterSeconds
   * @param {Function} cb Optional callback, signature: err
   */
  ensureIndex(options, cb = () => {}) {
    options = options || {};

    if (!options.fieldName) {
      const err = new Error('Cannot create an index without a fieldName');
      err.missingFieldName = true;
      return cb(err);
    }
    if (this.indexes[options.fieldName]) { return cb(null); }

    this.indexes[options.fieldName] = new Index(options);
    if (options.expireAfterSeconds !== undefined) {
      this.ttlIndexes[options.fieldName] = options.expireAfterSeconds;
    }

    try {
      this.indexes[options.fieldName].insert(this.getAllData());
    } catch (e) {
      delete this.indexes[options.fieldName];
      return cb(e);
    }

    this.persistence.persistNewState([{ $$indexCreated: options }], (err) => {
      if (err) { return cb(err); }
      return cb(null);
    });
  }

  /**
   * Remove an index
   * @param {String} fieldName
   * @param {Function} cb Optional callback, signature: err
   */
  removeIndex(fieldName, cb = () => {}) {
    delete this.indexes[fieldName];

    this.persistence.persistNewState([{ $$indexRemoved: fieldName }], (err) => {
      if (err) { return cb(err); }
      return cb(null);
    });
  }

  /**
   * Add one or several document(s) to all indexes
   */
  addToIndexes(doc) {
    let failingIndex, error;
    const keys = Object.keys(this.indexes);

    for (let i = 0; i < keys.length; i++) {
      try {
        this.indexes[keys[i]].insert(doc);
      } catch (e) {
        failingIndex = i;
        error = e;
        break;
      }
    }

    if (error) {
      for (let i = 0; i < failingIndex; i++) {
        this.indexes[keys[i]].remove(doc);
      }
      throw error;
    }
  }

  /**
   * Remove one or several document(s) from all indexes
   */
  removeFromIndexes(doc) {
    for (const key of Object.keys(this.indexes)) {
      this.indexes[key].remove(doc);
    }
  }

  /**
   * Update one or several documents in all indexes
   */
  updateIndexes(oldDoc, newDoc) {
    let failingIndex, error;
    const keys = Object.keys(this.indexes);

    for (let i = 0; i < keys.length; i++) {
      try {
        this.indexes[keys[i]].update(oldDoc, newDoc);
      } catch (e) {
        failingIndex = i;
        error = e;
        break;
      }
    }

    if (error) {
      for (let i = 0; i < failingIndex; i++) {
        this.indexes[keys[i]].revertUpdate(oldDoc, newDoc);
      }
      throw error;
    }
  }

  /**
   * Return the list of candidates for a given query
   */
  getCandidates(query, dontExpireStaleDocs, callback) {
    if (typeof dontExpireStaleDocs === 'function') {
      callback = dontExpireStaleDocs;
      dontExpireStaleDocs = false;
    }

    const indexNames = Object.keys(this.indexes);
    let docs;

    // STEP 1: get candidates list by checking indexes

    // For a basic match
    let usableQueryKeys = [];
    for (const k of Object.keys(query)) {
      if (typeof query[k] === 'string' || typeof query[k] === 'number' ||
        typeof query[k] === 'boolean' || query[k] instanceof Date || query[k] === null) {
        usableQueryKeys.push(k);
      }
    }
    usableQueryKeys = intersection(usableQueryKeys, indexNames);
    if (usableQueryKeys.length > 0) {
      docs = this.indexes[usableQueryKeys[0]].getMatching(query[usableQueryKeys[0]]);
    }

    // For a $in match
    if (!docs) {
      usableQueryKeys = [];
      for (const k of Object.keys(query)) {
        if (query[k]?.$in !== undefined) {
          usableQueryKeys.push(k);
        }
      }
      usableQueryKeys = intersection(usableQueryKeys, indexNames);
      if (usableQueryKeys.length > 0) {
        docs = this.indexes[usableQueryKeys[0]].getMatching(query[usableQueryKeys[0]].$in);
      }
    }

    // For a comparison match
    if (!docs) {
      usableQueryKeys = [];
      for (const k of Object.keys(query)) {
        const qk = query[k];
        if (qk && (qk.$lt !== undefined || qk.$lte !== undefined ||
          qk.$gt !== undefined || qk.$gte !== undefined)) {
          usableQueryKeys.push(k);
        }
      }
      usableQueryKeys = intersection(usableQueryKeys, indexNames);
      if (usableQueryKeys.length > 0) {
        docs = this.indexes[usableQueryKeys[0]].getBetweenBounds(query[usableQueryKeys[0]]);
      }
    }

    // By default, return all the DB data
    if (!docs) {
      docs = this.getAllData();
    }

    // STEP 2: remove all expired documents
    if (dontExpireStaleDocs) { return callback(null, docs); }

    const expiredDocsIds = [];
    const validDocs = [];
    const ttlFieldNames = Object.keys(this.ttlIndexes);

    for (const doc of docs) {
      let valid = true;
      for (const fn of ttlFieldNames) {
        if (doc[fn] !== undefined && doc[fn] instanceof Date &&
          Date.now() > doc[fn].getTime() + this.ttlIndexes[fn] * 1000) {
          valid = false;
        }
      }
      if (valid) { validDocs.push(doc); }
      else { expiredDocsIds.push(doc._id); }
    }

    // Sequential removal of expired docs
    const removeExpired = (ids, idx, done) => {
      if (idx >= ids.length) { return done(null); }
      this._remove({ _id: ids[idx] }, {}, (err) => {
        if (err) { return done(err); }
        removeExpired(ids, idx + 1, done);
      });
    };

    removeExpired(expiredDocsIds, 0, (err) => {
      if (err) { return callback(err); }
      return callback(null, validDocs);
    });
  }

  /**
   * Insert a new document
   * @api private
   */
  _insert(newDoc, cb = () => {}) {
    let preparedDoc;

    try {
      preparedDoc = this.prepareDocumentForInsertion(newDoc);
      this._insertInCache(preparedDoc);
    } catch (e) {
      return cb(e);
    }

    const docsToPersist = Array.isArray(preparedDoc) ? preparedDoc : [preparedDoc];
    this.persistence.persistNewState(docsToPersist, (err) => {
      if (err) { return cb(err); }
      return cb(null, model.deepCopy(preparedDoc));
    });
  }

  /**
   * Create a new _id that's not already in use
   */
  createNewId() {
    let tentativeId = customUtils.uid(16);
    if (this.indexes._id.getMatching(tentativeId).length > 0) {
      tentativeId = this.createNewId();
    }
    return tentativeId;
  }

  /**
   * Prepare a document for insertion
   * @api private
   */
  prepareDocumentForInsertion(newDoc) {
    if (Array.isArray(newDoc)) {
      return newDoc.map(doc => this.prepareDocumentForInsertion(doc));
    }

    const preparedDoc = model.deepCopy(newDoc);
    if (preparedDoc._id === undefined) { preparedDoc._id = this.createNewId(); }
    const now = new Date();
    if (this.timestampData && preparedDoc.createdAt === undefined) { preparedDoc.createdAt = now; }
    if (this.timestampData && preparedDoc.updatedAt === undefined) { preparedDoc.updatedAt = now; }
    model.checkObject(preparedDoc);
    return preparedDoc;
  }

  /**
   * @api private
   */
  _insertInCache(preparedDoc) {
    if (Array.isArray(preparedDoc)) {
      this._insertMultipleDocsInCache(preparedDoc);
    } else {
      this.addToIndexes(preparedDoc);
    }
  }

  /**
   * @api private
   */
  _insertMultipleDocsInCache(preparedDocs) {
    let failingI, error;

    for (let i = 0; i < preparedDocs.length; i++) {
      try {
        this.addToIndexes(preparedDocs[i]);
      } catch (e) {
        error = e;
        failingI = i;
        break;
      }
    }

    if (error) {
      for (let i = 0; i < failingI; i++) {
        this.removeFromIndexes(preparedDocs[i]);
      }
      throw error;
    }
  }

  // --- Public API with Promise support ---

  insert(newDoc, cb) {
    if (cb) {
      this.executor.push({ this: this, fn: this._insert, arguments });
      return undefined;
    }
    return new Promise((resolve, reject) => {
      this.executor.push({
        this: this,
        fn: this._insert,
        arguments: [newDoc, function (err, result) {
          if (err) return reject(err);
          resolve(result);
        }]
      });
    });
  }

  /**
   * Count all documents matching the query
   */
  count(query, callback) {
    const cursor = new Cursor(this, query, (err, docs, cb) => {
      if (err) { return cb(err); }
      return cb(null, docs.length);
    });

    if (typeof callback === 'function') {
      cursor.exec(callback);
      return undefined;
    }
    // Return thenable cursor — can be awaited: const n = await db.count({})
    return cursor;
  }

  /**
   * Find all documents matching the query
   */
  find(query, projection, callback) {
    switch (arguments.length) {
      case 1:
        projection = {};
        break;
      case 2:
        if (typeof projection === 'function') {
          callback = projection;
          projection = {};
        }
        break;
    }

    const cursor = new Cursor(this, query, (err, docs, cb) => {
      if (err) { return cb(err); }
      const res = docs.map(doc => model.deepCopy(doc));
      return cb(null, res);
    });

    cursor.projection(projection);
    if (typeof callback === 'function') {
      cursor.exec(callback);
      return undefined;
    }
    // Return thenable cursor — allows: await db.find({}).sort({ age: -1 }).limit(10)
    return cursor;
  }

  /**
   * Find one document matching the query
   */
  findOne(query, projection, callback) {
    switch (arguments.length) {
      case 1:
        projection = {};
        break;
      case 2:
        if (typeof projection === 'function') {
          callback = projection;
          projection = {};
        }
        break;
    }

    const cursor = new Cursor(this, query, (err, docs, cb) => {
      if (err) { return cb(err); }
      if (docs.length === 1) {
        return cb(null, model.deepCopy(docs[0]));
      } else {
        return cb(null, null);
      }
    });

    cursor.projection(projection).limit(1);
    if (typeof callback === 'function') {
      cursor.exec(callback);
      return undefined;
    }
    // Return thenable cursor — can be awaited
    return cursor;
  }

  /**
   * Update all docs matching query
   * @api private
   */
  _update(query, updateQuery, options, cb) {
    let callback;
    const self = this;
    let numReplaced = 0, multi, upsert;

    if (typeof options === 'function') { cb = options; options = {}; }
    callback = cb || function () {};
    multi = options.multi ?? false;
    upsert = options.upsert ?? false;

    // STEP 1: If upsert, check if we need to insert
    const doUpdate = () => {
      if (!upsert) { return performUpdate(); }

      const cursor = new Cursor(self, query);
      cursor.limit(1)._exec((err, docs) => {
        if (err) { return callback(err); }
        if (docs.length === 1) { return performUpdate(); }

        let toBeInserted;
        try {
          model.checkObject(updateQuery);
          toBeInserted = updateQuery;
        } catch (e) {
          try {
            toBeInserted = model.modify(model.deepCopy(query, true), updateQuery);
          } catch (err2) {
            return callback(err2);
          }
        }

        return self._insert(toBeInserted, (err, newDoc) => {
          if (err) { return callback(err); }
          return callback(null, 1, newDoc, true);
        });
      });
    };

    // STEP 2: Perform the update
    const performUpdate = () => {
      let modifiedDoc;
      const modifications = [];
      let createdAt;

      self.getCandidates(query, (err, candidates) => {
        if (err) { return callback(err); }

        try {
          for (const candidate of candidates) {
            if (model.match(candidate, query) && (multi || numReplaced === 0)) {
              numReplaced += 1;
              if (self.timestampData) { createdAt = candidate.createdAt; }
              modifiedDoc = model.modify(candidate, updateQuery);
              if (self.timestampData) {
                modifiedDoc.createdAt = createdAt;
                modifiedDoc.updatedAt = new Date();
              }
              modifications.push({ oldDoc: candidate, newDoc: modifiedDoc });
            }
          }
        } catch (err2) {
          return callback(err2);
        }

        // Change the docs in memory
        try {
          self.updateIndexes(modifications);
        } catch (err3) {
          return callback(err3);
        }

        // Update the datafile
        const updatedDocs = modifications.map(m => m.newDoc);
        self.persistence.persistNewState(updatedDocs, (err) => {
          if (err) { return callback(err); }
          if (!options.returnUpdatedDocs) {
            return callback(null, numReplaced);
          }
          const updatedDocsDC = updatedDocs.map(doc => model.deepCopy(doc));
          if (!multi) { return callback(null, numReplaced, updatedDocsDC[0]); }
          return callback(null, numReplaced, updatedDocsDC);
        });
      });
    };

    doUpdate();
  }

  update(query, updateQuery, options, cb) {
    // Handle argument overloading
    if (typeof options === 'function') { cb = options; options = {}; }
    if (typeof options === 'undefined') { options = {}; }

    if (cb) {
      this.executor.push({ this: this, fn: this._update, arguments: [query, updateQuery, options, cb] });
      return undefined;
    }
    return new Promise((resolve, reject) => {
      this.executor.push({
        this: this,
        fn: this._update,
        arguments: [query, updateQuery, options, function (err, numAffected, affectedDocuments, upsert) {
          if (err) return reject(err);
          resolve({ numAffected, affectedDocuments, upsert });
        }]
      });
    });
  }

  /**
   * Remove all docs matching query
   * @api private
   */
  _remove(query, options, cb) {
    let callback;
    const self = this;
    let numRemoved = 0;
    const removedDocs = [];
    let multi;

    if (typeof options === 'function') { cb = options; options = {}; }
    callback = cb || function () {};
    multi = options.multi ?? false;

    this.getCandidates(query, true, (err, candidates) => {
      if (err) { return callback(err); }

      try {
        for (const d of candidates) {
          if (model.match(d, query) && (multi || numRemoved === 0)) {
            numRemoved += 1;
            removedDocs.push({ $$deleted: true, _id: d._id });
            self.removeFromIndexes(d);
          }
        }
      } catch (err2) { return callback(err2); }

      self.persistence.persistNewState(removedDocs, (err) => {
        if (err) { return callback(err); }
        return callback(null, numRemoved);
      });
    });
  }

  remove(query, options, cb) {
    // Handle argument overloading
    if (typeof options === 'function') { cb = options; options = {}; }
    if (typeof options === 'undefined') { options = {}; }

    if (cb) {
      this.executor.push({ this: this, fn: this._remove, arguments: [query, options, cb] });
      return undefined;
    }
    return new Promise((resolve, reject) => {
      this.executor.push({
        this: this,
        fn: this._remove,
        arguments: [query, options, function (err, numRemoved) {
          if (err) return reject(err);
          resolve({ numRemoved });
        }]
      });
    });
  }
}


// Mix in stream API methods
Object.assign(Datastore.prototype, streamMixins);

module.exports = Datastore;
