var assert = require('assert'),
    bm = require('../black-mirror.js');

function arrToBuf(hex) {
  var buffer = new ArrayBuffer(hex.length);
  var bufferView = new Uint8Array(buffer);
  for (var i = 0; i < hex.length; i++) {
    bufferView[i] = hex[i];
  }

  return buffer;
}

function bufToArr(bin) {
  var bufferView = new Uint8Array(bin);
  var hexes = [];
  for (var i = 0; i < bufferView.length; ++i) {
    hexes.push(bufferView[i]);
  }
  return hexes;
}

// A dummy application
function process (api) {
  api.hello("chris", function (greet) {
    assert.equal(greet, 'Hello! chris');
    api.bye('chris');
  });
}

// Pass bad arguments
function process_bad_args (api) {
  api.hello("christos", function (greet) {
    assert.equal(greet, 'christos you have been greeted');
    api.bye('hello');
  });
}

// Make some extra calls
function process_extra_calls (api) {
  api.hello("chris", function () {
    api.hello('shouldnt be here');
    api.bye('chris');
  });
}

// Make some extra calls
function process_incomplete (api) {
  api.hello("chris", function () {});
}

// Api agnostic checks.
function recCheck (rec) {

}

describe("black-mirror.test", function () {
  before(function () {});

  it('#recorder', function () {
    var api = {
      hello: function (name, cb) {
        cb("Hello! " + name);
      },
      bye: function (name) {}
    };

    // Record the process
    var rec = new bm.Recorder(api, ['hello', 'bye']);
    process(rec.api);

    // Check the data of the checker
    var log = rec.checker().serialize().log;
    assert.equal(log.length, 5);
    assert.deepEqual(log.map(function (l) {return l._type;}),
                     ['api_message',
                      'closure_call',
                      'api_message',
                      'api_message_return',
                      'api_message_return']);

    // Check that it's serializable
    assert.doesNotThrow(function () {JSON.stringify(rec.checker().serialize());});

    // Check that we can reproduce the same environment
    assert.doesNotThrow(function () {
      var chk = rec.checker();
      // Synchronous
      process(chk.api);
      chk.done();
    });

    // It fails if we get bad args
    assert.throws(function () {
      process_bad_args(rec.checker().api);
    });

    // It fails if we make extra calls
    assert.throws(function () {
      process_extra_calls(rec.checker().api);
    });

    assert.throws(function () {
      var check = rec.checker();
      process_incomplete(check.api);
      check.done();
    });

    // Serialize and deserialize.
    assert.doesNotThrow(function () {
      var str = JSON.stringify(rec.checker().serialize([])),
          obj = JSON.parse(str),
          check = bm.Checker.deserialize(null, obj);
      assert.equal(check.serialize([]).log.length, 5);
      process(check.api);
      check.done();
    });
  });

  it("asyncCheck", function (done) {
    var api = {
      hello: function (name, cb) {
        setTimeout(function () {
          cb("Hello! " + name);
        });
      },

      bye: function (name) {}
    },
        rec = new bm.Recorder(api, ['hello', 'bye']);

    process(rec.api);
    setTimeout(function () {
      // Check the data of the checker
      var log = rec.checker().serialize().log;
      assert.deepEqual(log.map(function (l) {return l._type;}),
                       ['api_message',
                        'api_message_return',
                        'closure_call',
                        'api_message',
                        'api_message_return']);
      done();
    });
  });

  it("arraybuffers", function () {
    var buf1 = arrToBuf([1,2,3]),
        buf2 = arrToBuf([1,3,5]),
        buf = buf1,
        api = {
          send: function (buf, cb) {cb(buf);}
        };

    assert(buf1 instanceof ArrayBuffer);
    assert(buf2 instanceof ArrayBuffer);

    function process (api) {
      api.send(buf, function (b) {
        assert.deepEqual(b, buf);
      });
      api.send([2,4,6], function () {});
    }

    var rec = new bm.Recorder(api, ['send']);
    process(rec.api);
    buf = buf2;
    assert.throws(function () {
      process(rec.checker().api);
    });
    buf = buf1;
    assert.doesNotThrow(function () {
      process(rec.checker().api);
    });
    buf = buf2;
    assert.throws(function () {
      process(rec.checker().api);
    });
  });

  it("Same callback to multiple calls", function () {
    var api = {event: {
      addListener: function (cb) {},
      removeListener: function (cb) {}
    }};

    function process (api) {
      function a () {}
      api.event.addListener(a);
      api.event.removeListener(a);
    }

    // adds one callback, removes another
    function bad_process (api) {
      function a () {}
      function b () {}
      api.addListener(a);
      api.removeListener(b);
    }

    var rec = new bm.Recorder(api, ['event.addListener', 'event.removeListener']);
    process(rec.api);
    assert.throws(function () {
      bad_process(rec.checker().api);
    });
    assert.doesNotThrow(process.bind(null, rec.checker().api));
  });

  it("error throwing api", function () {
    var api = {event: {
      addListener: function (cb) {
        throw Error();
      },
      removeListener: function (cb) {}
    }};

    function process (api) {
      function a () {}
      try {
        api.event.addListener(a);
      } catch (e) {
      }
      api.event.removeListener(a);
    }

    var rec = new bm.Recorder(api, ['event.addListener', 'event.removeListener']);
    process(rec.api);

    // The api should never raise an error or the checker won't know
    // when to return.
    assert.throws(function () {rec.checker();});
  });

  it("chrome", function (done) {
    var checker = bm.Checker.deserialize(null, JSON.parse('{"_type":"checker","log":[{"_type":"api_message","args":{"_type":"arguments","args":[{"_type":"closure","callback_from":0}]},"name":"getDevices"},{"_type":"api_message_return","from_api_message":0,"value":{"_type":"return_value"}},{"_type":"closure_call","closure":{"_type":"closure","callback_from":0},"args":{"_type":"arguments","args":[[{"path":"/dev/cu.AdafruitEZ-Link1ca6-SPP"},{"path":"/dev/cu.Bluetooth-Incoming-Port"},{"path":"/dev/tty.AdafruitEZ-Link1ca6-SPP"},{"path":"/dev/tty.Bluetooth-Incoming-Port"}]]}}],"methods":["getDevices"]}'));

    // Mock the chrome api
    checker.api.getDevices(function (devs) {
      assert.deepEqual(devs.map(function (d) {return d.path;}),
                   ["/dev/cu.AdafruitEZ-Link1ca6-SPP",
                    "/dev/cu.Bluetooth-Incoming-Port",
                    "/dev/tty.AdafruitEZ-Link1ca6-SPP",
                    "/dev/tty.Bluetooth-Incoming-Port"]
                      );
      checker.done();
      done();
    });
  });

  it('blogpost', function () {
    var data = JSON.parse('{"_type":"checker","log":[{"_type":"api_message","args":{"_type":"arguments","args":[{"_type":"closure","callback_from":0}]},"name":"serial.getDevices"},{"_type":"api_message_return","from_api_message":0,"value":{"_type":"return_value"}},{"_type":"closure_call","closure":{"_type":"closure","callback_from":0},"args":{"_type":"arguments","args":[[{"path":"/dev/cu.Bluetooth-Incoming-Port"},{"path":"/dev/cu.usbmodem1411"},{"path":"/dev/tty.Bluetooth-Incoming-Port"},{"path":"/dev/tty.usbmodem1411"},null, null, null]]}},{"_type":"api_message","args":{"_type":"arguments","args":["/dev/cu.usbmodem1411",{"bitrate":9600},{"_type":"closure","callback_from":1}]},"name":"serial.connect"},{"_type":"api_message_return","from_api_message":1,"value":{"_type":"return_value"}},{"_type":"closure_call","closure":{"_type":"closure","callback_from":1},"args":{"_type":"arguments","args":[{"bitrate":9600,"bufferSize":4096,"connectionId":1,"ctsFlowControl":true,"dataBits":"eight","name":"","parityBit":"no","paused":false,"persistent":false,"receiveTimeout":0,"sendTimeout":0,"stopBits":"one"}]}},{"_type":"api_message","args":{"_type":"arguments","args":[1,{"_type":"closure","callback_from":2}]},"name":"serial.disconnect"},{"_type":"api_message_return","from_api_message":2,"value":{"_type":"return_value"}},{"_type":"closure_call","closure":{"_type":"closure","callback_from":2},"args":{"_type":"arguments","args":[true]}}],"methods":["serial.getDevices","serial.connect","serial.disconnect"]}'),
        chk = bm.Checker.deserialize([],data);
  })

});
