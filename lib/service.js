var _ = require('underscore'),
    db = require('./db'),
    assert = require('assert'),
    _ = require('underscore');

var methods = {
    'create': function (url, method, data, session, callback, info) { return db.create(url, data, session, callback, info); },
    'read': function (url, method, data, session, callback, info) { return db.read(url, data, session, callback, info); },
    'update': function (url, method, data, session, callback, info) { return db.update(url, data, session, callback, info); },
    'delete': function (url, method, data, session, callback, info) { return db.destroy(url, data, session, callback, info); },
    'emit': function (url, method, data, session, callback, info) { return db.emit(url, method, data, session, callback, info); }
}

exports.sync = function sync(socket, message, callback) {
    var info = {
        address: socket.handshake.address.address
    };

    try {
        assert(_.isObject(message), "message is not an object");
        assert(_.isString(message.method), "method is missing");
        assert(_.isString(message.url), "url is missing");
        assert(_.isFunction(callback), "callback is missing");

        switch (message.method) {
            case 'create':
            case 'update': {
                assert(_.isObject(message.data), "data is missing");
            } break;

            case 'read':case 'delete': break;

            case 'emit': {
                assert(_.isString(message.emit), "emit emthod is missing");
                assert(_.isObject(message.data), "data is missing");
            } break;

            default: throw new Error("unknown method '" + message.method + '"');
        }
    } catch (e) {
        callback("Invalid request - " + e.message);
        return;
    }

    var method = methods[message.method];
    if (!_.isUndefined(method)) {
        method(message.url, message.emit, message.data, socket.request.session, function (err, response, session) {
            if (!_.isUndefined(session)) {
                socket.request.session = session;
            }
            callback(err, response);
        }, info);
    } else {
        callback('Unknown database method "' + message.method + '"');
    }
};
