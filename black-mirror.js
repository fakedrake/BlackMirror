/**
 * @fileOverview The testing method is quite simple:
 *
 * -- |Definition of tha existing components as types
 * BabelFish = [IO ClosureCall] -> [IO ApiMessage]
 * MessagingApi = [IO ApiMessage] -> [IO ClosureCall]
 *
 * -- |Interpretation of the current functionality (as per curry-howard)
 * callback :: ApiMessage -> Closure
 * closure :: ClosureCall -> Closure
 * execute :: BabelFish -> MessagingApi -> IO ()
 *
 * -- |Recording
 * Recorder = BabelFish -> MessagingApi -> IO Checker
 *
 * -- |Testing
 * Checker = BabelFish -> IO TestStatus
 *
 * -- |Serialization uses some sort of context. In most cases it would
 * --  be the ApiMessage list
 * class Serializable a where
 *   serialize :: ctx -> a -> JSON
 *   deserialize :: ctx -> JSON -> a
 *
 * instance Serializable ApiMessage;
 * instance Serializable ClosureCall;
 * instance Serializable Closure
 * instance Serializable Checker;
 *
 * -- |A possible testing status
 * TestStatus = Either StackTrace Success
 *
 * Note: BabelFish ApiMessages are recodings of the messaging runtime
 * object and Closures are the callbacks.
 * @name black-mirror.js
 * @author Chris Perivolaropoulos
 * @license MIT
 */

var assert = require('assert');

function arrToBuf(hex) {
  tc(hex, Array);
  var buffer = new ArrayBuffer(hex.length);
  var bufferView = new Uint8Array(buffer);
  for (var i = 0; i < hex.length; i++) {
    bufferView[i] = hex[i];
  }

  return buffer;
}

function bufToArr(bin) {
  tc(bin, ArrayBuffer);
  var bufferView = new Uint8Array(bin);
  var hexes = [];
  for (var i = 0; i < bufferView.length; ++i) {
    hexes.push(bufferView[i]);
  }
  return hexes;
}


// TypeCheck
function tc(v, c) {
  if (typeof c !== 'function') throw Error(c + " is not a type.");
  if (v instanceof c) return;
  throw Error(v + " not of type " + c.name);
}

// Json type check
function jt(json, type) {
  if (json._type === type) return;
  var s = JSON.stringify(json, null, 2);
  throw Error(json._type + " should be a " + type + ": " + s);
}

// Actually a JS code block
function Closure (fn) {
  if (typeof fn !== 'function')
    throw Error("Closures are function wrappers");

  this.fn = fn;
  this.type = 'closure';
}
Closure.deserialize = function (apimessages, json) {
  jt(json, 'closure');
  tc(apimessages[json.callback_from], ApiMessage);
  return apimessages[json.callback_from].closure();
};

Closure.prototype = {
  assertEqual: function (json, apimessages) {
    jt(json, 'closure');
    assert.equal(typeof json.callback_from, 'number');
    if (json.callback_from < apimessages.length) {
      assert.equal(this.fn, apimessages[json.callback_from].closure().fn);
    }
    // Otherwise it's a new callbacl
  },

  serialize: function (apimessages) {
    for (var i = 0; i < apimessages.length; i++) {
      if (this.fn === (apimessages[i].closure() || {}).fn) {
        return {
          _type: this.type,
          callback_from: i
        };
      }
    }

    // For a Closure to be valid the callback needs to be retrievable
    // from the api messages.
    throw Error('Closure callback not found in API messages');
  },

  callable: function (args) {
    var self = this;
    return function () {
      return self.fn.apply(null, args ? args.raw() : []);
    };
  }
};

var JSWrappedObject = {
  serialize: function (apimessages, value) {
    if (value instanceof ArrayBuffer) {
      return {
        _type: 'wrapped_js_object',
        wrapped_type: 'ArrayBuffer',
        value: bufToArr(value)
      };
    }

    // Serialize arraybuffers in the deeper level
    if (typeof value === 'object' &&
        value.data &&
        value.data instanceof ArrayBuffer) {
      var ret = {};
      Object.getOwnPropertyNames(value).forEach(function (k) {
        ret[k] = JSWrappedObject.serialize(apimessages, value[k]);
      });
      return ret;
    }


    if (value instanceof Closure) {
      return value.serialize(apimessages);
    }

    return value;
  },

  assertEqual: function (lifted, json, apimessages) {
    if (typeof json !== 'object') {
      assert.equal(lifted, json);
      return;
    }

    // Assert equality of deeper arraybuffers
    if (typeof json.data === 'object' &&
        json.data._type === 'wrapped_js_object' &&
        json.data.wrapped_type === 'ArrayBuffer') {
      tc(lifted.data, ArrayBuffer);
      var jsonKeys = Object.getOwnPropertyNames(json),
          liftedKeys = Object.getOwnPropertyNames(lifted);
      assert.deepEqual(jsonKeys, liftedKeys);
      jsonKeys.forEach(function (k) {
        JSWrappedObject.assertEqual(lifted[k], json[k], apimessages);
      });
      return;
    }

    if (lifted instanceof Closure) {
      lifted.assertEqual(json, apimessages);
      return;
    }

    if (json._type !== 'wrapped_js_object') {
      assert.deepEqual(lifted, json);
      return;
    }

    if (json.wrapped_type === 'ArrayBuffer') {
      assert.deepEqual(bufToArr(lifted), json.value);
      return;
    }

    throw Error("Can't compare " + json + " and " + lifted);
  },

  deserialize: function (apimessages, json) {
    if (typeof json !== 'object')
      return json;

    // Closures, ie callbacks.
    if (json._type === 'closure')
      return Closure.deserialize(apimessages, json);

    // Recurive deserialize if there is a deeper ArrayBuffer
    if (typeof json.data === 'object' &&
        json.data._type === 'wrapped_js_object' &&
        json.data.wrapped_type === 'ArrayBuffer') {
      var ret = {};
      Object.getOwnPropertyNames(json).forEach(function (k) {
        ret[k] = JSWrappedObject.deserialize([], json[k]);
      });
      return ret;
    }

    if (json._type !== 'wrapped_js_object')
      return json;

    if (json.wrapped_type === 'ArrayBuffer')
      return arrToBuf(json.value);


    throw Error("Could not deserialize " + json);
  }

};

// Arguments that hold their callback separately. This way we can fill
// it in in the case of an API message being expected.
function Arguments (deserializedArgs) {
  var self = this;
  this.type = 'arguments';
  this.args = deserializedArgs.map(function (a) {
    if (typeof a === 'function') return new Closure(a);
    return a;
  });
}
Arguments.deserialize = function (apimessages, json) {
  assert.equal(json._type, 'arguments');
  return new Arguments(json.args.map(
    JSWrappedObject.deserialize.bind(null, apimessages)));
};
Arguments.prototype = {
  closures: function () {
    return this.args.filter(function (a) {return a instanceof Closure;});
  },

  serialize: function (apimessages) {
    return {
      _type: this.type,
      args: this.args.map(JSWrappedObject.serialize.bind(null, apimessages))}
    ;
  },

  raw: function () {
    return this.args.map(function (a) {
      if (a instanceof Closure) {
        return a.fn;
      }

      return a;
    });
  },

  assertEqual: function (json, apimessages) {
    assert.equal(json._type, this.type);
    assert.equal(json.args.length, this.args.length);
    for (var i = 0; i < json.args.length; i++) {
      JSWrappedObject.assertEqual(this.args[i], json.args[i], apimessages);
    }
  }
};

// #### Front Facing ####
function ClosureCall (closure, args) {
  tc(closure, Closure);
  tc(args, Arguments);

  this.closure = closure;
  this.args = args;
  this.type = 'closure_call';
}
ClosureCall.deserialize = function (apimessages, json) {
  jt(json, 'closure_call');
  return new ClosureCall(
    Closure.deserialize(apimessages, json.closure),
    Arguments.deserialize(apimessages, json.args)
  );
};
ClosureCall.prototype = {
  serialize: function (apimessages) {
    return {
      _type: this.type,
      closure: this.closure.serialize(apimessages),
      args: this.args.serialize(apimessages)
    };
  },

  callable: function () {
    return this.closure.callable(this.args);
  }
};

// XXX: assume the value is serializable
function ReturnValue (value) {
  this.type = 'return_value';
  this.value = value;
}
ReturnValue.deserialize = function (apimessages, json) {
  jt(json, 'return_value');
  return new ReturnValue(json);
};
ReturnValue.prototype = {
  serialize: function (apimessages) {
    return {_type: this.type,
            value: this.value };
  }
};

/**
 * There is no reason to assume either that the recoreder was
 * recording an async API or that the api calls did not return proper
 * values, so we also mark the end of api calls. Besides the value of
 * the return value we only need this to indicate the asynchronous
 * behavior of callbacks for the mocked api.
 * @param {ApiMessage} apimessage
 * @param {ReturnValue} val
 */
function ApiMessageReturn (apimessage, val) {
  tc(val, ReturnValue);
  tc(apimessage, ApiMessage);

  this.type = 'api_message_return';
  this.value = val;
  this.apimessage = apimessage;
}
ApiMessageReturn.deserialize = function (apimessages, json) {
  jt(json, 'api_message_return');
  return new ApiMessageReturn(
    apimessages[json.from_api_message],
    ReturnValue.deserialize(apimessages, json.value)
  );
};
ApiMessageReturn.prototype = {
  serialize: function (apimessages) {
    for (var i = apimessages.length - 1; i >= 0; i--) {
      if (this.apimessage === apimessages[i]) {
        return {
          _type: this.type,
          from_api_message: i,
          value: this.value.serialize(apimessages)
        };
      }
    }

    throw Error("Returning a non-called apimessage");
  }
};

function ApiMessage (name, args) {
  tc(args, Arguments);
  this.name = name;
  this.args = args;
  this.type = 'api_message';
}
ApiMessage.deserialize = function (apimessages, json) {
  assert.equal(json._type, 'api_message');
  return new ApiMessage(
    json.name,
    Arguments.deserialize(json.args));
};
ApiMessage.prototype = {
  closure: function () {
    return this.args.closures()[0] || null;
  },
  serialize: function (apimessages) {
    return {
      _type: this.type,
      args: this.args.serialize(apimessages),
      name: this.name
    };
  },
  assertEqual: function (serialized, apimessages) {
    assert.equal(serialized._type, this.type);
    assert.equal(serialized.name, this.name,
                 "Latest: " + JSON.stringify(apimessages, null, 2));
    this.args.assertEqual(serialized.args, apimessages);
  }
};

function traverseMethodTree (methods, wrap, rawApi) {
  var api = {};
  methods.forEach(function (m) {
    function loop (path, api, cursor) {
      if (path.length == 1) {
        api[path[0]] = wrap(m, cursor[path[0]], cursor);
        return;
      }

      api[path[0]] = api[path[0]] || {};
      cursor = cursor[path[0]] || {};
      loop(path.slice(1), api[path[0]], cursor);
    }
    loop(m.split('.'), api, rawApi || {});
  });

  return api;
}

// Checker can not know when we are done.
function Checker (serialLog, methods, scheduler) {
  var self = this;
  // We should not mutate the serial log
  this.serialLog = serialLog.slice();
  this.runMessageLog = [];
  this.next = null;
  this.type = 'checker';
  this.methods = methods;
  this.api = traverseMethodTree(methods, this.wrapMethod.bind(this));
  this.sanityCheckLog(serialLog);
  this.scheduler = scheduler || {setTimeout: setTimeout};

  // All methods should pop ApiMessages
  // ClosureCalls should be popped when they are on top.
}
Checker.deserialize = function (_, json, scheduler) {
  assert.equal(json._type, 'checker');
  return new Checker(json.log, json.methods, scheduler);
};
Checker.prototype = {
  sanityCheckLog: function (jsonLog) {
    var returns = jsonLog.filter(function (l) {
      return l._type == 'api_message_return';
    }),
        calls = jsonLog.filter(function (l) {
          return l._type == 'api_message_return';
        });

    returns.forEach(function (r) {
      if (!calls[r.from_api_message]) {
        throw Error("Returned from non-called:" + r);
      }

      if (calls[r.from_api_message] == 'returned') {
        throw Error("Second return from same call:" + r);
      }

      calls[r.from_api_message] = 'returned';
    });

    calls.forEach(function (c) {
      if (c !== 'returned') {
        throw Error('Method probably raised an error:' + c);
      }
    });
  },
  serialize: function (_) {
    return {
      _type: this.type,
      log: this.serialLog,
      methods: this.methods
    };
  },

  done: function () {
    assert.deepEqual(this.serialLog, []);
  },

  scheduleWake: function () {
    if (this.next) return;
    var self = this;
    this.next = this.scheduler.setTimeout(function () {
      self.next = null;

      if (self.serialLog.length == 0 || self.serialLog[0]._type != 'closure_call')
        return;

      var cc = ClosureCall.deserialize(self.runMessageLog, self.serialLog.shift());
      cc.callable().call(null);
      self.scheduleWake();
    });
  },

  wrapMethod: function (name) {
    var self = this;
    return function checkedMethod () {
      assert(self.serialLog.length > 0, "Method call not recorded");

      var am = self.serialLog.shift(),
          currentAm = new ApiMessage(
            name,
            new Arguments([].slice.call(arguments))),
          apimessages = self.runMessageLog.filter(function (ml) {
            return ml instanceof ApiMessage;
          });

      // Check it's what the program was supposed to call.
      currentAm.assertEqual(am, apimessages);

      // Record the contextual info of the call to replicate
      // consequent behavior.
      self.runMessageLog.push(currentAm);

      // Emulate the api behavior until the return of the call
      while (self.serialLog[0]._type !== "api_message_return") {
        var sl = self.serialLog.shift(),
            cc = ClosureCall.deserialize(self.runMessageLog, sl);

        cc.callable().call(null);
        assert(self.serialLog.length > 0, "Api method "+name+" did not return");
      }

      var retobj = ApiMessageReturn.deserialize(
        self.runMessageLog, self.serialLog.shift());
      assert(retobj.apimessage === currentAm);
      self.scheduleWake();
      return retobj.value.value;
    };
  }
};

function Recorder (api, methods) {
  var self = this;
  this.log = [];
  this.api = traverseMethodTree(methods, this.wrapMethod.bind(this), api);
  this.methods = methods;
  this.callbacks = [];
}
Recorder.prototype = {
  apiMessages: function () {
    return this.log.filter(function (l) {
      return l instanceof ApiMessage;
    });
  },

  // Create a checker with the list
  checker: function () {
    var am = this.apiMessages();
    return new Checker(this.log.map(function (l)  {
      return l.serialize(am);
    }), this.methods);
  },

  wrapMethod: function (name, ref, parent) {
    var self = this;
    return function wrappedMethod () {
      // Do not record internal calls.
      var args = [].slice.call(arguments),
          am = new ApiMessage(name, new Arguments(args));

      self.log.push(am);
      var ret = ref.apply(parent, self.wrapCallbacks(args));
      self.log.push(new ApiMessageReturn(am, new ReturnValue(ret)));
      return ret;
    };
  },

  wrapCallbacks: function (args) {
    var self = this;
    return args.map(function (a) {
      if (typeof a === 'function') {
        return self.wrapCallback(a);
      }
      return a;
    });
  },

  wrapCallback: function (fn) {
    var self = this;

    function wrappedCallback () {
      var closure = new Closure(fn);
      self.log.push(new ClosureCall(closure,
                                    new Arguments([].slice.call(arguments))));
      return fn.apply(null, arguments);
    }

    for (var i = 0; i < this.callbacks.length; i++) {
      if (this.callbacks[i].fn === fn)
        return this.callbacks[i].wrappedCallback;
    }

    this.callbacks.push({fn: fn, wrappedCallback: wrappedCallback});
    return wrappedCallback;
  }
};

module.exports.Closure = Closure;
module.exports.Arguments = Arguments;
module.exports.ClosureCall = ClosureCall;
module.exports.ApiMessage = ApiMessage;
module.exports.Checker = Checker;
module.exports.Recorder = Recorder;
module.exports.JSWrappedObject = JSWrappedObject;
