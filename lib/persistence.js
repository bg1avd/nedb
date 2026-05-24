/**
 * Handle every persistence-related task
 * Modernized: removed async dependency, using native Promise chain
 */

const storage = require('./storage');
const path = require('path');
const model = require('./model');
const customUtils = require('./customUtils');
const Index = require('./indexes');


/**
 * Create a new Persistence object for database options.db
 * @param {Datastore} options.db
 * @param {Boolean} options.nodeWebkitAppName Optional, deprecated
 */
function Persistence(options) {
  let randomString, i, j;

  this.db = options.db;
  this.inMemoryOnly = this.db.inMemoryOnly;
  this.filename = this.db.filename;
  this.corruptAlertThreshold = options.corruptAlertThreshold !== undefined ? options.corruptAlertThreshold : 0.1;

  if (!this.inMemoryOnly && this.filename && this.filename.charAt(this.filename.length - 1) === '~') {
    throw new Error("The datafile name can't end with a ~, which is reserved for crash safe backup files");
  }

  // After serialization and before deserialization hooks with sanity checks
  if (options.afterSerialization && !options.beforeDeserialization) {
    throw new Error("Serialization hook defined but deserialization hook undefined, cautiously refusing to start NeDB to prevent dataloss");
  }
  if (!options.afterSerialization && options.beforeDeserialization) {
    throw new Error("Serialization hook undefined but deserialization hook defined, cautiously refusing to start NeDB to prevent dataloss");
  }
  this.afterSerialization = options.afterSerialization || function (s) { return s; };
  this.beforeDeserialization = options.beforeDeserialization || function (s) { return s; };
  for (i = 1; i < 30; i += 1) {
    for (j = 0; j < 10; j += 1) {
      randomString = customUtils.uid(i);
      if (this.beforeDeserialization(this.afterSerialization(randomString)) !== randomString) {
        throw new Error("beforeDeserialization is not the reverse of afterSerialization, cautiously refusing to start NeDB to prevent dataloss");
      }
    }
  }

  // For NW apps (deprecated)
  if (this.filename && options.nodeWebkitAppName) {
    console.log("==================================================================");
    console.log("WARNING: The nodeWebkitAppName option is deprecated");
    console.log("To get the path to the directory where Node Webkit stores the data");
    console.log("for your app, use the internal nw.gui module like this");
    console.log("require('nw.gui').App.dataPath");
    console.log("See https://github.com/rogerwang/node-webkit/issues/500");
    console.log("==================================================================");
    this.filename = Persistence.getNWAppFilename(options.nodeWebkitAppName, this.filename);
  }
}


/**
 * Check if a directory exists and create it on the fly if it is not the case
 */
Persistence.ensureDirectoryExists = function (dir, cb) {
  const callback = cb || function () {};

  storage.mkdirp(dir, function (err) { return callback(err); });
};


/**
 * Return the path the datafile if the given filename is relative to NW app data dir
 */
Persistence.getNWAppFilename = function (appName, relativeFilename) {
  let home;

  switch (process.platform) {
    case 'win32':
    case 'win64':
      home = process.env.LOCALAPPDATA || process.env.APPDATA;
      if (!home) { throw new Error("Couldn't find the base application data folder"); }
      home = path.join(home, appName);
      break;
    case 'darwin':
      home = process.env.HOME;
      if (!home) { throw new Error("Couldn't find the base application data directory"); }
      home = path.join(home, 'Library', 'Application Support', appName);
      break;
    case 'linux':
      home = process.env.HOME;
      if (!home) { throw new Error("Couldn't find the base application data directory"); }
      home = path.join(home, '.config', appName);
      break;
    default:
      throw new Error("Can't use the Node Webkit relative path for platform " + process.platform);
  }

  return path.join(home, 'nedb-data', relativeFilename);
};


/**
 * Persist cached database
 * This serves as a compaction function
 */
Persistence.prototype.persistCachedDatabase = function (cb) {
  const callback = cb || function () {};
  const self = this;

  if (this.inMemoryOnly) { return callback(null); }

  let toPersist = '';

  this.db.getAllData().forEach(function (doc) {
    toPersist += self.afterSerialization(model.serialize(doc)) + '\n';
  });
  Object.keys(this.db.indexes).forEach(function (fieldName) {
    if (fieldName != "_id") {
      toPersist += self.afterSerialization(model.serialize({
        $$indexCreated: {
          fieldName: fieldName,
          unique: self.db.indexes[fieldName].unique,
          sparse: self.db.indexes[fieldName].sparse
        }
      })) + '\n';
    }
  });

  storage.crashSafeWriteFile(this.filename, toPersist, function (err) {
    if (err) { return callback(err); }
    self.db.emit('compaction.done');
    return callback(null);
  });
};


/**
 * Queue a rewrite of the datafile
 */
Persistence.prototype.compactDatafile = function () {
  this.db.executor.push({ this: this, fn: this.persistCachedDatabase, arguments: [] });
};


/**
 * Set automatic compaction every interval ms
 */
Persistence.prototype.setAutocompactionInterval = function (interval) {
  const self = this;
  const minInterval = 5000;
  const realInterval = Math.max(interval || 0, minInterval);

  this.stopAutocompaction();

  this.autocompactionIntervalId = setInterval(function () {
    self.compactDatafile();
  }, realInterval);
};


/**
 * Stop autocompaction
 */
Persistence.prototype.stopAutocompaction = function () {
  if (this.autocompactionIntervalId) { clearInterval(this.autocompactionIntervalId); }
};


/**
 * Persist new state for the given newDocs (can be insertion, update or removal)
 * Use an append-only format
 */
Persistence.prototype.persistNewState = function (newDocs, cb) {
  const self = this;
  const callback = cb || function () {};

  // In-memory only datastore
  if (self.inMemoryOnly) { return callback(null); }

  let toPersist = '';
  newDocs.forEach(function (doc) {
    toPersist += self.afterSerialization(model.serialize(doc)) + '\n';
  });

  if (toPersist.length === 0) { return callback(null); }

  storage.appendFile(self.filename, toPersist, 'utf8', function (err) {
    return callback(err);
  });
};


/**
 * From a database's raw data, return the corresponding
 * machine understandable collection
 */
Persistence.prototype.treatRawData = function (rawData) {
  const data = rawData.split('\n');
  const dataById = {};
  const tdata = [];
  const indexes = {};
  let corruptItems = -1;   // Last line of every data file is usually blank

  for (let i = 0; i < data.length; i += 1) {
    let doc;

    try {
      doc = model.deserialize(this.beforeDeserialization(data[i]));
      if (doc._id) {
        if (doc.$$deleted === true) {
          delete dataById[doc._id];
        } else {
          dataById[doc._id] = doc;
        }
      } else if (doc.$$indexCreated && doc.$$indexCreated.fieldName != undefined) {
        indexes[doc.$$indexCreated.fieldName] = doc.$$indexCreated;
      } else if (typeof doc.$$indexRemoved === "string") {
        delete indexes[doc.$$indexRemoved];
      }
    } catch (e) {
      corruptItems += 1;
    }
  }

  // A bit lenient on corruption
  if (data.length > 0 && corruptItems / data.length > this.corruptAlertThreshold) {
    throw new Error("More than " + Math.floor(100 * this.corruptAlertThreshold) + "% of the data file is corrupt, the wrong beforeDeserialization hook may be used. Cautiously refusing to start NeDB to prevent dataloss");
  }

  Object.keys(dataById).forEach(function (k) {
    tdata.push(dataById[k]);
  });

  return { data: tdata, indexes: indexes };
};


/**
 * Load the database
 */
Persistence.prototype.loadDatabase = function (cb) {
  const callback = cb || function () {};
  const self = this;

  self.db.resetIndexes();

  // In-memory only datastore
  if (self.inMemoryOnly) { return callback(null); }

  // Sequential waterfall using chain
  Persistence.ensureDirectoryExists(path.dirname(self.filename), function (err) {
    if (err) { return callback(err); }

    storage.ensureDatafileIntegrity(self.filename, function (err) {
      if (err) { return callback(err); }

      storage.readFile(self.filename, 'utf8', function (err, rawData) {
        if (err) { return callback(err); }

        let treatedData;
        try {
          treatedData = self.treatRawData(rawData);
        } catch (e) {
          return callback(e);
        }

        // Recreate all indexes in the datafile
        Object.keys(treatedData.indexes).forEach(function (key) {
          self.db.indexes[key] = new Index(treatedData.indexes[key]);
        });

        // Fill cached database (i.e. all indexes) with data
        try {
          self.db.resetIndexes(treatedData.data);
        } catch (e) {
          self.db.resetIndexes();   // Rollback
          return callback(e);
        }

        self.db.persistence.persistCachedDatabase(function (err) {
          if (err) { return callback(err); }

          self.db.executor.processBuffer();
          return callback(null);
        });
      });
    });
  });
};


// Interface
module.exports = Persistence;