var config = require('config');
config.util.setModuleDefaults('appserver', {
    "web": {
        "host": undefined,
        "backlog": undefined,
        "port": 8888,
        "wsPort": 0,

        "proxy": {
            "allow": false,
            "forceSSL": false,
            "address": "x-forwarded-for",
            "protocol": "x-forwarded-proto",
        }
    },
    "production": false,
    "compress": false,
    "bundlecache": undefined,
    "preload": false,
    "logformat": "default",
    "session": {
        "type": "memory",

        "key": "connect.sid",
        "client_key": "connect.cid",
        "allow_query": true,
        "secret": "SECRET",
        "secure": false,
        "timeout": 48 * (60 * 60) * 1000,

        "redis": {
            "host": "localhost:6379"
        }
    },
    "streaming": {
        "registry": {
            "type": "local",
            "redis": {
                "host": "localhost:6379",
                "prefix": "registry:"
            }
        },
    },
    "memcached": {
        "host": ""
    },
    "cdn": {
        "host": ""
    },
    "aws": undefined,
    "appid": undefined
});

module.exports = require('./lib/server');
