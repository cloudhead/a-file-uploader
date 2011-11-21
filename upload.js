
var form = document.getElementById('uploader'),
    text = document.getElementById('text'),
    file = document.getElementById('file'),
    save = document.getElementById('save'),
    md5  = document.getElementById('md5'),
    progress = document.getElementById('progress');

// The user selects a file
file.onchange = function () {
    var req, formdata;

    if (this.value) {
        if (FormData) {
            formdata = new FormData(form);
            req = new XHR('POST', form.action, {});
            req.xhr.upload.onprogress = function (e) {
                if (e.lengthComputable) {
                    var percent = Math.round(e.loaded / e.total * 100) + '%';
                    progress.style.width = percent;
                    progress.innerHTML = percent;
                }
            };
            req.send(formdata, function (err, res) {
                if (err) { // Error
                    progress.style.backgroundColor = 'red';
                    progress.innerHTML = 'Error';
                } else { // Success
                    progress.style.backgroundColor = 'green';
                    progress.innerHTML = 'Success (100%)';
                    md5.innerHTML = res;
                }
            });
        }
    }
};

save.onclick = function () {
    if (FormData) {
        if (file.value) {
            var uploadId = form.getAttribute('data-upload');
            var req = new XHR('PUT', '/' + uploadId);
            req.send(text.value, function (e) {
                if (e) { // Error
                } else { // Success
                }
            });
        } else {
            alert("Please select a file");
        }
        return false;
    }
};

var XHR = function XHR(method, url, headers) {
    this.method = method.toLowerCase();
    this.url    = url;

    if (window.XMLHttpRequest) {
        this.xhr = new(XMLHttpRequest);
    } else {
        this.xhr = new(ActiveXObject)("MSXML2.XMLHTTP.3.0");
    }

    this.headers = {
        'X-Requested-With': 'XMLHttpRequest'
    };
    for (var k in headers) { this.headers[k] = headers[k] }
};

XHR.prototype.send = function (data, callback) {
    this.xhr.open(this.method, this.url, true);
    this.xhr.onreadystatechange = function () {
        if (this.readyState != 4) { return }

        var body = this.responseText ? this.responseText : '';

        if (this.status >= 200 && this.status < 300) { // Success
            callback(null, body);
        } else {                                       // Error
            callback({ status: this.status, body: body, xhr: this });
        }
    };

    // Set user headers
    for (k in this.headers) {
        this.xhr.setRequestHeader(k, this.headers[k]);
    }

    // Dispatch request
    this.xhr.send(this.method === 'get' ? null : data);

    return this;
};


