
JS_FILES = \
	jirapub.js

.PHONY: all
all: 0-npm-stamp

.PHONY: check
check:
	jshint $(JS_FILES)

0-npm-stamp:
	npm install
	touch $@

