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
    cdn = require('./cdn'),
    AWS = require('aws-sdk'),
    Application = require('./application'),
    debug = require('debug')('appserver:server'),
    url = require('url');

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

        var io = socket.listen(this.__httpServer, {
            serveClient: false
        });
        this.__io = io;

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

                app.set('trust proxy', config.web.proxy.allow);
                if (config.web.proxy.forceSSL) {
                    app.use(function (req, res, next) {
                        do {
                            if (!req.headers.hasOwnProperty(config.web.proxy.protocol)) {
                                break;
                            }

                            var protocol = req.headers[config.web.proxy.protocol];
                            if (protocol.toLowerCase() == 'https') {
                                break;
                            }

                            if (req.url == '/ping') {
                                break;
                            }

                            res.redirect('https://' + (req.headers['host'] ? req.headers['host'] : req.host) + req.originalUrl);
                        } while (0);

                        next();
                    });
                }

                this.createBaseRequests();

                io.on('connection', function (socket) {
                    if (config.web.proxy.allow && socket.handshake.headers.hasOwnProperty(config.web.proxy.address)) {
                        var address = socket.handshake.headers[config.web.proxy.address];
                        socket.handshake.address = address.split(/*, */)[0];
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
            }.bind(this),
            function (callback) {
                cdn.initialize({
                    host: config.cdn.host,
                    resolve: this.resolveService.bind(this)
                }, callback);
            }.bind(this)
        ], function (err) {
            if (err) {
                debug("Error while starting server: %s", err);
                _.defer(function () {
                    process.exit(1);
                });
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
            res.set({
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.send(200, {token: true});
        });

        app.get('/ping', function (req, res) {
            res.set({
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.send(200, {"pong": new Date().getTime()});
        });

        app.get('/lib/socket.io.js', this.__io.serve.bind(this.__io));
    },

    getSessionIdentifier: function (data) {
        var sid = undefined;

        do {
            if (data.headers.cookie) {
                var cookieStore = cookie.parse(data.headers.cookie);
                sid = decodeURIComponent(cookieStore[config.session.key]);
            }

            if (sid || (!config.session.allow_query)) {
                break;
            }

            var parts = url.parse(data.url, true);
            if (!parts) {
                break;
            }

            var query = parts.query;
            if (!query) {
                break;
            }

            sid = query[config.session.key];
        } while (0);

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

                    for (var i in data.CacheClusters) {
                        var cluster = data.CacheClusters[i];
                        debug("evaluating cache cluster %s", cluster.CacheClusterId);

                        if (cluster.Engine != 'redis') {
                            debug("cluster is not redis (%s)", cluster.Engine);
                            continue;
                        }

                        if (cluster.CacheClusterStatus != 'available') {
                            debug("cluster is not available (%s)", cluster.CacheClusterStatus);
                            continue;
                        }

                        var nodes = cluster.CacheNodes.filter(function (node) {
                            return node.CacheNodeStatus == 'available';
                        });
                        if (nodes.length == 0) {
                            debug("cache cluster contains no available nodes");
                            continue;
                        }

                        var node = nodes[0];

                        debug("resolved AWS redis endpoint %s:%d", node.Endpoint.Address, node.Endpoint.Port);

                        callback(null, {
                            host: node.Endpoint.Address,
                            port: node.Endpoint.Port
                        });
                        return;
                    }

                    callback("found no cache clusters through AWS discovery");
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

                    for (var i in data.CacheClusters) {
                        var cluster = data.CacheClusters[i];
                        debug("evaluating cache cluster", cluster.CacheClusterId);

                        if (cluster.Engine != 'memcached') {
                            debug("cache cluster is not memcached (%s)", cluster.Engine);
                            continue;
                        }

                        if (cluster.CacheClusterStatus != 'available') {
                            debug("cache cluster is not available");
                            continue;
                        }

                        var nodes = cluster.CacheNodes.filter(function (node) {
                            return node.CacheNodeStatus == 'available';
                        });
                        if (nodes.length == 0) {
                            debug("cache cluster contains no available nodes");
                            continue;
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
                    }

                    callback("found no memcached clusters through AWS discovery");
                });
            } break;
            case 'mysql': {
                if (host.indexOf('aws:') != 0) {
                    var match = /(.+)(?::([0-9]+))?/.exec(host);
                    if (!match) {
                        process.nextTick(function () {
                            callback("error when matching MySQL service");
                        });
                        return;
                    }

                    var service = {
                        host: match[1],
                        port: match[2] ? Number(match[2]) : 3306
                    };

                    debug("resolved MySQL service %s:%d", service.host, service.port);

                    callback(null, service);
                    return;
                }

                var id = host.slice(4);

                (new AWS.RDS()).describeDBInstances({
                    DBInstanceIdentifier: id
                }, function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    for (var i in data.DBInstances) {
                        var instance = data.DBInstances[i];
                        debug("evaluating db instance %s", instance.DBInstanceIdentifier);

                        if (instance.Engine != 'mysql') {
                            debug("instance is not MySQL (%s)", instance.Engine);
                            continue;
                        }

                        if (instance.DBInstanceStatus != 'available') {
                            debug("instance is not available");
                            continue;
                        }

                        debug("resolved AWS MySQL service %s:%d", instance.Endpoint.Address, instance.Endpoint.Port);

                        callback(null, {
                            host: instance.Endpoint.Address,
                            port: instance.Endpoint.Port
                        });
                        return;
                    }

                    callback("found no MySQL instances through AWS discovery");
                });
            } break;
            case 'cdn': {
                if (host.indexOf('aws:') != 0) {
                    var service = {
                        host: host,
                        port: 80
                    };

                    callback(null, service);
                    return;
                }

                var id = host.slice(4);

                (new AWS.CloudFront()).getDistribution({
                    Id: id
                }, function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    do {
                        if (data.Status != 'Deployed') {
                            debug("cloudfront distribution not in deployed state");
                            break;
                        }

                        debug("resolved AWS CloudFront distribution: %s", data.DomainName);

                        var service = {
                            host: data.DomainName,
                            port: 80
                        };

                        callback(null, service);
                        return;
                    } while (0);


                    callback("found no CloudFront distribution through AWS discovery");
                });
            } break;
        }
    }
});

exports.config = config;
exports.db = db;
exports.cdn = cdn;
exports.Application = Application;
exports.Server = Server;
