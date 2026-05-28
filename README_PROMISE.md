# NeDB Promise

> **A modernized fork of [NeDB](https://github.com/louischatriot/nedb) with Promise/async-await support**

[![npm version](https://img.shields.io/npm/v/nedb-promise.svg)](https://www.npmjs.com/package/nedb-promise)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 📦 About

**NeDB Promise** is a modernized version of the popular embedded JavaScript database [NeDB](https://github.com/louischatriot/nedb). It maintains 100% backward compatibility with the original NeDB while adding native Promise support and removing outdated dependencies.

### 🔥 Key Features

- ✅ **Native Promise Support** - All APIs now support Promise/async-await
- ✅ **Zero Dependencies** - Removed `underscore` and `async` dependencies
- ✅ **ES6+ Modernized** - Using native JavaScript methods
- ✅ **100% Backward Compatible** - Your existing code still works
- ✅ **Embedded & Persistent** - Same great features as NeDB
- ✅ **MongoDB-like API** - Familiar and easy to use

### ⚠️ Important Notice

> This is a **fork** of the original [NeDB](https://github.com/louischatriot/nedb) project by Louis Chatriot. The original project is no longer maintained. This fork modernizes the codebase while preserving all original functionality.

**Original Project**: https://github.com/louischatriot/nedb  
**License**: MIT (same as original)

---

## 🚀 Quick Start

### Installation

```bash
npm install nedb-promise --save
# or
yarn add nedb-promise
```

### Usage with async/await (Recommended)

```javascript
const Datastore = require('nedb-promise');
const db = new Datastore({ filename: 'data.db' });

async function main() {
  // Insert
  const doc = await db.insert({ name: 'Alice', age: 30 });
  console.log('Inserted:', doc);
  
  // Find
  const results = await db.find({ age: { $gte: 18 } });
  console.log('Adults:', results);
  
  // Find One
  const person = await db.findOne({ name: 'Alice' });
  console.log('Found:', person);
  
  // Update
  const updated = await db.update({ name: 'Alice' }, { $set: { age: 31 } });
  console.log('Updated:', updated);
  
  // Remove
  const removed = await db.remove({ name: 'Alice' });
  console.log('Removed:', removed);
  
  // Count
  const count = await db.count({});
  console.log('Total:', count);
}

main().catch(console.error);
```

### Usage with Callbacks (Backward Compatible)

```javascript
const Datastore = require('nedb-promise');
const db = new Datastore({ filename: 'data.db' });

db.insert({ name: 'Bob', age: 25 }, function (err, doc) {
  if (err) return console.error(err);
  console.log('Inserted:', doc);
});

db.find({ age: { $gte: 18 } }, function (err, docs) {
  if (err) return console.error(err);
  console.log('Adults:', docs);
});
```

---

## 📖 API

All original NeDB APIs are supported. Here are the main operations:

### Creating a Database

```javascript
// In-memory only
const db = new Datastore();

// Persistent with filename
const db = new Datastore({ filename: 'data.db' });

// With options
const db = new Datastore({
  filename: 'data.db',
  autoload: true,           // Auto-load on creation
  timestampData: true       // Auto-add createdAt and updatedAt
});
```

### Insert Documents

```javascript
// Single document
const doc = await db.insert({ name: 'Alice', age: 30 });

// Multiple documents
const docs = await db.insert([
  { name: 'Bob', age: 25 },
  { name: 'Charlie', age: 35 }
]);
```

### Find Documents

```javascript
// Find all
const all = await db.find({});

// Find with query
const adults = await db.find({ age: { $gte: 18 } });

// Find one
const first = await db.findOne({ name: 'Alice' });

// With projection
const withNameOnly = await db.find({}, { name: 1, _id: 0 });

// With sorting and limiting
const sorted = await db.find({})
  .sort({ age: -1 })
  .limit(10)
  .skip(5);
```

### Update Documents

```javascript
// Update one
const updated = await db.update(
  { name: 'Alice' },
  { $set: { age: 31 } }
);

// Update multiple
const multi = await db.update(
  { age: { $lt: 18 } },
  { $set: { status: 'minor' } },
  { multi: true }
);

// Upsert
const upserted = await db.update(
  { name: 'Unknown' },
  { $set: { status: 'new' } },
  { upsert: true }
);
```

### Remove Documents

```javascript
// Remove one
const removed1 = await db.remove({ name: 'Alice' });

// Remove multiple
const removedMany = await db.remove({ status: 'inactive' }, { multi: true });
```

### Count Documents

```javascript
const count = await db.count({ age: { $gte: 18 } });
```

### Indexes

```javascript
// Create index
await db.ensureIndex({ fieldName: 'name', unique: true });

// Remove index
await db.removeIndex('name');
```

---

## 🔁 Migration from NeDB

Migration is **100% seamless**. Simply replace the import:

```javascript
// Before
const Datastore = require('nedb');

// After
const Datastore = require('nedb-promise');
```

All your existing callback-based code will continue to work. Additionally, you can now use Promise/async-await syntax!

---

## 🆚 Comparison with Original NeDB

| Feature | NeDB (Original) | NeDB Promise (This Fork) |
|---------|----------------|--------------------------|
| Promise Support | ❌ | ✅ |
| async/await | ❌ | ✅ |
| Dependencies | underscore, async | None |
| ES6+ Syntax | ❌ | ✅ |
| Backward Compatible | - | ✅ 100% |
| Browser Support | ✅ | ✅ |
| TypeScript Types | ❌ | Coming soon |

---

## 🛠️ Development

### Running Tests

```bash
npm install
npm test
```

### Modernization Progress

- [x] **P0**: Remove underscore/async, add Promise support
- [ ] **P1**: TypeScript definitions
- [ ] **P2**: ES6 class refactoring
- [ ] **P3**: Performance optimizations
- [ ] **P4**: Stream API

See `MODERNIZATION_P0.md` for detailed changes.

---

## 📝 Changelog

### Version 1.8.1 (Modernized)

- ✨ Added native Promise support to all APIs
- 🗑️ Removed `underscore` dependency
- 🗑️ Removed `async` dependency  
- 🔧 Modernized executor with Promise chain
- 📦 Updated all internal code to ES6+
- ✅ 100% backward compatible with NeDB 1.8.0

---

## 🙏 Acknowledgments

This project is a fork of the excellent [NeDB](https://github.com/louischatriot/nedb) database by Louis Chatriot. All credit for the original design and implementation goes to the original author.

**Original Repository**: https://github.com/louischatriot/nedb  
**Original License**: MIT

---

## 📄 License

MIT License - same as the original NeDB project.

Copyright (c) 2026 Rao Lin (fork author)  
Based on NeDB by Louis Chatriot
