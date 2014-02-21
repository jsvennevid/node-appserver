"use strict";

var express = require('express'),
    socket = require('socket.io'),
    cookies = require('cookies'),
    cookie = require('cookie'),
    connect = require('connect'),
    RedisStore = require('connect-redis')(express),
    MemoryStore = express.session.MemoryStore,
    _ = require('underscore'),
    Session = require('connect').middleware.session.Session,
    os = require('os'),
    config = require('config').appserver,
    streaming = require ("streaming.io"),
    service = require("./service"),
    sys = require("sys"),
    spawn = require("child_process").spawn,
    db = require('./db'),
    Application = require('./application');

function Server() {
}

_.extend(Server.prototype, {
    listen: function (events, callback) {
        var app = this.getApp();
        var io = this.getIo();

        streaming.listen(io, app, service, {
            config: config.streaming,
            read: function (url, data, session, callback) {
                db.read(url, data, session, callback);
            },
            invalidate: function (url, callback) {
                db.invalidatecache(url, callback);
            }
        });

        db.configure();

        var port = config.web.port;
        app.listen(port);

        if (callback) {
            callback.call(this, null);
        }

        console.log("Server listening on port " + port);
    },

    initialize: function (callback) {
        var app = express.createServer();
        this.__application = app;

        var io = socket.listen(app);
        this.__io = io;

        io.set('log level', 2);

        var sessionStore;
        switch (config.session.type) {
            case 'memory': {
                sessionStore = new MemoryStore();
            } break;
            case 'redis': {
                sessionStore = new RedisStore(_.clone(config.session.redis));
            } break;
        }
        this.__sessionStore = sessionStore;

        this.createLogger();
        this.createMiddleware();
        this.createSessionHandler();

        io.on('connection', function (socket) {
            if (config.web.allowProxy && socket.handshake.headers['x-forwarded-for']) {
                socket.handshake.address.address = socket.handshake.headers['x-forwarded-for'];
            }
        });

        io.set('authorization', _.bind(function (data, callback) {
            var sid = this.getSessionIdentifier(data);
            if (sid) {
                data.sessionID = sid;
                data.sessionStore = sessionStore;

                sessionStore.get(sid, function (err, session) {
                    if (err || !session) {
                        callback(err, false);
                    } else {
                        data.session = new Session(data, session);
                        callback(null, true);
                    }
                });
            } else {
                callback(null, false);
            }
        }, this));

        if (callback) {
            callback.call(this, null, express, app);
        }
    },

    createLogger: function () {
        var app = this.getApp();
        var express = this.getExpress();

	var logger = express.logger(config.logformat);
        app.use(logger);
    },

    createMiddleware: function () {
        var app = this.getApp();
        var express = this.getExpress();

        app.use(express.cookieParser());
        app.use(connect.urlencoded());
        app.use(connect.json());
    },

    createSessionHandler: function () {
        var app = this.getApp();
        var express = this.getExpress();
        var sessionStore = this.getSessionStore();

        app.use('/token', express.session({
            secret: config.session.secret,
            store: sessionStore,
            key: config.session.key,
            cookie: {
                path: '/',
                httpOnly: true,
                secure: config.session.secure,
                maxAge: config.session.timeout
            }
        }));

        app.get('/token', function (req, res) {
            var secure = config.session.secure;
            var secured = secure && (req.connection.encrypted || req.connection.proxySecure);
            if (req.session && (secured || !secure)) {
                res.cookie(config.session.client_key, new Date().getTime(), {
                    path: '/',
                    httpOnly: false,
                    secure: secure,
                    maxAge: config.session.timeout
                });
            }
            res.send({token: true}, {"Content-Type": "text/plain"}, 200);
        });

        app.get('/ping', function (req, res) {
            res.send({"pong": new Date().getTime()}, {"Content-Type": "text/plain"}, 200);
        });
    },

    getSessionIdentifier: function (data) {
        var sid = undefined;
        if (data.headers.cookie) {
            var cookieStore = cookie.parse(data.headers.cookie);
            sid = decodeURIComponent(cookieStore[config.session.key]);
        }
        return sid;
    },

    getApp: function () {
        return this.__application;
    },

    getIo: function () {
        return this.__io;
    },

    getExpress: function () {
        return express;
    },

    getSessionStore: function () {
        return this.__sessionStore;
    }
});

exports.createInstance = function () {
    return new Server();
}

exports.config = config;
exports.db = db;
exports.Application = Application;
