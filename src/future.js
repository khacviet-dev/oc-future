const f = require('fluture');

function _isNil(val) {
  return val === undefined || val === null;
}

function _dummyFunc() {}

function _get(future) {
  return future._f;
}

function _applyContext(payload) {
  payload.context = _mergeContext(this.context, payload.context);
  return payload;
}

function _isContextEmpty(context) {
  return _isNil(context) || !Object.keys(context).length;
}

function _catchAndGet(future) {
  return future.catch(Future.resolve)._f;
}

function _value(object) {
  return object.value;
}

function _context(object) {
  return object.context;
}

function _initContext() {
  return undefined;
}

function _mergeContext(c1, c2) {
  if (c2 === undefined || !c2.tags || !c2.tags.length) {
    return c1;
  }
  if (c1 === undefined || !c1.tags || !c1.tags.length) {
    return c2;
  }
  const newContext = {};
  const newTags = c1.tags.concat(c2.tags);
  if (newTags.length) {
    newContext.tags = newTags;
  }
  return newContext;
}

function _mergeContextArray(contexts) {
  return contexts.reduce(_mergeContext, _initContext());
}


function _wrap(func, isCaught) {
  return result => {
    let output;
    try {
      output = func(isCaught ? result.error : result.value);
    } catch (ex) {
      output = Future.reject(ex);
    }
    const outputFuture = output instanceof Future ? output : Future.resolve(output);
    /*
     * we should avoid chaining as much as possible, especially at the tail end,
     * because the chained anonymous functions will take up space and will not be freed
     * until the chained clause before it is finished.
     */
    if (_isContextEmpty(result.context)) {
      return outputFuture._f;
    }
    // bind seems faster than creating a new anonymous function
    const _mergeContextToPayload = _applyContext.bind(result);
    return outputFuture._f
      .pipe(f.map(_mergeContextToPayload))
      .pipe(f.mapRej(_mergeContextToPayload));
  };
}

class Future {
  constructor(input) {
    if (f.isFuture(input)) {
      this._f = input;
      return;
    }

    if (typeof input !== 'function') {
      throw new TypeError('constructor expects a function as parameter');
    }

    this._f = f((reject, resolve) => {
      try {
        input(resolve, reject);
      } catch (e) {
        reject(e);
      }
      return _dummyFunc;
    })
      .pipe(f.map(value => ({ value })))
      .pipe(f.mapRej(error => ({ error })));
  }

  then(func) {
    if (typeof func !== 'function') {
      throw new TypeError('then() expects a function as parameter');
    }
    return new Future(this._f.pipe(f.chain(_wrap(func))));
  }

  catch(func) {
    if (typeof func !== 'function') {
      throw new TypeError('catch() expects a function as parameter');
    }
    return new Future(this._f.pipe(f.chainRej(_wrap(func, true))));
  }

  tag(name, data) {
    const context = { tags: [{ name, data }] };
    return new Future(this._f.pipe(f.map(
      payload => ({
        value: payload.value,
        context: _mergeContext(payload.context, context),
      }),
    )));
  }

  fork(resolve, reject) {
    resolve = resolve || _dummyFunc;
    reject = reject || _dummyFunc;
    return f.fork(reject)(resolve)(this._f);
  }

  toPromise() {
    return new Promise((resolve, reject) => {
      f.fork(reject)(resolve)(this._f);
    });
  }

  static tag(name, data) {
    return Future.resolve().tag(name, data);
  }

  static resolve(value) {
    return new Future(f.resolve({ value }));
  }

  static reject(error) {
    return new Future(f.reject({ error }));
  }

  static after(miliseconds, value) {
    return new Future(f.after(miliseconds)({ value }));
  }

  static rejectAfter(miliseconds, error) {
    return new Future(f.rejectAfter(miliseconds)({ error }));
  }

  static encaseF(func) {
    if (typeof func !== 'function') {
      throw new TypeError('encaseF() expects a function as parameter');
    }
    return (...args) => {
      try {
        return Future.resolve(func(...args));
      } catch (e) {
        return Future.reject(e);
      }
    };
  }

  static encaseP(func) {
    if (typeof func !== 'function') {
      throw new TypeError('encaseP() expects a function as parameter');
    }
    return (...args) => new Future((resolve, reject) => {
      try {
        func(...args)
          .then(resolve)
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  static encaseC(func) {
    if (typeof func !== 'function') {
      throw new TypeError('encaseC() expects a function as parameter');
    }
    return (...args) => new Future((resolve, reject) => {
      try {
        func(...args, (error, result) => {
          if (!_isNil(error)) {
            return reject(error);
          }
          return resolve(result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  static all(futures, options = {}) {
    if (!Array.isArray(futures)) {
      throw new TypeError('all() expects an array as parameter');
    }
    if (!_isNil(options.limit) && options.limit !== Infinity
      && (!Number.isInteger(options.limit) || options.limit < 1)) {
      throw new TypeError('options.limit is not a positive integer');
    }
    if (!_isNil(options.ignoreError) && typeof options.ignoreError !== 'boolean') {
      throw new TypeError('options.ignoreError is not a boolean');
    }
    if (!_isNil(options.saveAllContexts) && typeof options.saveAllContexts !== 'boolean') {
      throw new TypeError('options.saveAllContexts is not a boolean');
    }
    const limit = options.limit || Infinity;
    const futureMap = options.ignoreError ? _catchAndGet : _get;
    const inputMap = input => input instanceof Future
      ? futureMap(input) : Future.resolve(input)._f;
    const allFuture = f
      .parallel(limit)(futures.map(inputMap))
      .pipe(f.map(results => ({
        value: results.map(_value),
        context: options.saveAllContexts
          ? _mergeContextArray(results.map(_context))
          : results.length ? results[0].context : _initContext(),
      })));

    return new Future(allFuture);
  }

  // TODO: write test
  static then(newFutureFunc) {
    return future => future.then(newFutureFunc);
  }
}

module.exports = Future;
