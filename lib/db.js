"use strict";

var _ = require('underscore'),
    streaming = require("streaming.io");

function getUrlKey(url) {
	var re = /\/([^\/]*)(?:\/(.*))?/;	
	var match = re.exec(url);
	if (_.isNull(match)) {
		return [null, null];
	}

	return match.slice(1,3);
}

function Pattern(pattern) {
    var output = "^";
    var params = [];

    while (!_.isUndefined(pattern)) {
        var match = /^\:([^\/]+)?(?:\/(.*))?$/.exec(pattern);
        pattern = match[2];
        params.push(match[1]);
        output += "([^\/]+)?";

        if (!_.isUndefined(pattern)) {
            output += "\/";
        }
    }

    output += "$";

    this.regex = new RegExp(output);
    this.params = params;
}

Pattern.prototype.exec = function(input) {
    return this.regex.exec(input);
};

function Link(source, targets) {
    this.source = this.pattern(source);
    this.targets = _.map(targets, function (target) {
        this.pattern(target);
    }, this);
}

function Handler(pattern, filters, fn) {

    if (!_.isNull(pattern)) {
        this.pattern = new Pattern(pattern);
    } else {
        this.pattern = null;
    }

    this.filters = filters;
    this.fn = fn;
}

Handler.prototype.call = function(url, args, method, data, callback, session) {
    var filterData = {
        url: url,
        session: session,
        callback: callback,
        params: {},
        input: []
    };

    var filters = _.clone(this.filters);

    if (!_.isNull(this.pattern)) {
        var match = this.pattern.exec(args);
        filterData.input = match.slice(1);
        _.each(this.pattern.params, function (param, index) {
            filterData.params[param] = filterData.input[index];
        });
    }

    var next = function (err) {
        if (err) {
            filterData.callback(err);
            return;
        }
        var filter = filters.shift();
        filter.call(filterData, next);
    }

    filters.push({
        call: _.bind(function () {
            var input = filterData.input;

            if (!_.isUndefined(method)) {
                input.push(method);
            }

            if (!_.isUndefined(data)) {
                input.push(data);
            }

            input.push(filterData.callback);
            input.push(filterData.session);

            this.fn.apply(null, input);
        }, this)
    });

    next(null);
};

var handlers = {
	'create': {},
	'read': {},
	'update': {},
	'destroy': {},
    'emit': {}
};

var links = {};
var caches = {};
var pending = {};

exports.on = function (type, key) {

    var args = Array.prototype.slice.call(arguments);

    var filters = _.clone(args).slice(2, args.length - 1);
    var fn = args.slice(args.length - 1)[0];

    if (key.indexOf('/') >= 0) {
        var keys = /([^\/]+)?\/(.*)/.exec(key);
        handlers[type][keys[1]] = new Handler(keys[2], filters, fn);
    } else {
        handlers[type][key] = new Handler(null, filters, fn);
    }
};

exports.registerCache = function (key, target) {
    var cache = caches[key] || [];
    cache.push(target);
    caches[key] = cache;
}

exports.trigger = function (url) {
    var key = getUrlKey(url);
    var cache = caches[key[0]];
    _.each(cache, function (target) {
        target.invalidate(url);
    });

    var func = pending[url] || _.debounce(function () {
        streaming.trigger(url, function (url, data, session, callback) {
            exports.read(url, data, session, callback);
        }, function (socket, message) {
            socket.emit("stream", message);
        });
        delete pending[url];
    }, 100);

    pending[url] = func;
    func();
};

exports.create = function (url, data, session, callback) {
	var keys = getUrlKey(url);

    console.log("db:create - " + url);
    console.log(data);

    var handler = handlers['create'][keys[0]];
	if (!_.isUndefined(handler)) {
        handler.call(url, keys[1], undefined, data, function (err, data, session) {
			callback(err, data, session);
		}, session);
	} else {
		callback("db:create - unhandled url '" + url + "'");
	}
};

exports.read = function (url, data, session, callback) {
	var keys = getUrlKey(url);

    console.log("db:read - " + url);
    console.log(data);

    var handler = handlers['read'][keys[0]];
	if (!_.isUndefined(handler)) {
        handler.call(url, keys[1], undefined, undefined, callback, session);
	} else {
		callback("db:read - unhandled url '" + url + "'");
	}
};

exports.update = function (url, data, session, callback) {
	var keys = getUrlKey(url);

    console.log("db:update - " + url);
    console.log(data);

    var handler = handlers['update'][keys[0]];
	if (!_.isUndefined(handler)) {
		handler.call(url, keys[1], undefined, data, function (err, data, session) {
			callback(err, data, session);
		}, session);
	} else {
		callback("db:update - unhandled url '" + url + "'");
	}
};

exports.destroy = function (url, data, session, callback) {
    var keys = getUrlKey(url);

    console.log("db:destroy - " + url);
    console.log(data);

    var handler = handlers['destroy'][keys[0]];
    if (!_.isUndefined(handler)) {
        handler.call(url, keys[1], undefined, undefined, function (err, data, session) {
            callback(err, data, session);
        }, session);
    } else {
        callback("db:destroy - unhandled url '" + url + "'");
    }
};

exports.emit = function (url, method, data, session, callback) {
    var keys = getUrlKey(url);

    var handler = handlers['emit'][keys[0]];
    if (!_.isUndefined(handler)) {
        handler.call(url, keys[1], method, data, function (err, response) {
            callback(err, response);
        }, session);
    } else {
        callback("db:emit - unhandled url '" + url + "'");
    }
};

exports.stream = function (socket, url, callback) {
	exports.read(url, {}, socket.handshake.session, function (err, data) {
		if (err) {
			callback(err);
			return;
		}

        registry.addSubscription(socket, url);
		callback(null, data);
	});
};

exports.unstream = function (socket, url, callback) {
    registry.removeSubscription(socket, url);
	callback(null, {});
};
