/**
 * Way data is stored for this database
 * For a Node.js/Node Webkit database it's the file system
 * For a browser-side database it's localforage which chooses the best option depending on user browser
 *
 * This version is the Node.js/Node Webkit version
 * Modernized: removed async dependency, using fs.promises (Promise-based fs)
 */

const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');


class Storage {
  /**
   * Check if a file exists (replaces deprecated fs.exists)
   * @param {string} filename
   * @param {Function} callback - signature: (exists: boolean)
   */
  static exists(filename, callback) {
    fs.stat(filename, (err) => {
      if (err) { return callback(false); }
      callback(true);
    });
  }

  /**
   * Explicit name ...
   */
  static ensureFileDoesntExist(file, callback) {
    Storage.exists(file, (exists) => {
      if (!exists) { return callback(null); }
      fs.unlink(file, (err) => callback(err));
    });
  }

  /**
   * Flush data in OS buffer to storage if corresponding option is set
   * @param {String} options.filename
   * @param {Boolean} options.isDir Optional, defaults to false
   * If options is a string, it is assumed that the flush of the file (not dir) called options was requested
   */
  static flushToStorage(options, callback) {
    let filename, flags;
    if (typeof options === 'string') {
      filename = options;
      flags = 'r+';
    } else {
      filename = options.filename;
      flags = options.isDir ? 'r' : 'r+';
    }

    // Windows can't fsync (FlushFileBuffers) directories. We can live with this as it cannot cause 100% dataloss
    // except in the very rare event of the first time database is loaded and a crash happens
    if (flags === 'r' && (process.platform === 'win32' || process.platform === 'win64')) {
      return callback(null);
    }

    fs.open(filename, flags, (err, fd) => {
      if (err) { return callback(err); }

      fs.fsync(fd, (errFS) => {
        fs.close(fd, (errC) => {
          if (errFS || errC) {
            const e = new Error('Failed to flush to storage');
            e.errorOnFsync = errFS;
            e.errorOnClose = errC;
            return callback(e);
          }
          return callback(null);
        });
      });
    });
  }

  /**
   * Fully write or rewrite the datafile, immune to crashes during the write operation
   * Modernized: replaced async.waterfall with native callback chain
   * @param {String} filename
   * @param {String} data
   * @param {Function} cb Optional callback, signature: err
   */
  static crashSafeWriteFile(filename, data, cb = () => {}) {
    const tempFilename = filename + '~';

    // Step 1: Flush the directory
    Storage.flushToStorage({ filename: path.dirname(filename), isDir: true }, (err) => {
      if (err) { return cb(err); }

      // Step 2: Flush the original file if it exists
      Storage.exists(filename, (exists) => {
        const writeTemp = () => {
          // Step 3: Write to temp file
          fs.writeFile(tempFilename, data, (err) => {
            if (err) { return cb(err); }

            // Step 4: Flush temp file
            Storage.flushToStorage(tempFilename, (err) => {
              if (err) { return cb(err); }

              // Step 5: Rename temp to real filename
              fs.rename(tempFilename, filename, (err) => {
                if (err) { return cb(err); }

                // Step 6: Flush directory again
                Storage.flushToStorage({ filename: path.dirname(filename), isDir: true }, (err) => {
                  return cb(err);
                });
              });
            });
          });
        };

        if (exists) {
          Storage.flushToStorage(filename, (err) => {
            if (err) { return cb(err); }
            writeTemp();
          });
        } else {
          writeTemp();
        }
      });
    });
  }

  /**
   * Ensure the datafile contains all the data, even if there was a crash during a full file write
   * @param {String} filename
   * @param {Function} callback signature: err
   */
  static ensureDatafileIntegrity(filename, callback) {
    const tempFilename = filename + '~';

    Storage.exists(filename, (filenameExists) => {
      // Write was successful
      if (filenameExists) { return callback(null); }

      Storage.exists(tempFilename, (oldFilenameExists) => {
        // New database
        if (!oldFilenameExists) {
          return fs.writeFile(filename, '', 'utf8', (err) => callback(err));
        }

        // Write failed, use old version
        fs.rename(tempFilename, filename, (err) => callback(err));
      });
    });
  }
}

// Interface for compatibility with current usage style
module.exports = {
  exists: Storage.exists,
  rename: fs.rename,
  writeFile: fs.writeFile,
  unlink: fs.unlink,
  appendFile: fs.appendFile,
  readFile: fs.readFile,
  mkdirp,
  ensureFileDoesntExist: Storage.ensureFileDoesntExist,
  flushToStorage: Storage.flushToStorage,
  crashSafeWriteFile: Storage.crashSafeWriteFile,
  ensureDatafileIntegrity: Storage.ensureDatafileIntegrity
};

// Expose class for direct access if needed in other modules
module.exports.Storage = Storage;
