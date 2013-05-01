var _ = require("underscore"),
    glob = require("glob"),
    path = require("path")
    fs = require("fs"),
    connect = require('connect'),
    utils = connect.utils,
    config = require('./config');

module.exports = Application;

function Application()
{
    this.inherits = [];

    this.scripts = {};
    this.templates = {};
    this.styles = {};

    this.files = {};
}

_.extend(Application, {
    apps: {},

    register: function (app) {
        Application.apps[app.name] = app;
    },

    create: function (options) {
        var app = new Application();

        app.name = options.name;
        app.root = options.root;

        _.each(options.js, function (scripts, name) {
            var matches = app.getMatches(scripts);
            app.buildScripts(name, matches);
        });

        _.each(options.templates, function (templates, name) {
            var matches = app.getMatches(templates);
            app.buildTemplates(name, matches);
        });

        _.each(options.styles, function (styles, name) {
            var matches = app.getMatches(styles);
            app.buildStyles(name, matches);
        });

        if (!!options.publish || _.isUndefined(options.publish)) {
            app.buildApplication(options.use, options.inherit);
        }

        Application.register(app);

        return app;
    },

    express: function (content, options) {
        var options = options || {};
        var pathRe = /apps\/([A-Za-z]+)?\/(.*)/;

        return function (req, res, next) {
            var path = utils.parseUrl(req).path;
            var match = pathRe.exec(path);

            if (match) {
                var apps = Application.apps;

                do {
                    var app = apps[match[1]];
                    if (!app) {
                        break;
                    }

                    var file = app.files[match[2]];
                    if (!file) {
                        break;
                    }

                    var data = file.data;
                    if (data) {
                        res.send(data, {"Content-Type": file.type}, 200);
                    } else {
                        file.generate(function (err, data) {
                            if (!err) {
                                // TODO: cache generated data in a production environment
                                if (config.get("production")) {
                                    file.data = data;
                                }
                                res.send(data, {"Content-Type": file.type}, 200);
                            } else {
                                res.send("File not found", 404);
                            }
                        });
                    }

                    return;
                } while (0);
            }

            next();
        }
    }
});

_.extend(Application.prototype, {
    getMatches: function (specs) {
        var files = [];
        _.each(specs, function (spec) {
            var filespec = spec;
            var tags;
            if (_.isObject(spec)) {
                filespec = spec['file'];
                tags = spec['tags'];
            }
            if (filespec[0] == '/') {
                files = files.concat({files: [filespec], tags: tags});
                return;
            }
            var search = path.join(this.root, spec);
            var match = glob.sync(search);
            files.push({files: match, tags: tags});
        }, this);
        return files;
    },

    buildScripts: function (name, matches) {
        var scripts = this.scripts[name] = (this.scripts[name] || []);
        var bundle = [];

        _.each(matches, function (match) {
            _.each(match.files, function (file) {
                if (file[0] == '/') {
                    scripts.push({name: file, tags: match.tags});
                    return;
                }

                var bname = path.basename(file);
                var target = 'scripts/' + name + '/' + bname;

                var generate = function (callback) {
                    fs.readFile(file, callback);
                }

                if (!match.tags && config.get("production")) {
                    bundle.push({
                        target: target,
                        bname: bname,
                        generate: generate
                    });
                } else {
                    this.files[target] = { generate: generate, type: "text/javascript" };
                    scripts.push({name: bname, tags: match.tags});
                }
            }, this);
        }, this);

        if (bundle.length > 0) {
            this.files['scripts/' + name + '/' + name + '.js'] = {
                generate: function (callback) {
                    var result = '';
                    var errors = 0;
                    var complete = _.after(bundle.length, function () {
                        callback(errors > 0 ? 'Errors while creating bundle' : null, result);
                    })

                    _.each(bundle, function (entry) {
                        entry.generate(function (err, data) {
                            if (err) {
                                ++ errors;
                                complete();
                            }
                            result += '/* '+ entry.target +' */\n\n' + data + '\n\n';
                            complete();
                        });
                    });
                },
                type: "text/javascript"
            };
            scripts.push({name: name + '.js'});
        }
    },

    buildTemplates: function (name, matches) {
        var templates = this.templates[name] = (this.templates[name] || []);
        var bundle = [];

        _.each(matches, function (match) {
            _.each(match.files, function (file) {
                var rname = path.basename(file, '.html').replace(/[-]/g, '_');
                var vname = (name + '/' + rname).replace(/[\/]/g, '_');
                var bname = rname + '.js';
                var target = 'templates/' + name + '/' + bname;

                var generate = function (callback) {
                    fs.readFile(file, 'utf-8', function (err, data) {
                        if (err) {
                            callback(err);
                            return;
                        }

                        var compiled = _.template(data);
                        var patchData = 'Templates.' + vname + ' = ' + compiled.source;

                        callback(null, patchData);
                    });
                }

                if (!match.tags && config.get("production")) {
                    bundle.push({
                        target: target,
                        bname: bname,
                        generate: generate
                    });
                } else {
                    this.files[target] = { generate: generate, type: "text/javascript" };
                    templates.push({name: bname, tags: match.tags});
                }
            }, this);
        }, this);

        if (bundle.length > 0) {
            this.files['templates/' + name + '/' + name + '.js'] = {
                generate: function (callback) {
                    var result = '';
                    var errors = 0;
                    var complete = _.after(bundle.length, function () {
                        callback(errors > 0 ? 'Errors while creating bundle' : null, result);
                    })

                    _.each(bundle, function (entry) {
                        entry.generate(function (err, data) {
                            if (err) {
                                ++ errors;
                                complete();
                            }
                            result += '/* '+ entry.target +' */\n\n' + data + '\n\n';
                            complete();
                        });
                    });
                },
                type: "text/javascript"
            };
            templates.push({name: name + '.js'});
        }
    },

    buildStyles: function (name, matches) {
        var styles = this.styles[name] = (this.styles[name] || []);
        var bundle = [];

        _.each(matches, function (match) {
            _.each(match.files, function (file) {
                if (file[0] == '/') {
                    styles.push({name: file, tags: match.tags});
                    return;
                }

                var bname = path.basename(file);
                var target = 'styles/' + name + '/' + bname;

                var generate = function (callback) {
                    return fs.readFile(file, callback);
                }

                if (!match.tags && config.get("production")) {
                    bundle.push({
                        target: target,
                        bname: bname,
                        generate: generate
                    });
                } else {
                    this.files[target] = { generate: generate, type: "text/css" };
                    styles.push({name: bname, tags: match.tags});
                }
            }, this);
        }, this);

        if (bundle.length > 0) {
            this.files['styles/' + name + '/' + name + '.css'] = {
                generate: function (callback) {
                    var result = '';
                    var errors = 0;
                    var complete = _.after(bundle.length, function () {
                        callback(errors > 0 ? 'Errors while creating bundle' : null, result);
                    })

                    _.each(bundle, function (entry) {
                        entry.generate(function (err, data) {
                            if (err) {
                                ++ errors;
                                complete();
                            }
                            result += '/* '+ entry.target +' */\n\n' + data + '\n\n';
                            complete();
                        });
                    });
                },
                type: "text/css"
            };
            styles.push({name: name + '.css'});
        }
    },

    gather: function (target, key, use, root) {
        var types = this[key];

        if (_.isUndefined(types)) {
            return;
        }

        _.each(types[use], function (entry) {
            var file = entry.name;
            if (file[0] != '/') {
                var absolute = this.name + '/' + key + '/' + use + '/' + file;
                var relative = path.relative(root, absolute).replace(/\\/g, '/');
                target.push({name: relative, tags: entry.tags});
            } else {
                target.push(entry);
            }
        }, this);
    },

    buildApplication: function (uses, inherits) {
        // TODO: handle recursive dependencies

        var data = {
            styles: [],
            scripts: [],
            templates: []
        };

        _.each(uses, function (use) {
            _.each(inherits, function (inherit) {
                _.each(data, function (target, key) {
                    inherit.gather(target, key, use, this.name + '/');
                }, this);
            }, this);

            _.each(data, function (target, key) {
                this.gather(target, key, use, this.name + '/');
            }, this);
        }, this);

        var generate = _.bind(function (callback) {
            var input = fs.readFile(this.root + '/index.html', 'utf-8', function (err, input) {
                if (err) {
                    callback(err);
                    return;
                }

                var tpl = _.template(input);
                var result = tpl(data);
                callback(null, result);
            });
        }, this);

        this.files[''] = { generate: generate, type: 'text/html' };
    }
});
