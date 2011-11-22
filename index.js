//
// A file uploader
//
//     by Alexis Sellier
//
var http = require('http'),
    path = require('path'),
    events = require('events'),
    child = require('child_process'),
    fs = require('fs');

var port = process.argv[2] ? parseInt(process.argv[2]) : 8080;

var CR = 13, LF = 10;

var uploads = JSON.parse(fs.readFileSync('uploads.db'));

function save() {
    var json = JSON.stringify(uploads);
    fs.writeFileSync('uploads.db', json);
}

process.on('SIGINT', function () {
    save();
    process.exit(0);
}).on('unexpectedException', function () {
    save();
    process.exit(0);
}).on('exit', function () {
    save();
});

var urandom = fs.openSync('/dev/urandom', 'r'),
    urandbuff = new Buffer(32);

function uuid(buff) {
    fs.readSync(urandom, buff, 0, buff.length, 0);
    return buff.toString('base64').replace(/[^a-zA-Z0-9+]/g, '-');
}

http.createServer(function (req, res) {
    var contentType = req.headers['content-type'], pathname;

    if (req.method == 'GET') {
        pathname = req.url == '/' ? 'index.html' : req.url;

        fs.readFile(path.join(__dirname, pathname), function (e, file) {
            if (e) {
                res.writeHead(404);
                res.end();
            } else {
                res.writeHead(200);

                if (req.url == '/') {
                    // Create a unique upload ID, to link the filename to the text
                    res.end(renderTemplate(file.toString(), {'upload-id': uuid(urandbuff)}));
                } else {
                    res.end(file);
                }
            }
        });
    } else if (req.method == 'POST' && contentType.indexOf('multipart/form-data') !== -1) {
        handleUpload(req, res);
    } else if (req.method === 'PUT') {
        handleSave(req, res);
    }
}).listen(port);

function renderTemplate(str, data) {
    return str.replace(/\{\{([a-z0-9-]+)\}\}/g, function (_, m) {
        return data[m];
    });
}

function handleSave(req, res) {
    var data = "";

    var uploadId = req.url.slice(1);

    if (uploads[uploadId]) {
        req.on('data', function (c) { data += c });
        req.on('end', function () {
            uploads[uploadId].text = data;
            res.writeHead(200);
            res.end();
        });
    } else {
        res.writeHead(400);
        res.end();
    }
}

// Our general strategy is to *stream* the file upload
// to disk, buffering it per-chunk. This eases memory
// requirements when uploading large files, and opens
// up the possibility to pause/resume uploads if we
// wanted.
//
// The difficulty arises from Node's very limited Buffer
// object: there is no built-in way to compare buffers,
// or to run regular expressions on them, and converting
// back and forth to UTF-8 strings is problematic.
// 
// Given that we want our uploader to function well with
// binary content, we try to stick with buffers as much
// as possible, seldomly converting to strings.
//
function handleUpload(req, res) {
    var contentType = req.headers['content-type'];

    // The data-fragment boundary string
    var boundary = new Buffer('--' + contentType.match(/boundary=([^;]+)/)[1]);

    var length     = req.headers['content-length'],
        remaining  = length,
        filestream = null;

    var headers, headerinfo;                   // Headers of current data-fragment
    var saved = new events.EventEmitter;       // Triggered when the file is flushed to disk
    var uploadId = req.url.slice(1);
    var start = Date.now();

    uploads[uploadId] = {};

    req.on('data', function (chunk) {
        var buff   = new Buffer(chunk.length), // Content buffer
            b      = 0,                        // Write position in buff
            start  = 0;                        // Start of content, after first boundary

        // First chunk only. We treat it differently, because there is no '\r\n' before
        // the boundary, and we know it starts with a boundary.
        if (remaining == length) {
            if (Buffer.includes(chunk, boundary, 0)) {
                start     += boundary.length + 2;
                headerinfo = findHeaders(chunk, start);
                start     += headerinfo.length;
                headers    = headerinfo.headers;

                if (headers.filename)
                    filestream = startUpload(uploadId, headers);
            } else { // Abort.
                res.writeHead(400);
                res.end();
                return;
            }
        }

        // Remainder of first chunk, or start of any other complete chunk.
        // Skip any non-file content byte and copy content bytes to `buff`.
        //
        // If `filestream` is set, and we encounter a boundary, it means we have
        // reached the end of the file upload part, so we can close the stream
        // and set filestream to null.
        //
        // We might also encounter an end-of-transmission marker (a boundary followed
        // by '--'), in which case we aren't expecting anymore data or chunks.
        //
        for (var i = start; i < chunk.length; i++) {
            if (chunk[i] === CR && chunk[i + 1] === LF && // '\r\n'
                (i <= chunk.length - boundary.length - 2) &&
                (Buffer.includes(chunk, boundary, i + 2))) {

                // We've reached a boundary. This signals the end of the current data-fragment. //

                if (filestream) { // End of file upload contents
                    filestream.write(new Buffer(buff.slice(0, b)));
                    filestream.destroySoon(function () {
                        saved.emit('success');
                        saved.success = true;
                    });
                    filestream = null;
                } else { // End of non-file data, process accordingly
                    processFormData(uploadId, headers.name, buff.slice(0, b).toString());
                }

                b  = 0;                                       // Set content-buffer index back to zero
                i += 2 + boundary.length;                     // Skip boundary with '\r\n' prefix

                if (chunk[i] === 45 && chunk[i + 1] === 45) { // '--' (EOF marker)
                    i += 4;                                   // Skip '--\r\n'
                    break;
                } else {
                    headerinfo = findHeaders(chunk, i);
                    i         += headerinfo.length;
                    headers    = headerinfo.headers;

                    if (headers.filename) // Start of file upload contents
                        filestream = startUpload(uploadId, headers);
                }
            }
            buff[b ++] = chunk[i];
        }
        // Because the file content upload often spans multiple chunks,
        // we write what we've got in buff to disk, as `buff` only holds
        // a single chunk at a time.
        if (filestream)
            filestream.write(new Buffer(buff.slice(0, b)));

        remaining -= chunk.length;
    }).on('end', function () {
        if (remaining === 0) {
            if (saved.success)
                respond();
            else
                saved.once('success', respond);

            function respond() {
                var rate = Math.round((length / 1024) / ((Date.now() - start) / 1000));
                console.log('upload', uploadId, 'was successful (' + rate + ' KB/s)');

                child.exec('shasum ' + './uploads/' + uploadId).stdout.on('data', function (sha) {
                    sha = sha.split(' ')[0];
                    res.writeHead(201);

                    if (req.headers['accept'] === 'text/plain') {
                        res.end(sha);
                    } else {
                        fs.readFile('./success.html', function (e, file) {
                            res.end(file.toString().replace('{{checksum}}', sha));
                        });
                    }
                });
            }
        } else { // Something weird happened. Error.
            console.error("parse error on", uploadId);
            res.writeHead(500);
            res.end();
        }
    });
}

function processFormData(uploadId, name, data) {
    switch (name) {
        case 'text':
            uploads[uploadId].text = data;
            break;
    }
}

function startUpload(id, headers) {
    var stream = fs.createWriteStream(path.join('./uploads', id));
    uploads[id].filename = headers.filename;
    return stream;
}

function parseHeaders(str) {
    var match = str.match(/Content-Disposition: ([a-z-]+); ([^\r\n]+)/),
        pairs, obj = {};

    if (match) {
        obj.content = match[1];
        pairs = match[2].split(/; /);
        pairs.forEach(function (p) {
            p = p.match(/([a-z-]+)="([^"]+)"/);
            obj[p[1]] = p[2];
        });
        return obj;
    }
}

// Find and return the headers after a boundary
function findHeaders(chunk, i) {
    // Search for '\r\n\r\n', this will tell us where
    // the headers end.
    for (var j = i; j < chunk.length; j++) {
        if (chunk[j]     === CR && chunk[j + 1] === LF &&
            chunk[j + 2] === CR && chunk[j + 3] === LF) {
            break;
        }
    }
    return {
        length: j + 4 - i, // Account for '\r\n\r\n'
        headers: parseHeaders(chunk.slice(i, j).toString())
    };
}

//
// Find `b` inside `a`, at offset `off`
//
Buffer.includes = function (a, b, off) {
    if (a.length >= b.length) {
        for (var i = 0; i < b.length; i++) {
            if (a[off + i] !== b[i])
                return false;
        }
        return true;
    }
    return false;
};

