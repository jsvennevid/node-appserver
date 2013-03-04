"use strict";

var express = require('express'), app = express.createServer(),
    io = require('socket.io').listen(app),
    cookies = require('cookies'),
    cookie = require('cookie'),
    RedisStore = require('connect-redis')(express),
    MemoryStore = express.session.MemoryStore,
    _ = require('underscore'),
    Session = require('connect').middleware.session.Session,
    os = require('os'),
    config = require('./config'),
    streaming = require ("streaming.io"),
    service = require("./service"),
    sys = require("sys"),
    spawn = require("child_process").spawn,
    db = require('./db'),
    Application = require('./application');

function start(roots, filters, events, callback) {
    var sessionStore;
    if (os.platform() == 'win32') {
        sessionStore = new MemoryStore();
    } else {
        sessionStore = new RedisStore();
    }

	app.use(express.logger({format: ':method :url :status \\n :req[Cookie] -> :res[Set-Cookie]'}));
	app.use(express.cookieParser());
	app.use(express.session({
		secret: config.get('session-secret'),
		store: sessionStore,
        key: config.get('session-key'),
        cookie: {
            path: '/',
            httpOnly: true,
            maxAge: config.get('session-timeout')
        }
	}));

    _.each(filters, function (filter) {
        app.use(filter());
    });

	_.each(roots, function (root) {
		app.use(express.static(root, { maxAge: 3600 }));
		
	});

	io.set('authorization', function (data, callback) {
		if (data.headers.cookie) {
			var cookieStore = cookie.parse(data.headers.cookie);
			var sid = decodeURIComponent(cookieStore['connect.sid']);

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
	});

    streaming.listen(io, app, service);

	console.log("Server started");

    callback(null, express, app);
}

function listen ()
{
    var port = config.get('port');
	app.listen(port);
    console.log("Server listening on port " + port);
}

exports.start = start;
exports.app = app;
exports.listen = listen;
exports.config = config;
exports.db = db;
exports.Application = Application;
