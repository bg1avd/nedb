/**
 * Handle models (i.e. docs)
 * Serialization/deserialization
 * Copying
 * Querying, update
 *
 * Modernized: removed underscore dependency, using native methods
 */

const modifierFunctions = {};
const lastStepModifierFunctions = {};
const comparisonFunctions = {};
const logicalOperators = {};
const arrayComparisonFunctions = {};


/**
 * Check a key, throw an error if the key is non valid
 * @param {String} k key
 * @param {Model} v value
 */
function checkKey(k, v) {
  if (typeof k === 'number') {
    k = k.toString();
  }

  if (k[0] === '$' && !(k === '$$date' && typeof v === 'number') &&
      !(k === '$$deleted' && v === true) &&
      !(k === '$$indexCreated') &&
      !(k === '$$indexRemoved')) {
    throw new Error('Field names cannot begin with the $ character');
  }

  if (k.indexOf('.') !== -1) {
    throw new Error('Field names cannot contain a .');
  }
}


/**
 * Check a DB object and throw an error if it's not valid
 */
function checkObject(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(function (o) {
      checkObject(o);
    });
  }

  if (typeof obj === 'object' && obj !== null) {
    Object.keys(obj).forEach(function (k) {
      checkKey(k, obj[k]);
      checkObject(obj[k]);
    });
  }
}


/**
 * Serialize an object to be persisted to a one-line string
 */
function serialize(obj) {
  const res = JSON.stringify(obj, function (k, v) {
    checkKey(k, v);

    if (v === undefined) { return undefined; }
    if (v === null) { return null; }

    // Hackish way of checking if object is Date
    if (typeof this[k].getTime === 'function') {
      return { $$date: this[k].getTime() };
    }

    return v;
  });

  return res;
}


/**
 * From a one-line representation of an object generate by the serialize function
 */
function deserialize(rawData) {
  return JSON.parse(rawData, function (k, v) {
    if (k === '$$date') { return new Date(v); }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      return v;
    }
    if (v && v.$$date) { return v.$$date; }

    return v;
  });
}


/**
 * Deep copy a DB object
 */
function deepCopy(obj, strictKeys) {
  let res;

  if (typeof obj === 'boolean' ||
      typeof obj === 'number' ||
      typeof obj === 'string' ||
      obj === null ||
      (obj instanceof Date)) {
    return obj;
  }

  if (Array.isArray(obj)) {
    res = [];
    obj.forEach(function (o) { res.push(deepCopy(o, strictKeys)); });
    return res;
  }

  if (typeof obj === 'object') {
    res = {};
    Object.keys(obj).forEach(function (k) {
      if (!strictKeys || (k[0] !== '$' && k.indexOf('.') === -1)) {
        res[k] = deepCopy(obj[k], strictKeys);
      }
    });
    return res;
  }

  return undefined;
}


/**
 * Tells if an object is a primitive type or a "real" object
 */
function isPrimitiveType(obj) {
  return (typeof obj === 'boolean' ||
    typeof obj === 'number' ||
    typeof obj === 'string' ||
    obj === null ||
    obj instanceof Date ||
    Array.isArray(obj));
}


/**
 * Utility functions for comparing things
 */
function compareNSB(a, b) {
  if (a < b) { return -1; }
  if (a > b) { return 1; }
  return 0;
}

function compareArrays(a, b) {
  let comp;

  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    comp = compareThings(a[i], b[i]);

    if (comp !== 0) { return comp; }
  }

  return compareNSB(a.length, b.length);
}


/**
 * Compare { things U undefined }
 */
function compareThings(a, b, _compareStrings) {
  let aKeys, bKeys, comp;
  const compareStrings = _compareStrings || compareNSB;

  // undefined
  if (a === undefined) { return b === undefined ? 0 : -1; }
  if (b === undefined) { return a === undefined ? 0 : 1; }

  // null
  if (a === null) { return b === null ? 0 : -1; }
  if (b === null) { return a === null ? 0 : 1; }

  // Numbers
  if (typeof a === 'number') { return typeof b === 'number' ? compareNSB(a, b) : -1; }
  if (typeof b === 'number') { return typeof a === 'number' ? compareNSB(a, b) : 1; }

  // Strings
  if (typeof a === 'string') { return typeof b === 'string' ? compareStrings(a, b) : -1; }
  if (typeof b === 'string') { return typeof a === 'string' ? compareStrings(a, b) : 1; }

  // Booleans
  if (typeof a === 'boolean') { return typeof b === 'boolean' ? compareNSB(a, b) : -1; }
  if (typeof b === 'boolean') { return typeof a === 'boolean' ? compareNSB(a, b) : 1; }

  // Dates
  if (a instanceof Date) { return b instanceof Date ? compareNSB(a.getTime(), b.getTime()) : -1; }
  if (b instanceof Date) { return a instanceof Date ? compareNSB(a.getTime(), b.getTime()) : 1; }

  // Arrays
  if (Array.isArray(a)) { return Array.isArray(b) ? compareArrays(a, b) : -1; }
  if (Array.isArray(b)) { return Array.isArray(a) ? compareArrays(a, b) : 1; }

  // Objects
  aKeys = Object.keys(a).sort();
  bKeys = Object.keys(b).sort();

  for (let i = 0; i < Math.min(aKeys.length, bKeys.length); i += 1) {
    comp = compareThings(a[aKeys[i]], b[bKeys[i]]);

    if (comp !== 0) { return comp; }
  }

  return compareNSB(aKeys.length, bKeys.length);
}


// ==============================================================
// Updating documents
// ==============================================================

/**
 * Set a field to a new value
 */
lastStepModifierFunctions.$set = function (obj, field, value) {
  obj[field] = value;
};


/**
 * Unset a field
 */
lastStepModifierFunctions.$unset = function (obj, field, value) {
  delete obj[field];
};


/**
 * Push an element to the end of an array field
 */
lastStepModifierFunctions.$push = function (obj, field, value) {
  if (!obj.hasOwnProperty(field)) { obj[field] = []; }

  if (!Array.isArray(obj[field])) { throw new Error("Can't $push an element on non-array values"); }

  if (value !== null && typeof value === 'object' && value.$slice && value.$each === undefined) {
    value.$each = [];
  }

  if (value !== null && typeof value === 'object' && value.$each) {
    if (Object.keys(value).length >= 3 || (Object.keys(value).length === 2 && value.$slice === undefined)) {
      throw new Error("Can only use $slice in cunjunction with $each when $push to array");
    }
    if (!Array.isArray(value.$each)) { throw new Error("$each requires an array value"); }

    value.$each.forEach(function (v) {
      obj[field].push(v);
    });

    if (value.$slice === undefined || typeof value.$slice !== 'number') { return; }

    if (value.$slice === 0) {
      obj[field] = [];
    } else {
      let start, end;
      const n = obj[field].length;
      if (value.$slice < 0) {
        start = Math.max(0, n + value.$slice);
        end = n;
      } else {
        start = 0;
        end = Math.min(n, value.$slice);
      }
      obj[field] = obj[field].slice(start, end);
    }
  } else {
    obj[field].push(value);
  }
};


/**
 * Add an element to an array field only if it is not already in it
 */
lastStepModifierFunctions.$addToSet = function (obj, field, value) {
  if (!obj.hasOwnProperty(field)) { obj[field] = []; }

  if (!Array.isArray(obj[field])) { throw new Error("Can't $addToSet an element on non-array values"); }

  if (value !== null && typeof value === 'object' && value.$each) {
    if (Object.keys(value).length > 1) { throw new Error("Can't use another field in conjunction with $each"); }
    if (!Array.isArray(value.$each)) { throw new Error("$each requires an array value"); }

    value.$each.forEach(function (v) {
      lastStepModifierFunctions.$addToSet(obj, field, v);
    });
  } else {
    let addToSet = true;
    obj[field].forEach(function (v) {
      if (compareThings(v, value) === 0) { addToSet = false; }
    });
    if (addToSet) { obj[field].push(value); }
  }
};


/**
 * Remove the first or last element of an array
 */
lastStepModifierFunctions.$pop = function (obj, field, value) {
  if (!Array.isArray(obj[field])) { throw new Error("Can't $pop an element from non-array values"); }
  if (typeof value !== 'number') { throw new Error(value + " isn't an integer, can't use it with $pop"); }
  if (value === 0) { return; }

  if (value > 0) {
    obj[field] = obj[field].slice(0, obj[field].length - 1);
  } else {
    obj[field] = obj[field].slice(1);
  }
};


/**
 * Removes all instances of a value from an existing array
 */
lastStepModifierFunctions.$pull = function (obj, field, value) {
  if (!Array.isArray(obj[field])) { throw new Error("Can't $pull an element from non-array values"); }

  const arr = obj[field];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (match(arr[i], value)) {
      arr.splice(i, 1);
    }
  }
};


/**
 * Increment a numeric field's value
 */
lastStepModifierFunctions.$inc = function (obj, field, value) {
  if (typeof value !== 'number') { throw new Error(value + " must be a number"); }

  if (typeof obj[field] !== 'number') {
    if (!obj.hasOwnProperty(field)) {
      obj[field] = value;
    } else {
      throw new Error("Don't use the $inc modifier on non-number fields");
    }
  } else {
    obj[field] += value;
  }
};


/**
 * Updates the value of the field, only if specified field is greater
 */
lastStepModifierFunctions.$max = function (obj, field, value) {
  if (typeof obj[field] === 'undefined') {
    obj[field] = value;
  } else if (value > obj[field]) {
    obj[field] = value;
  }
};


/**
 * Updates the value of the field, only if specified field is smaller
 */
lastStepModifierFunctions.$min = function (obj, field, value) {
  if (typeof obj[field] === 'undefined') {
    obj[field] = value;
  } else if (value < obj[field]) {
    obj[field] = value;
  }
};


// Given its name, create the complete modifier function
function createModifierFunction(modifier) {
  return function (obj, field, value) {
    const fieldParts = typeof field === 'string' ? field.split('.') : field;

    if (fieldParts.length === 1) {
      lastStepModifierFunctions[modifier](obj, field, value);
    } else {
      if (obj[fieldParts[0]] === undefined) {
        if (modifier === '$unset') { return; }
        obj[fieldParts[0]] = {};
      }
      modifierFunctions[modifier](obj[fieldParts[0]], fieldParts.slice(1), value);
    }
  };
}

// Actually create all modifier functions
Object.keys(lastStepModifierFunctions).forEach(function (modifier) {
  modifierFunctions[modifier] = createModifierFunction(modifier);
});


/**
 * Modify a DB object according to an update query
 */
function modify(obj, updateQuery) {
  const keys = Object.keys(updateQuery);
  const firstChars = keys.map(function (item) { return item[0]; });
  const dollarFirstChars = firstChars.filter(function (c) { return c === '$'; });
  let newDoc, modifiers;

  if (keys.indexOf('_id') !== -1 && updateQuery._id !== obj._id) {
    throw new Error("You cannot change a document's _id");
  }

  if (dollarFirstChars.length !== 0 && dollarFirstChars.length !== firstChars.length) {
    throw new Error("You cannot mix modifiers and normal fields");
  }

  if (dollarFirstChars.length === 0) {
    // Simply replace the object with the update query contents
    newDoc = deepCopy(updateQuery);
    newDoc._id = obj._id;
  } else {
    // Apply modifiers
    modifiers = uniqStr(keys);
    newDoc = deepCopy(obj);
    modifiers.forEach(function (m) {
      if (!modifierFunctions[m]) { throw new Error("Unknown modifier " + m); }

      if (typeof updateQuery[m] !== 'object') {
        throw new Error("Modifier " + m + "'s argument must be an object");
      }

      const mKeys = Object.keys(updateQuery[m]);
      mKeys.forEach(function (k) {
        modifierFunctions[m](newDoc, k, updateQuery[m][k]);
      });
    });
  }

  // Check result is valid and return it
  checkObject(newDoc);

  if (obj._id !== newDoc._id) { throw new Error("You can't change a document's _id"); }
  return newDoc;
}


// ==============================================================
// Finding documents
// ==============================================================

/**
 * Get a value from object with dot notation
 */
function getDotValue(obj, field) {
  const fieldParts = typeof field === 'string' ? field.split('.') : field;
  let objs;

  if (!obj) { return undefined; }

  if (fieldParts.length === 0) { return obj; }

  if (fieldParts.length === 1) { return obj[fieldParts[0]]; }

  if (Array.isArray(obj[fieldParts[0]])) {
    const i = parseInt(fieldParts[1], 10);
    if (typeof i === 'number' && !isNaN(i)) {
      return getDotValue(obj[fieldParts[0]][i], fieldParts.slice(2));
    }

    objs = new Array();
    for (let j = 0; j < obj[fieldParts[0]].length; j += 1) {
      objs.push(getDotValue(obj[fieldParts[0]][j], fieldParts.slice(1)));
    }
    return objs;
  } else {
    return getDotValue(obj[fieldParts[0]], fieldParts.slice(1));
  }
}


/**
 * Check whether 'things' are equal
 */
function areThingsEqual(a, b) {
  let aKeys, bKeys;

  // Strings, booleans, numbers, null
  if (a === null || typeof a === 'string' || typeof a === 'boolean' || typeof a === 'number' ||
    b === null || typeof b === 'string' || typeof b === 'boolean' || typeof b === 'number') {
    return a === b;
  }

  // Dates
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  // Arrays
  if ((!(Array.isArray(a) && Array.isArray(b)) && (Array.isArray(a) || Array.isArray(b))) ||
    a === undefined || b === undefined) {
    return false;
  }

  // General objects
  try {
    aKeys = Object.keys(a);
    bKeys = Object.keys(b);
  } catch (e) {
    return false;
  }

  if (aKeys.length !== bKeys.length) { return false; }
  for (let i = 0; i < aKeys.length; i += 1) {
    if (bKeys.indexOf(aKeys[i]) === -1) { return false; }
    if (!areThingsEqual(a[aKeys[i]], b[aKeys[i]])) { return false; }
  }
  return true;
}


/**
 * Check that two values are comparable
 */
function areComparable(a, b) {
  if (typeof a !== 'string' && typeof a !== 'number' && !(a instanceof Date) &&
    typeof b !== 'string' && typeof b !== 'number' && !(b instanceof Date)) {
    return false;
  }

  if (typeof a !== typeof b) { return false; }

  return true;
}


/**
 * Arithmetic and comparison operators
 */
comparisonFunctions.$lt = function (a, b) {
  return areComparable(a, b) && a < b;
};

comparisonFunctions.$lte = function (a, b) {
  return areComparable(a, b) && a <= b;
};

comparisonFunctions.$gt = function (a, b) {
  return areComparable(a, b) && a > b;
};

comparisonFunctions.$gte = function (a, b) {
  return areComparable(a, b) && a >= b;
};

comparisonFunctions.$ne = function (a, b) {
  if (a === undefined) { return true; }
  return !areThingsEqual(a, b);
};

comparisonFunctions.$in = function (a, b) {
  if (!Array.isArray(b)) { throw new Error("$in operator called with a non-array"); }

  for (let i = 0; i < b.length; i += 1) {
    if (areThingsEqual(a, b[i])) { return true; }
  }

  return false;
};

comparisonFunctions.$nin = function (a, b) {
  if (!Array.isArray(b)) { throw new Error("$nin operator called with a non-array"); }

  return !comparisonFunctions.$in(a, b);
};

comparisonFunctions.$regex = function (a, b) {
  if (!(b instanceof RegExp)) { throw new Error("$regex operator called with non regular expression"); }

  if (typeof a !== 'string') {
    return false;
  } else {
    return b.test(a);
  }
};

comparisonFunctions.$exists = function (value, exists) {
  if (exists || exists === '') {
    exists = true;
  } else {
    exists = false;
  }

  if (value === undefined) {
    return !exists;
  } else {
    return exists;
  }
};

comparisonFunctions.$size = function (obj, value) {
  if (!Array.isArray(obj)) { return false; }
  if (value % 1 !== 0) { throw new Error("$size operator called without an integer"); }

  return (obj.length == value);
};

comparisonFunctions.$elemMatch = function (obj, value) {
  if (!Array.isArray(obj)) { return false; }
  let i = obj.length;
  while (i--) {
    if (match(obj[i], value)) {
      return true;
    }
  }
  return false;
};
arrayComparisonFunctions.$size = true;
arrayComparisonFunctions.$elemMatch = true;


/**
 * Match any of the subqueries
 */
logicalOperators.$or = function (obj, query) {
  if (!Array.isArray(query)) { throw new Error("$or operator used without an array"); }

  for (let i = 0; i < query.length; i += 1) {
    if (match(obj, query[i])) { return true; }
  }

  return false;
};


/**
 * Match all of the subqueries
 */
logicalOperators.$and = function (obj, query) {
  if (!Array.isArray(query)) { throw new Error("$and operator used without an array"); }

  for (let i = 0; i < query.length; i += 1) {
    if (!match(obj, query[i])) { return false; }
  }

  return true;
};


/**
 * Inverted match of the query
 */
logicalOperators.$not = function (obj, query) {
  return !match(obj, query);
};


/**
 * Use a function to match
 */
logicalOperators.$where = function (obj, fn) {
  if (typeof fn !== 'function') { throw new Error("$where operator used without a function"); }

  const result = fn.call(obj);
  if (typeof result !== 'boolean') { throw new Error("$where function must return boolean"); }

  return result;
};


/**
 * Tell if a given document matches a query
 */
function match(obj, query) {
  const queryKeys = Object.keys(query);

  // Primitive query against a primitive type
  if (isPrimitiveType(obj) || isPrimitiveType(query)) {
    return matchQueryPart({ needAKey: obj }, 'needAKey', query);
  }

  for (let i = 0; i < queryKeys.length; i += 1) {
    const queryKey = queryKeys[i];
    const queryValue = query[queryKey];

    if (queryKey[0] === '$') {
      if (!logicalOperators[queryKey]) { throw new Error("Unknown logical operator " + queryKey); }
      if (!logicalOperators[queryKey](obj, queryValue)) { return false; }
    } else {
      if (!matchQueryPart(obj, queryKey, queryValue)) { return false; }
    }
  }

  return true;
}


/**
 * Match an object against a specific { key: value } part of a query
 */
function matchQueryPart(obj, queryKey, queryValue, treatObjAsValue) {
  const objValue = getDotValue(obj, queryKey);
  let keys, firstChars, dollarFirstChars;

  // Check if the value is an array if we don't force a treatment as value
  if (Array.isArray(objValue) && !treatObjAsValue) {
    // Check for an exact match
    if (Array.isArray(queryValue)) {
      return matchQueryPart(obj, queryKey, queryValue, true);
    }

    // Check for array-specific comparison function
    if (queryValue !== null && typeof queryValue === 'object' && !(queryValue instanceof RegExp)) {
      keys = Object.keys(queryValue);
      for (let i = 0; i < keys.length; i += 1) {
        if (arrayComparisonFunctions[keys[i]]) {
          return matchQueryPart(obj, queryKey, queryValue, true);
        }
      }
    }

    // Treat as an array of { obj, query }
    for (let i = 0; i < objValue.length; i += 1) {
      if (matchQueryPart({ k: objValue[i] }, 'k', queryValue)) { return true; }
    }
    return false;
  }

  // queryValue is an actual object
  if (queryValue !== null && typeof queryValue === 'object' &&
    !(queryValue instanceof RegExp) && !Array.isArray(queryValue)) {
    keys = Object.keys(queryValue);
    firstChars = keys.map(function (item) { return item[0]; });
    dollarFirstChars = firstChars.filter(function (c) { return c === '$'; });

    if (dollarFirstChars.length !== 0 && dollarFirstChars.length !== firstChars.length) {
      throw new Error("You cannot mix operators and normal fields");
    }

    if (dollarFirstChars.length > 0) {
      for (let i = 0; i < keys.length; i += 1) {
        if (!comparisonFunctions[keys[i]]) {
          throw new Error("Unknown comparison function " + keys[i]);
        }

        if (!comparisonFunctions[keys[i]](objValue, queryValue[keys[i]])) { return false; }
      }
      return true;
    }
  }

  // Using regular expressions with basic querying
  if (queryValue instanceof RegExp) {
    return comparisonFunctions.$regex(objValue, queryValue);
  }

  // queryValue is either a native value or a normal object
  if (!areThingsEqual(objValue, queryValue)) { return false; }

  return true;
}


// --- Helper ---
function uniqStr(arr) {
  return arr.filter(function (item, pos) {
    return arr.indexOf(item) === pos;
  });
}


// Interface
module.exports.serialize = serialize;
module.exports.deserialize = deserialize;
module.exports.deepCopy = deepCopy;
module.exports.checkObject = checkObject;
module.exports.isPrimitiveType = isPrimitiveType;
module.exports.modify = modify;
module.exports.getDotValue = getDotValue;
module.exports.match = match;
module.exports.areThingsEqual = areThingsEqual;
module.exports.compareThings = compareThings;