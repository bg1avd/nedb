/**
 * Handle every persistence-related task
 * Modernized P1: ES6 class, removed async dependency, template literals, for...of, arrow functions
 */

const storage = require('./storage');
const path = require('path');
const model = require('./model');
const customUtils = require('./customUtils');
const Index = require('./indexes');


class Persistence {
  /**
   * Create a new Persistence object for database options.db
   * @param {Datastore} options.db
   * @param {Boolean} options.nodeWebkitAppName Optional, deprecated
   */
  constructor(options) {
    this.db = options.db;
    this.inMemoryOnly = this.db.inMemoryOnly;
    this.filename = this.db.filename;
    this.corruptAlertThreshold = options.corruptAlertThreshold ?? 0.1;

    if (!this.inMemoryOnly && this.filename?.endsWith('~')) {
      throw new Error("The datafile name can't end with a ~, which is reserved for crash safe backup files");
    }

    // After serialization and before deserialization hooks with sanity checks
    if (options.afterSerialization && !options.beforeDeserialization) {
      throw new Error("Serialization hook defined but deserialization hook undefined, cautiously refusing to start NeDB to prevent dataloss");
    }
    if (!options.afterSerialization && options.beforeDeserialization) {
      throw new Error("Serialization hook undefined but deserialization hook defined, cautiously refusing to start NeDB to prevent dataloss");
    }
    this.afterSerialization = options.afterSerialization ?? (s => s);
    this.beforeDeserialization = options.beforeDeserialization ?? (s => s);

    for (let i = 1; i < 30; i++) {
      for (let j = 0; j < 10; j++) {
        const randomString = customUtils.uid(i);
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
   * Persist cached database
   * This serves as a compaction function
   */
  persistCachedDatabase(cb = () => {}) {
    if (this.inMemoryOnly) { return cb(null); }

    let toPersist = '';

    for (const doc of this.db.getAllData()) {
      toPersist += this.afterSerialization(model.serialize(doc)) + '\n';
    }

    for (const [fieldName, index] of Object.entries(this.db.indexes)) {
      if (fieldName !== '_id') {
        toPersist += this.afterSerialization(model.serialize({
          $$indexCreated: {
            fieldName,
            unique: index.unique,
            sparse: index.sparse
          }
        })) + '\n';
      }
    }

    storage.crashSafeWriteFile(this.filename, toPersist, function (err) {
      if (err) { return cb(err); }
      this.db.emit('compaction.done');
      return cb(null);
    }.bind(this));
  }

  /**
   * Queue a rewrite of the datafile
   */
  compactDatafile() {
    this.db.executor.push({ this: this, fn: this.persistCachedDatabase, arguments: [] });
  }

  /**
   * Set automatic compaction every interval ms
   */
  setAutocompactionInterval(interval) {
    const minInterval = 5000;
    const realInterval = Math.max(interval || 0, minInterval);

    this.stopAutocompaction();

    this.autocompactionIntervalId = setInterval(() => this.compactDatafile(), realInterval);
  }

  /**
   * Stop autocompaction
   */
  stopAutocompaction() {
    if (this.autocompactionIntervalId) { clearInterval(this.autocompactionIntervalId); }
  }

  /**
   * Persist new state for the given newDocs (can be insertion, update or removal)
   * Use an append-only format
   */
  persistNewState(newDocs, cb = () => {}) {
    if (this.inMemoryOnly) { return cb(null); }

    let toPersist = '';
    for (const doc of newDocs) {
      toPersist += this.afterSerialization(model.serialize(doc)) + '\n';
    }

    if (toPersist.length === 0) { return cb(null); }

    storage.appendFile(this.filename, toPersist, 'utf8', (err) => {
      return cb(err);
    });
  }

  /**
   * From a database's raw data, return the corresponding
   * machine understandable collection
   */
  treatRawData(rawData) {
    const data = rawData.split('\n');
    const dataById = new Map();
    const tdata = [];
    const indexes = {};
    let corruptItems = -1; // Last line of every data file is usually blank

    for (const line of data) {
      try {
        const doc = model.deserialize(this.beforeDeserialization(line));
        if (doc._id) {
          if (doc.$$deleted === true) {
            dataById.delete(doc._id);
          } else {
            dataById.set(doc._id, doc);
          }
        } else if (doc.$$indexCreated?.fieldName !== undefined) {
          indexes[doc.$$indexCreated.fieldName] = doc.$$indexCreated;
        } else if (typeof doc.$$indexRemoved === 'string') {
          delete indexes[doc.$$indexRemoved];
        }
      } catch (e) {
        corruptItems += 1;
      }
    }

    // A bit lenient on corruption
    if (data.length > 0 && corruptItems / data.length > this.corruptAlertThreshold) {
      throw new Error(`More than ${Math.floor(100 * this.corruptAlertThreshold)}% of the data file is corrupt, the wrong beforeDeserialization hook may be used. Cautiously refusing to start NeDB to prevent dataloss`);
    }

    for (const doc of dataById.values()) {
      tdata.push(doc);
    }

    return { data: tdata, indexes };
  }

  /**
   * Load the database
   */
  loadDatabase(cb = () => {}) {
    this.db.resetIndexes();

    // In-memory only datastore
    if (this.inMemoryOnly) { return cb(null); }

    // Sequential waterfall using nested callbacks
    Persistence.ensureDirectoryExists(path.dirname(this.filename), (err) => {
      if (err) { return cb(err); }

      storage.ensureDatafileIntegrity(this.filename, (err) => {
        if (err) { return cb(err); }

        storage.readFile(this.filename, 'utf8', (err, rawData) => {
          if (err) { return cb(err); }

          let treatedData;
          try {
            treatedData = this.treatRawData(rawData);
          } catch (e) {
            return cb(e);
          }

          // Recreate all indexes in the datafile
          for (const [key, indexData] of Object.entries(treatedData.indexes)) {
            this.db.indexes[key] = new Index(indexData);
          }

          // Fill cached database (i.e. all indexes) with data
          try {
            this.db.resetIndexes(treatedData.data);
          } catch (e) {
            this.db.resetIndexes(); // Rollback
            return cb(e);
          }

          this.db.persistence.persistCachedDatabase((err) => {
            if (err) { return cb(err); }

            this.db.executor.processBuffer();
            return cb(null);
          });
        });
      });
    });
  }

  /**
   * Check if a directory exists and create it on the fly if it is not the case
   */
  static ensureDirectoryExists(dir, cb = () => {}) {
    storage.mkdirp(dir, (err) => cb(err));
  }

  /**
   * Return the path the datafile if the given filename is relative to NW app data dir
   */
  static getNWAppFilename(appName, relativeFilename) {
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
        throw new Error(`Can't use the Node Webkit relative path for platform ${process.platform}`);
    }

    return path.join(home, 'nedb-data', relativeFilename);
  }
}


// Interface
module.exports = Persistence;
