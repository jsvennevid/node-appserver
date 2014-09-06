"use strict";

var _ = require('underscore');

function ContentDistribution() {
    this.uri = '';
}

_.extend(ContentDistribution.prototype, {
    initialize: function (options, callback) {
        if (!options.host) {
            process.nextTick(callback);
            return;
        }

        options.resolve("cdn", options.host, function (err, service) {
            if (err) {
                callback(err);
                return;
            }

            this.uri = '//' + service.host;
            callback(null);
        }.bind(this));
    },

    getUri: function () {
        return this.uri;
    }
});

module.exports = new ContentDistribution();
