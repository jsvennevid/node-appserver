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
    AWS = require('aws-sdk'),
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
    listen: function (callback) {
        var app = this.getApp();
        var io = this.getIo();

        async.series([
            function (callback) {
                streaming.listen(io, app, service, {
                    config: config.streaming,
                    resolve: this.resolveService.bind(this),
                    read: function (url, data, session, callback, info) {
                        db.read(url, data, session, callback, info);
                    },
                    invalidate: function (url, callback) {
                        db.invalidatecache(url, callback);
                    }
                }, callback);
            }.bind(this),
            function (callback) {
                db.configure({
                    resolve: this.resolveService.bind(this),
                    config: config
                }, callback);
            }.bind(this),
            function (callback) {
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
            }.bind(this)
        ], callback);
    },

    create: function (callback) {
        var app = express();
        this.__application = app;
        this.__httpServer = http.createServer(app);

        var io = socket.listen(this.__httpServer);
        this.__io = io;

        io.set('log level', 2);

        if (config.aws) {
            debug("configuring AWS SDK");
            _.each(config.aws, function (value, key) {
                AWS.config[key] = value;
            });
        }

        var sessionStore;

        async.series([
            function (callback) {
                switch (config.session.type) {
                    case 'memory': {
                        sessionStore = new MemoryStore();
                        process.nextTick(function () {
                            this.__sessionStore = sessionStore;
                            callback(null);
                        }.bind(this));
                    } break;
                    case 'redis': {
                        this.resolveService("redis", config.session.redis.host, function (err, service) {
                            if (err) {
                                callback(err);
                                return;
                            }

                            sessionStore = new RedisStore(service);
                            this.__sessionStore = sessionStore;
                            callback(null);
                        }.bind(this));
                    } break;
                }
            }.bind(this),
            function (callback) {
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

                process.nextTick(function () {
                    callback(null);
                });
            }.bind(this)
        ], function (err) {
            if (err) {
                callback(err);
                return;
            }

            process.nextTick(function () {
                callback.call(this, express, app, function (err) {
                    if (err) {
                        debug("Error while starting server: %s", err);
                        _.defer(function () {
                            process.exit(1);
                        });
                    }
                });
            }.bind(this));
        }.bind(this));
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
    },

    resolveService: function (type, host, callback) {
        debug("resolve service", host, "(" + type + ")");

        switch (type) {
            case 'redis': {
                if (host.indexOf('aws:') != 0) {
                    var match = /(.+):([0-9]+)/.exec(host);
                    if (!match) {
                        process.nextTick(function () {
                            callback("error when matching hostname:port");
                        });
                        return;
                    }

                    debug("resolved redis endpoint %s:%d", match[1], match[2]);

                    process.nextTick(function () {
                        callback(null, {
                            host: match[1],
                            port: Number(match[2])
                        });
                    });
                    return;
                }

                var id = host.slice(4);

                (new AWS.ElastiCache()).describeCacheClusters({
                    "CacheClusterId": id,
                    "ShowCacheNodeInfo": true
                }, function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    do {
                        if (data.CacheClusters.length == 0) {
                            debug("found no cache clusters for ", id);
                            break;
                        }

                        var cluster = data.CacheClusters[0];

                        if (cluster.CacheNodes.length == 0) {
                            debug("found no cache nodes in cache cluster", id);
                            break;
                        }

                        var node = cluster.CacheNodes[0];

                        debug("resolved AWS redis endpoint %s:%d", node.Endpoint.Address, node.Endpoint.Port);

                        callback(null, {
                            host: node.Endpoint.Address,
                            port: node.Endpoint.Port
                        });
                        return;
                    } while (0);

                    callback("Could not retrieve AWS redis cluster");
                });
            } break;
            case 'memcached': {
                if (host.indexOf('aws:') != 0) {
                    var match = /(.+):([0-9]+)/.exec(host);
                    if (!match) {
                        process.nextTick(function () {
                            callback("error when matching hostname:port");
                        });
                        return;
                    }

                    debug("resolved memcached endpoint %s:%d", match[1], match[2]);

                    process.nextTick(function () {
                        callback(null, [{
                            host: match[1],
                            port: Number(match[2])
                        }]);
                    });
                    return;
                }

                var id = host.slice(4);

                (new AWS.ElastiCache()).describeCacheClusters({
                    "CacheClusterId": id,
                    "ShowCacheNodeInfo": true
                }, function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    do {
                        if (data.CacheClusters.length == 0) {
                            debug("could not find any memcached clusters");
                            break;
                        }

                        var cluster = data.CacheClusters[0];
                        if (cluster.Engine != 'memcached') {
                            debug("returned cache cluster is not memcached");
                            break;
                        }

                        var nodes = cluster.CacheNodes.filter(function (node) {
                            return node.CacheNodeStatus == 'available';
                        });
                        if (nodes.length == 0) {
                            debug("cache cluster contains now available nodes");
                            break;
                        }

                        var hosts = nodes.map(function (node) {
                            return {
                                host: node.Endpoint.Address,
                                port: node.Endpoint.Port
                            };
                        });

                        debug("resolved AWS memcached cluster nodes: %s", hosts.map(function (host) {
                            return host.host + ":" + host.port;
                        }).join(","));

                        callback(null, hosts);
                        return;
                    } while (0);

                    callback("Could not retrieve AWS memcached cluster");
                });
            } break;
        }
    }
});

exports.config = config;
exports.db = db;
exports.Application = Application;
exports.Server = Server;
