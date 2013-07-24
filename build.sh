#!/bin/sh

VER=`grep -Go 'version\>\(.*\)\<' install.rdf | grep -Go '>\(.*\)<' | sed -e 's/[><]*//g'`
XPI="bartablitex-$VER.xpi"
echo "Building $XPI ..."

# Copy base structure to a temporary build directory and move in to it
rm -rf build
mkdir build
cp -r \
  README bartab.css bootstrap.js icon.png icon64.png install.rdf pullstarter.js \
  build/
cd build

zip -qru9XD "../$XPI" *

cd ..
rm -rf build
