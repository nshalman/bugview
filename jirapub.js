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

	s.get('/bugview', function (req, res, next) {
		res.header('Location', req.url + '/index.html');
		res.send(302);
		next(false);
	});
	s.get('/bugview/index.html', handle_issue_index);
	s.get('/bugview/:key', handle_issue);

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
handle_issue_index(req, res, next)
{
	var log = req.log.child({
		remoteAddress: req.socket.remoteAddress,
		remotePort: req.socket.remotePort,
		userAgent: req.headers['user-agent'],
		referrer: req.headers['referrer'],
		forwardedFor: req.headers['x-forwarded-for'],
		issue_index: true
	});

	var url = CONFIG.url.path + '/search?jql=labels%20%3D%20%22' +
	    CONFIG.label + '%22&fields=summary';

	JIRA.get(url, function (_err, _req, _res, results) {
		if (_err) {
			log.error(_err, 'error communicating with JIRA');
			res.send(500);
			next(false);
			return;
		}

		log.info('serving issue index');

		var out = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge"><link href="//netdna.bootstrapcdn.com/bootstrap/3.0.3/css/bootstrap.min.css" rel="stylesheet"><style>body { padding-top: 50px; padding-bottom: 20px; }</style></head><body><div class="navbar navbar-inverse navbar-fixed-top" role="navigation"><div class="container"><div class="navbar-header"><button type="button" class="navbar-toggle" data-toggle="collapse" data-target=".navbar-collapse"><span class="sr-only">Toggle navigation</span><span class="icon-bar"></span><span class="icon-bar"></span><span class="icon-bar"></span></button><a class="navbar-brand" href="/bugview">Bugview</a></div></div></div><div class="container"><h1>Public Issues Index</h1>' +
		    '<table class="table"><thead><tr><th><b>Issue</b></th><th><b>Synopsis</b></th></tr></thead><tbody>\n';
		for (var i = 0; i < results.issues.length; i++) {
			var issue = results.issues[i];
			out += '<tr><td><a href="' + issue.key + '">' + issue.key +
			    '</a></td><td>' + issue.fields.summary + '</td></tr>\n';
		}
		out += '</table></div></tbody></body></html>\n';

		res.contentType = 'text/html';
		res.contentLength = out.length;

		res.writeHead(200);
		res.write(out);
		res.end();

		next();
		return;
	});
}

function
handle_issue(req, res, next)
{
	var log = req.log.child({
		remoteAddress: req.socket.remoteAddress,
		remotePort: req.socket.remotePort,
		userAgent: req.headers['user-agent'],
		referrer: req.headers['referrer'],
		forwardedFor: req.headers['x-forwarded-for'],
		issue: req.params.key
	});

	if (!req.params.key || !req.params.key.match(/^[A-Z]+-[0-9]+$/)) {
		log.error({ key: req.params.key }, 'invalid "key" provided');
		res.send(400);
		next(false);
		return;
	}

	var url = CONFIG.url.path + '/issue/' + req.params.key;

	JIRA.get(url, function (_err, _req, _res, issue) {
		if (_err) {
			if (_err && _err.name === "NotFoundError") {
				log.error(_err, 'could not find issue');
				res.send(404, 'Sorry, that issue does not exist.\n');
				next(false);
				return;
			}
			log.error(_err, 'error communicating with JIRA');
			res.send(500);
			next(false);
			return;
		}

		if (!issue || !issue || !issue.fields || !issue.fields.labels) {
			log.error('JIRA issue did not have expected format');
			res.send(500);
			next(false);
			return;
		}

		if (issue.fields.labels.indexOf(CONFIG.label) === -1) {
			log.error('request for non-public issue');
			res.send(403, 'Sorry, this issue is not public.\n');
			next(false);
			return;
		}

		log.info('serving issue');

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
	var lines = desc.split(/\r?\n/);

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
