const customUtils = require('./customUtils');
const model = require('./model');
const Executor = require('./executor');
const Index = require('./indexes');
const Persistence = require('./persistence');
const Cursor = require('./cursor');


// --- Helper: polyfill for underscore utilities we used ---

function pluck(arr, key) {
  return arr.map(item => item[key]);
}

function intersection(a, b) {
  return a.filter(x => b.indexOf(x) !== -1);
}

function uniq(arr, keyFn) {
  if (!keyFn) {
    return [...new Set(arr.map(x => JSON.stringify(x)))].map(x => JSON.parse(x));
  }
  const seen = {};
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const k = keyFn(arr[i]);
    if (!seen.hasOwnProperty(k)) {
      seen[k] = true;
      result.push(arr[i]);
    }
  }
  return result;
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
function Datastore(options) {
  let filename;

  // Retrocompatibility with v0.6 and before
  if (typeof options === 'string') {
    filename = options;
    this.inMemoryOnly = false;
  } else {
    options = options || {};
    filename = options.filename;
    this.inMemoryOnly = options.inMemoryOnly || false;
    this.autoload = options.autoload || false;
    this.timestampData = options.timestampData || false;
  }

  // Determine whether in memory or persistent
  if (!filename || typeof filename !== 'string' || filename.length === 0) {
    this.filename = null;
    this.inMemoryOnly = true;
  } else {
    this.filename = filename;
  }

  // String comparison function
  this.compareStrings = options.compareStrings;

  // Persistence handling
  this.persistence = new Persistence({
    db: this,
    nodeWebkitAppName: options.nodeWebkitAppName,
    afterSerialization: options.afterSerialization,
    beforeDeserialization: options.beforeDeserialization,
    corruptAlertThreshold: options.corruptAlertThreshold
  });

  // This new executor is ready if we don't use persistence
  this.executor = new Executor();
  if (this.inMemoryOnly) { this.executor.ready = true; }

  // Indexed by field name, dot notation can be used
  this.indexes = {};
  this.indexes._id = new Index({ fieldName: '_id', unique: true });
  this.ttlIndexes = {};

  // Queue a load of the database right away
  if (this.autoload) {
    this.loadDatabase(options.onload || function (err) {
      if (err) { throw err; }
    });
  }
}

// Use ES6 class-style inheritance via util.inherits for EventEmitter
const EventEmitter = require('events').EventEmitter;
Datastore.prototype = Object.create(EventEmitter.prototype);
Datastore.prototype.constructor = Datastore;


/**
 * Load the database from the datafile
 */
Datastore.prototype.loadDatabase = function (cb) {
  if (cb) {
    this.executor.push({ this: this.persistence, fn: this.persistence.loadDatabase, arguments: arguments }, true);
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
};


/**
 * Get an array of all the data in the database
 */
Datastore.prototype.getAllData = function () {
  return this.indexes._id.getAll();
};


/**
 * Reset all currently defined indexes
 */
Datastore.prototype.resetIndexes = function (newData) {
  const self = this;

  Object.keys(this.indexes).forEach(function (i) {
    self.indexes[i].reset(newData);
  });
};


/**
 * Ensure an index is kept for this field
 * @param {String} options.fieldName
 * @param {Boolean} options.unique
 * @param {Boolean} options.sparse
 * @param {Number} options.expireAfterSeconds
 * @param {Function} cb Optional callback, signature: err
 */
Datastore.prototype.ensureIndex = function (options, cb) {
  const callback = cb || function () {};
  let err;

  options = options || {};

  if (!options.fieldName) {
    err = new Error("Cannot create an index without a fieldName");
    err.missingFieldName = true;
    return callback(err);
  }
  if (this.indexes[options.fieldName]) { return callback(null); }

  this.indexes[options.fieldName] = new Index(options);
  if (options.expireAfterSeconds !== undefined) {
    this.ttlIndexes[options.fieldName] = options.expireAfterSeconds;
  }

  try {
    this.indexes[options.fieldName].insert(this.getAllData());
  } catch (e) {
    delete this.indexes[options.fieldName];
    return callback(e);
  }

  this.persistence.persistNewState([{ $$indexCreated: options }], function (err) {
    if (err) { return callback(err); }
    return callback(null);
  });
};


/**
 * Remove an index
 * @param {String} fieldName
 * @param {Function} cb Optional callback, signature: err
 */
Datastore.prototype.removeIndex = function (fieldName, cb) {
  const callback = cb || function () {};

  delete this.indexes[fieldName];

  this.persistence.persistNewState([{ $$indexRemoved: fieldName }], function (err) {
    if (err) { return callback(err); }
    return callback(null);
  });
};


/**
 * Add one or several document(s) to all indexes
 */
Datastore.prototype.addToIndexes = function (doc) {
  let failingIndex, error;
  const keys = Object.keys(this.indexes);

  for (let i = 0; i < keys.length; i += 1) {
    try {
      this.indexes[keys[i]].insert(doc);
    } catch (e) {
      failingIndex = i;
      error = e;
      break;
    }
  }

  if (error) {
    for (let i = 0; i < failingIndex; i += 1) {
      this.indexes[keys[i]].remove(doc);
    }
    throw error;
  }
};


/**
 * Remove one or several document(s) from all indexes
 */
Datastore.prototype.removeFromIndexes = function (doc) {
  const self = this;

  Object.keys(this.indexes).forEach(function (i) {
    self.indexes[i].remove(doc);
  });
};


/**
 * Update one or several documents in all indexes
 */
Datastore.prototype.updateIndexes = function (oldDoc, newDoc) {
  let failingIndex, error;
  const keys = Object.keys(this.indexes);

  for (let i = 0; i < keys.length; i += 1) {
    try {
      this.indexes[keys[i]].update(oldDoc, newDoc);
    } catch (e) {
      failingIndex = i;
      error = e;
      break;
    }
  }

  if (error) {
    for (let i = 0; i < failingIndex; i += 1) {
      this.indexes[keys[i]].revertUpdate(oldDoc, newDoc);
    }
    throw error;
  }
};


/**
 * Return the list of candidates for a given query
 */
Datastore.prototype.getCandidates = function (query, dontExpireStaleDocs, callback) {
  const indexNames = Object.keys(this.indexes);
  const self = this;
  let usableQueryKeys;

  if (typeof dontExpireStaleDocs === 'function') {
    callback = dontExpireStaleDocs;
    dontExpireStaleDocs = false;
  }

  // STEP 1: get candidates list by checking indexes
  let docs;

  // For a basic match
  usableQueryKeys = [];
  Object.keys(query).forEach(function (k) {
    if (typeof query[k] === 'string' || typeof query[k] === 'number' ||
        typeof query[k] === 'boolean' || query[k] instanceof Date || query[k] === null) {
      usableQueryKeys.push(k);
    }
  });
  usableQueryKeys = intersection(usableQueryKeys, indexNames);
  if (usableQueryKeys.length > 0) {
    docs = self.indexes[usableQueryKeys[0]].getMatching(query[usableQueryKeys[0]]);
  }

  // For a $in match
  if (!docs) {
    usableQueryKeys = [];
    Object.keys(query).forEach(function (k) {
      if (query[k] && query[k].hasOwnProperty('$in')) {
        usableQueryKeys.push(k);
      }
    });
    usableQueryKeys = intersection(usableQueryKeys, indexNames);
    if (usableQueryKeys.length > 0) {
      docs = self.indexes[usableQueryKeys[0]].getMatching(query[usableQueryKeys[0]].$in);
    }
  }

  // For a comparison match
  if (!docs) {
    usableQueryKeys = [];
    Object.keys(query).forEach(function (k) {
      if (query[k] && (query[k].hasOwnProperty('$lt') || query[k].hasOwnProperty('$lte') ||
          query[k].hasOwnProperty('$gt') || query[k].hasOwnProperty('$gte'))) {
        usableQueryKeys.push(k);
      }
    });
    usableQueryKeys = intersection(usableQueryKeys, indexNames);
    if (usableQueryKeys.length > 0) {
      docs = self.indexes[usableQueryKeys[0]].getBetweenBounds(query[usableQueryKeys[0]]);
    }
  }

  // By default, return all the DB data
  if (!docs) {
    docs = self.getAllData();
  }

  // STEP 2: remove all expired documents
  if (dontExpireStaleDocs) { return callback(null, docs); }

  const expiredDocsIds = [];
  const validDocs = [];
  const ttlIndexesFieldNames = Object.keys(self.ttlIndexes);

  docs.forEach(function (doc) {
    let valid = true;
    ttlIndexesFieldNames.forEach(function (i) {
      if (doc[i] !== undefined && doc[i] instanceof Date &&
          Date.now() > doc[i].getTime() + self.ttlIndexes[i] * 1000) {
        valid = false;
      }
    });
    if (valid) { validDocs.push(doc); } else { expiredDocsIds.push(doc._id); }
  });

  // Sequential removal of expired docs using a simple async helper
  const removeExpired = (ids, idx, done) => {
    if (idx >= ids.length) { return done(null); }
    self._remove({ _id: ids[idx] }, {}, function (err) {
      if (err) { return done(err); }
      removeExpired(ids, idx + 1, done);
    });
  };

  removeExpired(expiredDocsIds, 0, function (err) {
    if (err) { return callback(err); }
    return callback(null, validDocs);
  });
};


/**
 * Insert a new document
 * @api private
 */
Datastore.prototype._insert = function (newDoc, cb) {
  const callback = cb || function () {};
  let preparedDoc;

  try {
    preparedDoc = this.prepareDocumentForInsertion(newDoc);
    this._insertInCache(preparedDoc);
  } catch (e) {
    return callback(e);
  }

  const docsToPersist = Array.isArray(preparedDoc) ? preparedDoc : [preparedDoc];
  this.persistence.persistNewState(docsToPersist, function (err) {
    if (err) { return callback(err); }
    return callback(null, model.deepCopy(preparedDoc));
  });
};


/**
 * Create a new _id that's not already in use
 */
Datastore.prototype.createNewId = function () {
  let tentativeId = customUtils.uid(16);
  if (this.indexes._id.getMatching(tentativeId).length > 0) {
    tentativeId = this.createNewId();
  }
  return tentativeId;
};


/**
 * Prepare a document for insertion
 * @api private
 */
Datastore.prototype.prepareDocumentForInsertion = function (newDoc) {
  const self = this;

  if (Array.isArray(newDoc)) {
    const preparedDoc = [];
    newDoc.forEach(function (doc) { preparedDoc.push(self.prepareDocumentForInsertion(doc)); });
    return preparedDoc;
  } else {
    const preparedDoc = model.deepCopy(newDoc);
    if (preparedDoc._id === undefined) { preparedDoc._id = this.createNewId(); }
    const now = new Date();
    if (this.timestampData && preparedDoc.createdAt === undefined) { preparedDoc.createdAt = now; }
    if (this.timestampData && preparedDoc.updatedAt === undefined) { preparedDoc.updatedAt = now; }
    model.checkObject(preparedDoc);
    return preparedDoc;
  }
};


/**
 * @api private
 */
Datastore.prototype._insertInCache = function (preparedDoc) {
  if (Array.isArray(preparedDoc)) {
    this._insertMultipleDocsInCache(preparedDoc);
  } else {
    this.addToIndexes(preparedDoc);
  }
};


/**
 * @api private
 */
Datastore.prototype._insertMultipleDocsInCache = function (preparedDocs) {
  let failingI, error;

  for (let i = 0; i < preparedDocs.length; i += 1) {
    try {
      this.addToIndexes(preparedDocs[i]);
    } catch (e) {
      error = e;
      failingI = i;
      break;
    }
  }

  if (error) {
    for (let i = 0; i < failingI; i += 1) {
      this.removeFromIndexes(preparedDocs[i]);
    }
    throw error;
  }
};


// --- Public API with Promise support ---

Datastore.prototype.insert = function (newDoc, cb) {
  if (cb) {
    this.executor.push({ this: this, fn: this._insert, arguments: arguments });
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
};


/**
 * Count all documents matching the query
 */
Datastore.prototype.count = function (query, callback) {
  const cursor = new Cursor(this, query, function (err, docs, cb) {
    if (err) { return cb(err); }
    return cb(null, docs.length);
  });

  if (typeof callback === 'function') {
    cursor.exec(callback);
    return undefined;
  } else {
    return new Promise((resolve, reject) => {
      cursor.exec(function (err, result) {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }
};


/**
 * Find all documents matching the query
 */
Datastore.prototype.find = function (query, projection, callback) {
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

  const cursor = new Cursor(this, query, function (err, docs, cb) {
    if (err) { return cb(err); }

    const res = [];
    for (let i = 0; i < docs.length; i += 1) {
      res.push(model.deepCopy(docs[i]));
    }
    return cb(null, res);
  });

  cursor.projection(projection);
  if (typeof callback === 'function') {
    cursor.exec(callback);
    return undefined;
  } else {
    return new Promise((resolve, reject) => {
      cursor.exec(function (err, result) {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }
};


/**
 * Find one document matching the query
 */
Datastore.prototype.findOne = function (query, projection, callback) {
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

  const cursor = new Cursor(this, query, function (err, docs, cb) {
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
  } else {
    return new Promise((resolve, reject) => {
      cursor.exec(function (err, result) {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }
};


/**
 * Update all docs matching query
 * @api private
 */
Datastore.prototype._update = function (query, updateQuery, options, cb) {
  let callback;
  const self = this;
  let numReplaced = 0, multi, upsert;

  if (typeof options === 'function') { cb = options; options = {}; }
  callback = cb || function () {};
  multi = options.multi !== undefined ? options.multi : false;
  upsert = options.upsert !== undefined ? options.upsert : false;

  // STEP 1: If upsert, check if we need to insert
  const doUpdate = () => {
    if (!upsert) { return performUpdate(); }

    const cursor = new Cursor(self, query);
    cursor.limit(1)._exec(function (err, docs) {
      if (err) { return callback(err); }
      if (docs.length === 1) {
        return performUpdate();
      } else {
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

        return self._insert(toBeInserted, function (err, newDoc) {
          if (err) { return callback(err); }
          return callback(null, 1, newDoc, true);
        });
      }
    });
  };

  // STEP 2: Perform the update
  const performUpdate = () => {
    let modifiedDoc, modifications = [], createdAt;

    self.getCandidates(query, function (err, candidates) {
      if (err) { return callback(err); }

      try {
        for (let i = 0; i < candidates.length; i += 1) {
          if (model.match(candidates[i], query) && (multi || numReplaced === 0)) {
            numReplaced += 1;
            if (self.timestampData) { createdAt = candidates[i].createdAt; }
            modifiedDoc = model.modify(candidates[i], updateQuery);
            if (self.timestampData) {
              modifiedDoc.createdAt = createdAt;
              modifiedDoc.updatedAt = new Date();
            }
            modifications.push({ oldDoc: candidates[i], newDoc: modifiedDoc });
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
      self.persistence.persistNewState(updatedDocs, function (err) {
        if (err) { return callback(err); }
        if (!options.returnUpdatedDocs) {
          return callback(null, numReplaced);
        } else {
          const updatedDocsDC = updatedDocs.map(doc => model.deepCopy(doc));
          if (!multi) { return callback(null, numReplaced, updatedDocsDC[0]); }
          return callback(null, numReplaced, updatedDocsDC);
        }
      });
    });
  };

  doUpdate();
};

Datastore.prototype.update = function (query, updateQuery, options, cb) {
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
};


/**
 * Remove all docs matching query
 * @api private
 */
Datastore.prototype._remove = function (query, options, cb) {
  let callback;
  const self = this;
  let numRemoved = 0, removedDocs = [], multi;

  if (typeof options === 'function') { cb = options; options = {}; }
  callback = cb || function () {};
  multi = options.multi !== undefined ? options.multi : false;

  this.getCandidates(query, true, function (err, candidates) {
    if (err) { return callback(err); }

    try {
      candidates.forEach(function (d) {
        if (model.match(d, query) && (multi || numRemoved === 0)) {
          numRemoved += 1;
          removedDocs.push({ $$deleted: true, _id: d._id });
          self.removeFromIndexes(d);
        }
      });
    } catch (err2) { return callback(err2); }

    self.persistence.persistNewState(removedDocs, function (err) {
      if (err) { return callback(err); }
      return callback(null, numRemoved);
    });
  });
};

Datastore.prototype.remove = function (query, options, cb) {
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
};



module.exports = Datastore;