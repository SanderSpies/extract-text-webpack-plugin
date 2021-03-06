/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
var ConcatSource = require("webpack/lib/ConcatSource");
var Template = require("webpack/lib/Template");
var async = require("async");
var SourceNode = require("source-map").SourceNode;
var SourceMapConsumer = require("source-map").SourceMapConsumer;
var ModuleFilenameHelpers = require("webpack/lib/ModuleFilenameHelpers");
var ExtractedModule = require("./ExtractedModule");
var Chunk = require("webpack/lib/Chunk");

var nextId = 0;

function ExtractTextPlugin(id, filename, options) {
	if(typeof filename !== "string") {
		options = filename;
		filename = id;
		id = ++nextId;
	}
	if(!options) options = {};
	this.filename = filename;
	this.options = options;
	this.id = id;
	this.modulesByIdentifier = {};
}
module.exports = ExtractTextPlugin;

ExtractTextPlugin.loader = function(options) {
	return require.resolve("./loader") + (options ? "?" + JSON.stringify(options) : "");
};

ExtractTextPlugin.extract = function(before, loader) {
	if(loader) {
		return [
			ExtractTextPlugin.loader({omit: before.split("!").length, extract: true, remove: true}),
			before,
			loader
		].join("!");
	} else {
		loader = before;
		return [
			ExtractTextPlugin.loader({remove: true}),
			loader
		].join("!");
	}
};

ExtractTextPlugin.prototype.applyAdditionalInformation = function(source, info) {
	if(info) {
		return new ConcatSource(
			"@media " + info[0] + " {",
			source,
			"}"
		);
	}
	return source;
};

ExtractTextPlugin.prototype.loader = function(options) {
	options = JSON.parse(JSON.stringify(options || {}));
	options.id = this.id;
	return ExtractTextPlugin.loader(options);
};

ExtractTextPlugin.prototype.extract = function(before, loader) {
	if(loader) {
		return [
			this.loader({omit: before.split("!").length, extract: true, remove: true}),
			before,
			loader
		].join("!");
	} else {
		loader = before;
		return [
			this.loader({remove: true}),
			loader
		].join("!");
	}
};

ExtractTextPlugin.prototype.apply = function(compiler) {
	var options = this.options;
	compiler.plugin("this-compilation", function(compilation) {
		compilation.plugin("normal-module-loader", function(loaderContext, module) {
			loaderContext[__dirname] = function(content, opt) {
				if(options.disable)
					return false;
				if(!Array.isArray(content) && content !== null)
					throw new Error("Exported value is not a string.");
				module.meta[__dirname] = {
					content: content,
					options: opt
				};
				return options.allChunks || module.meta[__dirname + "/extract"];
			};
		}.bind(this));
		var contents;
		var filename = this.filename;
		var id = this.id;
		var extractedChunks, entryChunks;
		compilation.plugin("optimize", function() {
			entryChunks = compilation.chunks.filter(function(c) {
				return c.entry;
			});
		}.bind(this));
		compilation.plugin("optimize-tree", function(chunks, modules, callback) {
			contents = [];
			extractedChunks = chunks.map(function(chunk) {
				return new Chunk();
			});
			chunks.forEach(function(chunk, i) {
				var extractedChunk = extractedChunks[i];
				extractedChunk.index = i;
				extractedChunk.originalChunk = chunk;
				extractedChunk.name = chunk.name;
				chunk.chunks.forEach(function(c) {
					extractedChunk.addChunk(extractedChunks[chunks.indexOf(c)]);
				});
				chunk.parents.forEach(function(c) {
					extractedChunk.addParent(extractedChunks[chunks.indexOf(c)]);
				});
			});
			entryChunks.forEach(function(chunk) {
				var idx = chunks.indexOf(chunk);
				if(idx < 0) return;
				var extractedChunk = extractedChunks[idx];
				extractedChunk.entry = extractedChunk.initial = true;
			});
			async.forEach(chunks, function(chunk, callback) {
				var extractedChunk = extractedChunks[chunks.indexOf(chunk)];
				var shouldExtract = !!(options.allChunks || chunk.initial);
				async.forEach(chunk.modules.slice(), function(module, callback) {
					var meta = module.meta && module.meta[__dirname];
					if(meta) {
						var wasExtracted = Array.isArray(meta.content);
						if(shouldExtract !== wasExtracted) {
							module.meta[__dirname + "/extract"] = shouldExtract
							compilation.rebuildModule(module, function(err) {
								if(err) {
									compilation.errors.push(err);
									return callback();
								}
								meta = module.meta[__dirname];
								if(!Array.isArray(meta.content)) {
									var err = new Error(module.identifier() + " doesn't export content");
									compilation.errors.push(err);
									return callback();
								}
								if(meta.content)
									this.addResultToChunk(module.identifier(), meta.content, extractedChunk);
								callback();
							}.bind(this));
						} else {
							if(meta.content)
								this.addResultToChunk(module.identifier(), meta.content, extractedChunk);
							callback();
						}
					} else callback();
				}.bind(this), function(err) {
					if(err) return callback(err);
					callback();
				}.bind(this));
			}.bind(this), function(err) {
				if(err) return callback(err);
				extractedChunks.forEach(function(extractedChunk) {
					if(extractedChunk.initial)
						this.mergeNonInitialChunks(extractedChunk);
				}, this);
				compilation.applyPlugins("optimize-extracted-chunks", extractedChunks);
				callback();
			}.bind(this));
		}.bind(this));
		compilation.plugin("additional-assets", function(callback) {
			var assetContents = {};
			extractedChunks.forEach(function(extractedChunk) {
				if(extractedChunk.modules.length) {
					var chunk = extractedChunk.originalChunk;
					var file = compilation.getPath(filename, {
						chunk: chunk
					});
					compilation.assets[file] = this.renderExtractedChunk(extractedChunk);
					chunk.files.push(file);
				}
			}, this);
			callback();
		}.bind(this));
	}.bind(this));
};

ExtractTextPlugin.prototype.mergeNonInitialChunks = function(chunk, intoChunk, checkedChunks) {
	if(!intoChunk) {
		checkedChunks = [];
		chunk.chunks.forEach(function(c) {
			if(c.initial) return;
			this.mergeNonInitialChunks(c, chunk, checkedChunks);
		}, this);
	} else if(checkedChunks.indexOf(chunk) < 0) {
		checkedChunks.push(chunk);
		chunk.modules.slice().forEach(function(module) {
			chunk.removeModule(module);
			intoChunk.addModule(module);
			module.addChunk(intoChunk);
		});
		chunk.chunks.forEach(function(c) {
			if(c.initial) return;
			this.mergeNonInitialChunks(c, intoChunk, checkedChunks);
		}, this);
	}
};

ExtractTextPlugin.prototype.addModule = function(identifier, source, sourceMap, additionalInformation) {
	if(!this.modulesByIdentifier[identifier])
		return this.modulesByIdentifier[identifier] = new ExtractedModule(identifier, source, sourceMap, additionalInformation);
	return this.modulesByIdentifier[identifier];
};

ExtractTextPlugin.prototype.addResultToChunk = function(identifier, result, extractedChunk) {
	if(!Array.isArray(result)) {
		result = [[identifier, result]];
	}
	result.forEach(function(item) {
		var module = this.addModule.apply(this, item);
		extractedChunk.addModule(module);
		module.addChunk(extractedChunk);
	}, this);
};

ExtractTextPlugin.prototype.renderExtractedChunk = function(chunk) {
	var source = new ConcatSource();
	chunk.modules.forEach(function(module) {
		source.add(this.applyAdditionalInformation(module.source(), module.additionalInformation));
	}, this);
	return source;
};
