var _ = require('underscore'),
    db = require('./db');

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
