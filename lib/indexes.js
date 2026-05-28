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
  if (typeof elt === 'string') { return `$string${elt}`; }
  if (typeof elt === 'boolean') { return `$boolean${elt}`; }
  if (typeof elt === 'number') { return `$number${elt}`; }
  if (Array.isArray(elt)) { return `$date${elt.getTime()}`; }

  return elt; // Arrays and objects, will check for pointer equality
}

/**
 * Fast uniq helper using Set-like behavior with keyFn
 */
function uniqFast(arr, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(item);
    }
  }
  return result;
}


/**
 * Create a new index
 * @param {String} options.fieldName
 * @param {Boolean} options.unique Optional, enforce a unique constraint (default: false)
 * @param {Boolean} options.sparse Optional, allow a sparse index (default: false)
 */
class Index {
  constructor(options) {
    this.fieldName = options.fieldName;
    this.unique = options.unique ?? false;
    this.sparse = options.sparse ?? false;

    this.treeOptions = { unique: this.unique, compareKeys: model.compareThings, checkValueEquality };

    this.reset(); // No data in the beginning
  }

  /**
   * Reset an index
   * @param {Document or Array of documents} newData Optional
   */
  reset(newData) {
    this.tree = new BinarySearchTree(this.treeOptions);
    if (newData) { this.insert(newData); }
  }

  /**
   * Insert a new document in the index
   * O(log(n))
   */
  insert(doc) {
    if (Array.isArray(doc)) { this.insertMultipleDocs(doc); return; }

    const key = model.getDotValue(doc, this.fieldName);

    // We don't index documents that don't contain the field if the index is sparse
    if (key === undefined && this.sparse) { return; }

    if (!Array.isArray(key)) {
      this.tree.insert(key, doc);
    } else {
      // If an insert fails due to a unique constraint, roll back all inserts before it
      const keys = uniqFast(key, projectForUnique);
      let failingI, error;

      for (let i = 0; i < keys.length; i++) {
        try {
          this.tree.insert(keys[i], doc);
        } catch (e) {
          error = e;
          failingI = i;
          break;
        }
      }

      if (error) {
        for (let i = 0; i < failingI; i++) {
          this.tree.delete(keys[i], doc);
        }
        throw error;
      }
    }
  }

  /**
   * Insert an array of documents in the index
   * @API private
   */
  insertMultipleDocs(docs) {
    let failingI, error;

    for (let i = 0; i < docs.length; i++) {
      try {
        this.insert(docs[i]);
      } catch (e) {
        error = e;
        failingI = i;
        break;
      }
    }

    if (error) {
      for (let i = 0; i < failingI; i++) {
        this.remove(docs[i]);
      }
      throw error;
    }
  }

  /**
   * Remove a document from the index
   * O(log(n))
   */
  remove(doc) {
    if (Array.isArray(doc)) { doc.forEach(d => this.remove(d)); return; }

    const key = model.getDotValue(doc, this.fieldName);

    if (key === undefined && this.sparse) { return; }

    if (!Array.isArray(key)) {
      this.tree.delete(key, doc);
    } else {
      uniqFast(key, projectForUnique).forEach(_key => {
        this.tree.delete(_key, doc);
      });
    }
  }

  /**
   * Update a document in the index
   * Naive implementation, still O(log(n))
   */
  update(oldDoc, newDoc) {
    if (Array.isArray(oldDoc)) { this.updateMultipleDocs(oldDoc); return; }

    this.remove(oldDoc);

    try {
      this.insert(newDoc);
    } catch (e) {
      this.insert(oldDoc);
      throw e;
    }
  }

  /**
   * Update multiple documents in the index
   * @API private
   */
  updateMultipleDocs(pairs) {
    let failingI, error;

    for (let i = 0; i < pairs.length; i++) {
      this.remove(pairs[i].oldDoc);
    }

    for (let i = 0; i < pairs.length; i++) {
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
      for (let i = 0; i < failingI; i++) {
        this.remove(pairs[i].newDoc);
      }

      for (const pair of pairs) {
        this.insert(pair.oldDoc);
      }

      throw error;
    }
  }

  /**
   * Revert an update
   */
  revertUpdate(oldDoc, newDoc) {
    if (!Array.isArray(oldDoc)) {
      this.update(newDoc, oldDoc);
    } else {
      const revert = oldDoc.map(pair => ({ oldDoc: pair.newDoc, newDoc: pair.oldDoc }));
      this.update(revert);
    }
  }

  /**
   * Get all documents in index whose key matches value
   */
  getMatching(value) {
    if (!Array.isArray(value)) {
      return this.tree.search(value);
    }

    const resultMap = new Map();
    for (const v of value) {
      for (const doc of this.getMatching(v)) {
        resultMap.set(doc._id, doc);
      }
    }
    return [...resultMap.values()];
  }

  /**
   * Get all documents in index whose key is between bounds
   */
  getBetweenBounds(query) {
    return this.tree.betweenBounds(query);
  }

  /**
   * Get all elements in the index
   */
  getAll() {
    const res = [];

    this.tree.executeOnEveryNode((node) => {
      for (let i = 0; i < node.data.length; i++) {
        res.push(node.data[i]);
      }
    });

    return res;
  }
}


// Interface
module.exports = Index;
