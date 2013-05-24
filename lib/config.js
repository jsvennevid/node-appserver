"use strict";

var _ = require('underscore'),
    fs = require('fs');

function Config() {
}

Config.settings = {};

Config.defaults = {
    "port": 8888,
    "websocket-port": 0,
    "deploy-version": "",
    "production": false,
    "compress": false,
    "pre-load": false,
    "session-key": "connect.sid",
    "session-secret": 'SESSION-SECRET',
    "session-timeout": 48 * (60 * 60) * 1000, // 48 hours
    "amqp": "",
    "memcached": ""
}

Config.get = function (name) {
    if (!_.isUndefined(Config.settings[name])) {
        return Config.settings[name];
    } else {
        return Config.defaults[name];
    }
}

Config.read = function (filename) {
    try {
        var contents = fs.readFileSync(filename, 'utf-8');
        var data = JSON.parse(contents);
        _.each(data, function (value, key) {
            Config.settings[key] = value;
        });
    } catch (e) {
        console.log("Could not find config '" + filename + "'");
    }

    for (var args = process.argv.slice(2), i = 0; i != args.length; ++i) {
        if ((args[i].slice(0, 2) == '--') && (i < args.length -1)) {
            var key = args[i].slice(2);
            var value = args[i+1];

            var source = Config.defaults[key];
            if (!_.isUndefined(source)) {
                switch (source.constructor.name) {
                    case "Number":
                    {
                        Config.settings[key] = parseInt(value);
                    }
                    break;

                    case "String":
                    {
                        Config.settings[key] = value;
                    }
                    break;

                    case "Boolean":
                    {
                        Config.settings[key] = (value === 'true');
                    }
                    break;

                    default:
                    {
                        console.log("Unhandled type '" + source.constructor.name + "' for config name '" + key + "'");
                    }
                    break;
                }
            }

            ++i;
        }

    }
}

module.exports = Config;
