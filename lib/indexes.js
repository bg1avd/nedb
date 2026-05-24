const BinarySearchTree = require('binary-search-tree').AVLTree;
const model = require('./model');


/**
 * Two indexed pointers are equal iif they point to the same place
 */
function checkValueEquality(a, b) {
  return a === b;
}


/**
 * Type-aware projection for unique constraint
 */
function projectForUnique(elt) {
  if (elt === null) { return '$null'; }
  if (typeof elt === 'string') { return '$string' + elt; }
  if (typeof elt === 'boolean') { return '$boolean' + elt; }
  if (typeof elt === 'number') { return '$number' + elt; }
  if (Array.isArray(elt)) { return '$date' + elt.getTime(); }

  return elt;   // Arrays and objects, will check for pointer equality
}


/**
 * Create a new index
 * @param {String} options.fieldName
 * @param {Boolean} options.unique Optional, enforce a unique constraint (default: false)
 * @param {Boolean} options.sparse Optional, allow a sparse index (default: false)
 */
function Index(options) {
  this.fieldName = options.fieldName;
  this.unique = options.unique || false;
  this.sparse = options.sparse || false;

  this.treeOptions = { unique: this.unique, compareKeys: model.compareThings, checkValueEquality: checkValueEquality };

  this.reset();   // No data in the beginning
}


/**
 * Reset an index
 * @param {Document or Array of documents} newData Optional
 */
Index.prototype.reset = function (newData) {
  this.tree = new BinarySearchTree(this.treeOptions);

  if (newData) { this.insert(newData); }
};


/**
 * Insert a new document in the index
 * O(log(n))
 */
Index.prototype.insert = function (doc) {
  const self = this;
  let key, keys, i, failingI, error;

  if (Array.isArray(doc)) { this.insertMultipleDocs(doc); return; }

  key = model.getDotValue(doc, this.fieldName);

  // We don't index documents that don't contain the field if the index is sparse
  if (key === undefined && this.sparse) { return; }

  if (!Array.isArray(key)) {
    this.tree.insert(key, doc);
  } else {
    // If an insert fails due to a unique constraint, roll back all inserts before it
    keys = uniqFast(key, projectForUnique);

    for (i = 0; i < keys.length; i += 1) {
      try {
        this.tree.insert(keys[i], doc);
      } catch (e) {
        error = e;
        failingI = i;
        break;
      }
    }

    if (error) {
      for (i = 0; i < failingI; i += 1) {
        this.tree.delete(keys[i], doc);
      }

      throw error;
    }
  }
};


/**
 * Insert an array of documents in the index
 * @API private
 */
Index.prototype.insertMultipleDocs = function (docs) {
  let i, error, failingI;

  for (i = 0; i < docs.length; i += 1) {
    try {
      this.insert(docs[i]);
    } catch (e) {
      error = e;
      failingI = i;
      break;
    }
  }

  if (error) {
    for (i = 0; i < failingI; i += 1) {
      this.remove(docs[i]);
    }

    throw error;
  }
};


/**
 * Remove a document from the index
 * O(log(n))
 */
Index.prototype.remove = function (doc) {
  const self = this;

  if (Array.isArray(doc)) { doc.forEach(function (d) { self.remove(d); }); return; }

  const key = model.getDotValue(doc, this.fieldName);

  if (key === undefined && this.sparse) { return; }

  if (!Array.isArray(key)) {
    this.tree.delete(key, doc);
  } else {
    uniqFast(key, projectForUnique).forEach(function (_key) {
      self.tree.delete(_key, doc);
    });
  }
};


/**
 * Update a document in the index
 * Naive implementation, still O(log(n))
 */
Index.prototype.update = function (oldDoc, newDoc) {
  if (Array.isArray(oldDoc)) { this.updateMultipleDocs(oldDoc); return; }

  this.remove(oldDoc);

  try {
    this.insert(newDoc);
  } catch (e) {
    this.insert(oldDoc);
    throw e;
  }
};


/**
 * Update multiple documents in the index
 * @API private
 */
Index.prototype.updateMultipleDocs = function (pairs) {
  let i, failingI, error;

  for (i = 0; i < pairs.length; i += 1) {
    this.remove(pairs[i].oldDoc);
  }

  for (i = 0; i < pairs.length; i += 1) {
    try {
      this.insert(pairs[i].newDoc);
    } catch (e) {
      error = e;
      failingI = i;
      break;
    }
  }

  // Roll back changes in inverse order
  if (error) {
    for (i = 0; i < failingI; i += 1) {
      this.remove(pairs[i].newDoc);
    }

    for (i = 0; i < pairs.length; i += 1) {
      this.insert(pairs[i].oldDoc);
    }

    throw error;
  }
};


/**
 * Revert an update
 */
Index.prototype.revertUpdate = function (oldDoc, newDoc) {
  if (!Array.isArray(oldDoc)) {
    this.update(newDoc, oldDoc);
  } else {
    const revert = oldDoc.map(function (pair) {
      return { oldDoc: pair.newDoc, newDoc: pair.oldDoc };
    });
    this.update(revert);
  }
};


/**
 * Get all documents in index whose key matches value
 */
Index.prototype.getMatching = function (value) {
  const self = this;

  if (!Array.isArray(value)) {
    return self.tree.search(value);
  } else {
    const _res = {};

    value.forEach(function (v) {
      self.getMatching(v).forEach(function (doc) {
        _res[doc._id] = doc;
      });
    });

    return Object.keys(_res).map(function (_id) { return _res[_id]; });
  }
};


/**
 * Get all documents in index whose key is between bounds
 */
Index.prototype.getBetweenBounds = function (query) {
  return this.tree.betweenBounds(query);
};


/**
 * Get all elements in the index
 */
Index.prototype.getAll = function () {
  const res = [];

  this.tree.executeOnEveryNode(function (node) {
    for (let i = 0; i < node.data.length; i += 1) {
      res.push(node.data[i]);
    }
  });

  return res;
};


// --- Polyfill for _.uniq with keyFn ---
function uniqFast(arr, keyFn) {
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


// Interface
module.exports = Index;