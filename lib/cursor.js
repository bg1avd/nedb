/**
 * Manage access to data, be it to find, update or remove it
 * Modernized P1: ES6 class, removed underscore dependency, arrow functions, for...of
 */
const model = require('./model');


class Cursor {
  /**
   * Create a new cursor for this collection
   * @param {Datastore} db - The datastore this cursor is bound to
   * @param {Query} query - The query this cursor will operate on
   * @param {Function} execFn - Handler to be executed after cursor has found the results
   */
  constructor(db, query, execFn) {
    this.db = db;
    this.query = query || {};
    if (execFn) { this.execFn = execFn; }
  }

  /**
   * Set a limit to the number of results
   */
  limit(limit) {
    this._limit = limit;
    return this;
  }

  /**
   * Skip a the number of results
   */
  skip(skip) {
    this._skip = skip;
    return this;
  }

  /**
   * Sort results of the query
   * @param {SortQuery} sortQuery - SortQuery is { field: order }, field can use the dot-notation, order is 1 for ascending and -1 for descending
   */
  sort(sortQuery) {
    this._sort = sortQuery;
    return this;
  }

  /**
   * Add the use of a projection
   * @param {Object} projection - MongoDB-style projection
   */
  projection(projection) {
    this._projection = projection;
    return this;
  }

  /**
   * Apply the projection
   */
  project(candidates) {
    if (this._projection === undefined || Object.keys(this._projection).length === 0) {
      return candidates;
    }

    const keepId = this._projection._id !== 0;
    const projWithoutId = {};
    for (const [k, v] of Object.entries(this._projection)) {
      if (k !== '_id') { projWithoutId[k] = v; }
    }

    // Check for consistency — all values should be same (0 or 1)
    const keys = Object.keys(projWithoutId);
    let action;
    for (const k of keys) {
      if (action !== undefined && projWithoutId[k] !== action) {
        throw new Error("Can't both keep and omit fields except for _id");
      }
      action = projWithoutId[k];
    }

    return candidates.map(candidate => {
      let toPush;
      if (action === 1) { // pick-type projection
        const $set = {};
        for (const k of keys) {
          const val = model.getDotValue(candidate, k);
          if (val !== undefined) { $set[k] = val; }
        }
        toPush = model.modify({}, { $set });
      } else { // omit-type projection
        const $unset = {};
        for (const k of keys) { $unset[k] = true; }
        toPush = model.modify(candidate, { $unset });
      }

      if (keepId) {
        toPush._id = candidate._id;
      } else {
        delete toPush._id;
      }
      return toPush;
    });
  }

  /**
   * Get all matching elements
   * This is an internal function, use exec which uses the executor
   *
   * @param {Function} _callback - Signature: err, results
   */
  _exec(_callback) {
    const self = this;

    const callback = (error, res) => {
      if (self.execFn) {
        return self.execFn(error, res, _callback);
      } else {
        return _callback(error, res);
      }
    };

    this.db.getCandidates(this.query, (err, candidates) => {
      if (err) { return callback(err); }

      let res = [];
      try {
        if (!self._sort) {
          let added = 0, skipped = 0;
          for (const candidate of candidates) {
            if (model.match(candidate, self.query)) {
              if (self._skip && self._skip > skipped) {
                skipped += 1;
              } else {
                res.push(candidate);
                added += 1;
                if (self._limit && self._limit <= added) { break; }
              }
            }
          }
        } else {
          for (const candidate of candidates) {
            if (model.match(candidate, self.query)) {
              res.push(candidate);
            }
          }
        }
      } catch (err2) {
        return callback(err2);
      }

      // Apply all sorts
      if (self._sort) {
        const criteria = Object.entries(self._sort).map(([key, direction]) => ({ key, direction }));

        res.sort((a, b) => {
          for (const { key, direction } of criteria) {
            const compare = direction * model.compareThings(
              model.getDotValue(a, key),
              model.getDotValue(b, key),
              self.db.compareStrings
            );
            if (compare !== 0) { return compare; }
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
        return callback(e, undefined);
      }

      return callback(null, res);
    });
  }

  exec(...args) {
    this.db.executor.push({ this: this, fn: this._exec, arguments: args });
  }

  /**
   * Make Cursor thenable so it can be awaited directly
   * This allows: const docs = await db.find({}).sort({ age: -1 }).limit(10);
   */
  then(resolve, reject) {
    return new Promise((res, rej) => {
      this.exec((err, result) => {
        if (err) { return rej(err); }
        res(result);
      });
    }).then(resolve, reject);
  }

  catch(reject) {
    return this.then().catch(reject);
  }
}


// Interface
module.exports = Cursor;
