/**
 * Responsible for sequentially executing actions on the database
 * Modernized: ES6 class, replaced async.queue with native Promise chain
 */

class Executor {
  constructor() {
    this.buffer = [];
    this.ready = false;
    this.queueRunning = false;
    this.queue = [];
  }

  /**
   * Internal: process the queue sequentially
   */
  _processQueue() {
    if (this.queueRunning) { return; }
    this.queueRunning = true;

    const runNext = () => {
      if (this.queue.length === 0) {
        this.queueRunning = false;
        return;
      }

      const task = this.queue.shift();
      const newArguments = [...task.arguments];
      const lastArg = task.arguments[task.arguments.length - 1];

      const runTask = new Promise((resolve) => {
        if (typeof lastArg === 'function') {
          // Callback was supplied — intercept it
          newArguments[newArguments.length - 1] = function (...args) {
            lastArg.apply(null, args);
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
      runTask.then(runNext);
    };

    runNext();
  }

  /**
   * If executor is ready, queue task (and process it immediately if executor was idle)
   * If not, buffer task for later processing
   * @param {Object} task
   * task.this - Object to use as this
   * task.fn - Function to execute
   * task.arguments - Array of arguments
   * @param {Boolean} forceQueuing Optional (defaults to false) force executor to queue task even if it is not ready
   */
  push(task, forceQueuing) {
    if (this.ready || forceQueuing) {
      this.queue.push(task);
      this._processQueue();
    } else {
      this.buffer.push(task);
    }
  }

  /**
   * Queue all tasks in buffer (in the same order they came in)
   * Automatically sets executor as ready
   */
  processBuffer() {
    this.ready = true;
    this.queue.push(...this.buffer);
    this.buffer = [];
    this._processQueue();
  }
}


// Interface
module.exports = Executor;
