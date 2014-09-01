"use strict";

var express = require('express'),
    utils = require('connect').utils,
    util = require('util'),
    http = require('http'),
    socket = require('socket.io'),
    cookies = require('cookies'),
    cookie = require('cookie'),
    EventEmitter = require('events').EventEmitter,
    RedisStore = require('connect-redis')(express),
    MemoryStore = express.session.MemoryStore,
    _ = require('underscore'),
    Session = express.session.Session,
    os = require('os'),
    config = require('config').appserver,
    streaming = require ("streaming.io"),
    service = require("./service"),
    sys = require("sys"),
    spawn = require("child_process").spawn,
    db = require('./db'),
    Application = require('./application'),
    debug = require('debug')('appserver:server');

function Server() {
    this.initialize.apply(this, arguments);
}

util.inherits(Server, EventEmitter);

_.extend(Server, {
    extend: function (props, staticProps) {
        var parent = this;

        var child;
        if (props && _.has(props, 'constructor')) {
            child = props.constructor;
        } else {
            child = function () {
                return parent.apply(this, arguments);
            }
        }

        _.extend(child, parent, staticProps);

        var Surrogate = function () {
            this.constructor = child;
        }
        Surrogate.prototype = parent.prototype;
        child.prototype = new Surrogate;

        if (props) {
            _.extend(child.prototype, props);
        }

        child.__super__ = parent.prototype;
        return child;
    }
});

_.extend(Server.prototype, {
    listen: function (events) {
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

        var host = config.web.host;
        var port = config.web.port;

        this.__httpServer.on('error', function (e) {
            debug("Could not create HTTP server:", e);
            _.delay(function () {
                process.exit(1);
            }, 1000);
        }.bind(this));

        this.__httpServer.on('listening', function () {
            var address = this.__httpServer.address();
            debug("Server listening on %s:%d", address.address, address.port);
        }.bind(this))

        this.__httpServer.listen(port, host, config.web.backlog);
    },

    create: function (callback) {
        var app = express();
        this.__application = app;
        this.__httpServer = http.createServer(app);

        var io = socket.listen(this.__httpServer);
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

        app.use(app.router);

        this.createBaseRequests();

        io.on('connection', function (socket) {
            if (config.web.allowProxy && socket.handshake.headers['x-forwarded-for']) {
                socket.handshake.address.address = socket.handshake.headers['x-forwarded-for'];
            }
        });

        io.use(function (socket, next) {
            var data = socket.request;
            var sid = this.getSessionIdentifier(data);
            if (sid) {
                var decodedSID = utils.parseSignedCookie(sid, config.session.secret);

                data.sessionID = decodedSID;
                data.sessionStore = sessionStore;

                sessionStore.get(decodedSID, function (err, session) {
                    if (err || !session) {
                        next(new Error("Not authorized"));
                    } else {
                        data.session = new Session(data, session);
                        next(null);
                    }
                });
            } else {
                next(new Error("Not authorized"));
            }
        }.bind(this));

        if (callback) {
            callback.call(this, express, app, function (err) {
                if (err) {
                    debug("Error while starting server: %s", err);
                    process.exit(1);
                }
            });
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
        app.use(express.urlencoded());
        app.use(express.json());

        app.use(function (req, res, next) {
            res.sendResponse = function (data, headers, code) {
                switch (arguments.length) {
                    case 1: {
                        this.send(data);
                    } break;
                    case 2: {
                        this.send(headers, data);
                    } break;
                    case 3: {
                        this.set(headers);
                        this.send(code, data);
                    } break;
                }
            };
            next();
        });
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
    },

    createBaseRequests: function () {
        var app = this.getApp();
        var express = this.getExpress();
        var sessionStore = this.getSessionStore();

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
            res.sendResponse({token: true}, {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }, 200);
        });

        app.get('/ping', function (req, res) {
            res.sendResponse({"pong": new Date().getTime()}, {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }, 200);
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

exports.config = config;
exports.db = db;
exports.Application = Application;
exports.Server = Server;
