/**
 * Way data is stored for this database
 * For a Node.js/Node Webkit database it's the file system
 * For a browser-side database it's localforage, which uses the best backend available (IndexedDB then WebSQL then localStorage)
 *
 * This version is the browser version
 * Modernized P1: const/let, arrow functions
 */

const localforage = require('localforage');

// Configure localforage to display NeDB name for now. Would be a good idea to let user use his own app name
localforage.config({
  name: 'NeDB',
  storeName: 'nedbdata'
});


function exists(filename, callback) {
  localforage.getItem(filename, (err, value) => {
    if (value !== null) { // Even if value is undefined, localforage returns null
      return callback(true);
    } else {
      return callback(false);
    }
  });
}


function rename(filename, newFilename, callback) {
  localforage.getItem(filename, (err, value) => {
    if (value === null) {
      localforage.removeItem(newFilename, () => callback());
    } else {
      localforage.setItem(newFilename, value, () => {
        localforage.removeItem(filename, () => callback());
      });
    }
  });
}


function writeFile(filename, contents, options, callback) {
  // Options do not matter in browser setup
  if (typeof options === 'function') { callback = options; }
  localforage.setItem(filename, contents, () => callback());
}


function appendFile(filename, toAppend, options, callback) {
  // Options do not matter in browser setup
  if (typeof options === 'function') { callback = options; }

  localforage.getItem(filename, (err, contents) => {
    contents = contents || '';
    contents += toAppend;
    localforage.setItem(filename, contents, () => callback());
  });
}


function readFile(filename, options, callback) {
  // Options do not matter in browser setup
  if (typeof options === 'function') { callback = options; }
  localforage.getItem(filename, (err, contents) => callback(null, contents || ''));
}


function unlink(filename, callback) {
  localforage.removeItem(filename, () => callback());
}


// Nothing to do, no directories will be used on the browser
function mkdirp(dir, callback) {
  return callback();
}


// Nothing to do, no data corruption possible in the browser
function ensureDatafileIntegrity(filename, callback) {
  return callback(null);
}


// Interface
module.exports.exists = exists;
module.exports.rename = rename;
module.exports.writeFile = writeFile;
module.exports.crashSafeWriteFile = writeFile; // No need for a crash safe function in the browser
module.exports.appendFile = appendFile;
module.exports.readFile = readFile;
module.exports.unlink = unlink;
module.exports.mkdirp = mkdirp;
module.exports.ensureDatafileIntegrity = ensureDatafileIntegrity;
