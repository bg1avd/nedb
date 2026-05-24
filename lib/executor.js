/**
 * Responsible for sequentially executing actions on the database
 * Modernized: replaced async.queue with native Promise chain
 */

function Executor() {
  this.buffer = [];
  this.ready = false;
  this.queueRunning = false;
  this.queue = [];
  this._processPromise = null;
}


/**
 * Internal: process the queue sequentially
 */
Executor.prototype._processQueue = function () {
  const self = this;

  if (self.queueRunning) { return; }
  self.queueRunning = true;

  const runNext = () => {
    if (self.queue.length === 0) {
      self.queueRunning = false;
      return;
    }

    const task = self.queue.shift();
    const newArguments = [];

    // task.arguments is an array-like object
    for (let i = 0; i < task.arguments.length; i += 1) {
      newArguments.push(task.arguments[i]);
    }
    const lastArg = task.arguments[task.arguments.length - 1];

    const runTask = new Promise((resolve) => {
      // Wrap to always call resolve (which advances the queue)
      if (typeof lastArg === 'function') {
        // Callback was supplied — intercept it
        newArguments[newArguments.length - 1] = function () {
          lastArg.apply(null, arguments);
          resolve();
        };
      } else if (!lastArg && task.arguments.length !== 0) {
        // false/undefined/null supplied as callback
        newArguments[newArguments.length - 1] = () => resolve();
      } else {
        // No callback supplied
        newArguments.push(() => resolve());
      }
    });

    task.fn.apply(task.this, newArguments);

    // If the task.fn is synchronous and doesn't use a callback, resolve immediately
    // We use Promise.resolve to ensure async behavior
    runTask.then(runNext);
  };

  runNext();
};


/**
 * If executor is ready, queue task (and process it immediately if executor was idle)
 * If not, buffer task for later processing
 * @param {Object} task
 *                 task.this - Object to use as this
 *                 task.fn - Function to execute
 *                 task.arguments - Array of arguments
 * @param {Boolean} forceQueuing Optional (defaults to false) force executor to queue task even if it is not ready
 */
Executor.prototype.push = function (task, forceQueuing) {
  if (this.ready || forceQueuing) {
    this.queue.push(task);
    this._processQueue();
  } else {
    this.buffer.push(task);
  }
};


/**
 * Queue all tasks in buffer (in the same order they came in)
 * Automatically sets executor as ready
 */
Executor.prototype.processBuffer = function () {
  this.ready = true;
  for (let i = 0; i < this.buffer.length; i += 1) {
    this.queue.push(this.buffer[i]);
  }
  this.buffer = [];
  this._processQueue();
};


// Interface
module.exports = Executor;