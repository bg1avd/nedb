/**
 * Manage access to data, be it to find, update or remove it
 * Modernized: removed underscore dependency
 */
const model = require('./model');


/**
 * Create a new cursor for this collection
 * @param {Datastore} db - The datastore this cursor is bound to
 * @param {Query} query - The query this cursor will operate on
 * @param {Function} execFn - Handler to be executed after cursor has found the results
 */
function Cursor(db, query, execFn) {
  this.db = db;
  this.query = query || {};
  if (execFn) { this.execFn = execFn; }
}


/**
 * Set a limit to the number of results
 */
Cursor.prototype.limit = function (limit) {
  this._limit = limit;
  return this;
};


/**
 * Skip a the number of results
 */
Cursor.prototype.skip = function (skip) {
  this._skip = skip;
  return this;
};


/**
 * Sort results of the query
 * @param {SortQuery} sortQuery - SortQuery is { field: order }, field can use the dot-notation, order is 1 for ascending and -1 for descending
 */
Cursor.prototype.sort = function (sortQuery) {
  this._sort = sortQuery;
  return this;
};


/**
 * Add the use of a projection
 * @param {Object} projection - MongoDB-style projection
 */
Cursor.prototype.projection = function (projection) {
  this._projection = projection;
  return this;
};


/**
 * Apply the projection
 */
Cursor.prototype.project = function (candidates) {
  const self = this;
  let keepId, action, keys;

  if (this._projection === undefined || Object.keys(this._projection).length === 0) {
    return candidates;
  }

  keepId = this._projection._id === 0 ? false : true;

  // Build projection without _id to determine action
  const projWithoutId = {};
  Object.keys(this._projection).forEach(k => {
    if (k !== '_id') { projWithoutId[k] = this._projection[k]; }
  });

  // Check for consistency
  keys = Object.keys(projWithoutId);
  keys.forEach(function (k) {
    if (action !== undefined && projWithoutId[k] !== action) {
      throw new Error("Can't both keep and omit fields except for _id");
    }
    action = projWithoutId[k];
  });

  // Do the actual projection
  const res = [];
  candidates.forEach(function (candidate) {
    let toPush;
    if (action === 1) {   // pick-type projection
      toPush = { $set: {} };
      keys.forEach(function (k) {
        toPush.$set[k] = model.getDotValue(candidate, k);
        if (toPush.$set[k] === undefined) { delete toPush.$set[k]; }
      });
      toPush = model.modify({}, toPush);
    } else {   // omit-type projection
      toPush = { $unset: {} };
      keys.forEach(function (k) { toPush.$unset[k] = true; });
      toPush = model.modify(candidate, toPush);
    }
    if (keepId) {
      toPush._id = candidate._id;
    } else {
      delete toPush._id;
    }
    res.push(toPush);
  });

  return res;
};


/**
 * Get all matching elements
 * This is an internal function, use exec which uses the executor
 *
 * @param {Function} _callback - Signature: err, results
 */
Cursor.prototype._exec = function (_callback) {
  const self = this;
  let error = null;

  function callback(error, res) {
    if (self.execFn) {
      return self.execFn(error, res, _callback);
    } else {
      return _callback(error, res);
    }
  }

  this.db.getCandidates(this.query, function (err, candidates) {
    if (err) { return callback(err); }

    let res = [];
    try {
      if (!self._sort) {
        let added = 0, skipped = 0;
        for (let i = 0; i < candidates.length; i += 1) {
          if (model.match(candidates[i], self.query)) {
            if (self._skip && self._skip > skipped) {
              skipped += 1;
            } else {
              res.push(candidates[i]);
              added += 1;
              if (self._limit && self._limit <= added) { break; }
            }
          }
        }
      } else {
        for (let i = 0; i < candidates.length; i += 1) {
          if (model.match(candidates[i], self.query)) {
            res.push(candidates[i]);
          }
        }
      }
    } catch (err2) {
      return callback(err2);
    }

    // Apply all sorts
    if (self._sort) {
      const keys = Object.keys(self._sort);

      // Sorting
      const criteria = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        criteria.push({ key: key, direction: self._sort[key] });
      }
      res.sort(function (a, b) {
        for (let i = 0; i < criteria.length; i++) {
          const criterion = criteria[i];
          const compare = criterion.direction * model.compareThings(
            model.getDotValue(a, criterion.key),
            model.getDotValue(b, criterion.key),
            self.db.compareStrings
          );
          if (compare !== 0) {
            return compare;
          }
        }
        return 0;
      });

      // Applying limit and skip
      const limit = self._limit || res.length;
      const skip = self._skip || 0;

      res = res.slice(skip, skip + limit);
    }

    // Apply projection
    try {
      res = self.project(res);
    } catch (e) {
      error = e;
      res = undefined;
    }

    return callback(error, res);
  });
};

Cursor.prototype.exec = function () {
  this.db.executor.push({ this: this, fn: this._exec, arguments: arguments });
};



// Interface
module.exports = Cursor;