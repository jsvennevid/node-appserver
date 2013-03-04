var _ = require('underscore'),
    db = require('./db');

var methods = {
    'create': function (url, method, data, session, callback) { return db.create(url, data, session, callback); },
    'read': function (url, method, data, session, callback) { return db.read(url, data, session, callback); },
    'update': function (url, method, data, session, callback) { return db.update(url, data, session, callback); },
    'delete': function (url, method, data, session, callback) { return db.destroy(url, data, session, callback); },
    'emit': function (url, method, data, session, callback) { return db.emit(url, method, data, session, callback); }
}

exports.sync = function sync(socket, message, callback) {
    var method = methods[message.method];
    if (!_.isUndefined(method)) {
        method(message.url, message.emit, message.data, socket.handshake.session, function (err, response, session) {
            if (!_.isUndefined(session)) {
                socket.handshake.session = session;
            }
            callback(err, response);
        });
    } else {
        callback('Unknown database method "' + message.method + '"');
    }
};
