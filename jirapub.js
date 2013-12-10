#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_assert = require('assert');
var mod_restify = require('restify');
var mod_bunyan = require('bunyan');
var mod_fs = require('fs');
var mod_path = require('path');
var mod_util = require('util');

var LOG = mod_bunyan.createLogger({
	name: 'jirapub'
});

var CONFIG = read_config(LOG);

var JIRA;
var SERVER;

/*
 * Initialisation Routines:
 */

function
read_config(log)
{
	var p = mod_path.join(__dirname, 'config.json');
	var f = mod_fs.readFileSync(p, 'utf8');
	var c = JSON.parse(f);

	try {
		var CHECK = [ 'username', 'password', 'url', 'label', 'port' ];
		for (var i = 0; i < CHECK.length; i++) {
			mod_assert.ok(c[CHECK[i]], 'config.' + CHECK[i]);
		}
		mod_assert.ok(c.url.base, 'config.url.base');
		mod_assert.ok(c.url.path, 'config.url.path');
	} catch (ex) {
		log.error(ex, 'configuration validation failed');
		process.exit(1);
	}

	return (c);
}

function
create_http_server(log, callback)
{
	var s = mod_restify.createServer({
		name: 'jirapub',
		log: log.child({
			component: 'http'
		})
	});

	s.get('/issue/:key', handle_issue);

	s.listen(CONFIG.port, function (err) {
		if (err) {
			log.error(err, 'http listen error');
			process.exit(1);
		}

		log.info({
			port: CONFIG.port
		}, 'http listening');

		callback(s);
	});
}

/*
 * Route Handlers:
 */

function
handle_issue(req, res, next)
{
	if (!req.params.key || !req.params.key.match(/^[A-Z]+-[0-9]+$/)) {
		req.log.error({ key: req.params.key }, 'invalid "key" provided');
		res.send(400);
		next(false);
		return;
	}

	var url = CONFIG.url.path + '/issue/' + req.params.key;

	JIRA.get(url, function (_err, _req, _res, issue) {
		if (_err) {
			if (_err && _err.name === "NotFoundError") {
				res.log.error(_err, 'could not find issue');
				res.send(404, 'Sorry, that issue does not exist.\n');
				next(false);
				return;
			}
			req.log.error(_err, 'error communicating with JIRA');
			res.send(500);
			next(false);
			return;
		}

		if (!issue || !issue || !issue.fields || !issue.fields.labels) {
			req.log.error(_err, 'JIRA issue did not have expected format');
			res.send(500);
			next(false);
			return;
		}

		if (issue.fields.labels.indexOf('public') === -1) {
			res.send(403, 'Sorry, this issue is not public.\n');
			next(false);
			return;
		}

		var out = '<html><body>' +
		    format_issue(issue) +
		    //mod_util.inspect(issue, false, 100, false) +
		    '</body></html>';
		res.contentType = 'text/html';
		res.contentLength = out.length;

		res.writeHead(200);
		res.write(out);
		res.end();

		next();
		return;
	});
}

/*
 * Formatter:
 */

function
format_markup(desc)
{
	var out = '';
	var lines = desc.split(/\r\n/);

	var fmton = false;
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];

		if (line.match(/^{noformat/) || line.match(/^{code/)) {
			if (fmton) {
				out += '</pre>\n';
			} else {
				out += '<pre style="border: 2px solid black;' +
				    'font-family: Menlo, Courier, Lucida Console, Monospace;' +
				    'background-color: #eeeeee;">\n';
			}
			fmton = !fmton;
		} else {
			if (fmton) {
				out += line + '\n';
			} else {
				out += line + '<br>\n';
			}
		}
	}

	return (out);
}

function
format_issue(issue)
{
	var out = '<h1>' + issue.key + ': ' + issue.fields.summary + '</h1>\n';

	if (issue.fields.resolution) {
		var rd = new Date(issue.fields.resolutiondate);

		out += '<h2>Resolution</h2>\n';
		out += '<p><b>' + issue.fields.resolution.name + ':</b> ' +
		    issue.fields.resolution.description + '<br>\n';
		out += '(Resolution Date: ' + rd.toISOString() + ')</p>\n';
	}

	if (issue.fields.fixVersions && issue.fields.fixVersions.length > 0) {
		out += '<h2>Fix Versions</h2>\n';
		for (var i = 0; i < issue.fields.fixVersions.length; i++) {
			var fv = issue.fields.fixVersions[i];

			out += '<p><b>' + fv.name + '</b> (Release Date: ' +
			    fv.releaseDate + ')</p>\n';
		}
	}

	if (issue.fields.description) {
		out += '<h2>Description</h2>\n';
		out += '<div>';
		out += format_markup(issue.fields.description);
		out += '</div>\n';
	}

	if (issue.fields.comment) {
		out += '<h2>Comments</h2>\n';

		var c = issue.fields.comment;

		if (c.maxResults !== c.total) {
			LOG.error({
				issue: issue.key,
				total: c.total,
				maxResults: c.maxResults
			}, 'comment maxResults and total not equal for issue');
		}

		var dark = false;
		for (var i = 0; i < c.comments.length; i++) {
			var com = c.comments[i];

			var cdtc = new Date(com.created);

			out += '<div style="background-color: ' + (dark ? '#DDDDDD' : '#EEEEEE') +
			    ';">\n';
			out += '<b>';
			out += 'Comment by ' + com.author.displayName + '<br>\n';
			out += 'Created at ' + cdtc.toISOString() + '<br>\n';
			if (com.updated && com.updated !== com.created) {
				out += 'Updated at ' + new Date(com.updated).toISOString() +
				    '<br>\n';
			}
			out += '</b>';
			out += format_markup(com.body);
			out += '</div><br>\n';

			dark = !dark;
		}
	}

	return (out);
}

/*
 * Main:
 */

function
main() {
	create_http_server(LOG, function (s) {
		SERVER = s;
	});

	JIRA = mod_restify.createJsonClient({
		url: CONFIG.url.base,
		connectTimeout: 15000,
		userAgent: 'JoyentJIRAPublicAccess',
		log: LOG.child({
			component: 'jira'
		})
	});
	JIRA.basicAuth(CONFIG.username, CONFIG.password);
}

main();
