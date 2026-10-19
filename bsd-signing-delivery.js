/* Mobile signing delivery.
   WhatsApp must not open by itself: iOS Chrome suspends a backgrounded tab and the
   PDF POST never leaves the device. Save first, confirm with the server, then let
   the client tap "שלח לברוך בוואטסאפ". A pending payload is kept in IndexedDB
   (and localStorage when it fits) and resent on return, reload, and with backoff. */
(function (global) {
  'use strict';

  var PDF_SCALE = 1.2;
  var PDF_JPEG_QUALITY = 0.66;
  var KEEPALIVE_MAX = 60 * 1024;
  var DB_NAME = 'bsd-signed-agreements';
  var DB_STORE = 'pending';
  var LS_PREFIX = 'bsdPendingAgreement:';
  var MAX_TIMER_ATTEMPTS = 6;
  var STUCK_MS = 8000;

  var state = {
    busy: false,
    booting: false,
    busySince: 0,
    confirmed: false,
    record: null,
    pdfDoc: null,
    pdfName: '',
    timer: null,
    generation: 0,
    abortController: null,
    installed: false
  };

  function $(id) { return document.getElementById(id); }

  function pageKey() {
    return global.BSD_SIGNING_PAGE || (state.record && state.record.pageKey) || 'agreement';
  }

  function setSubmitLocked(locked) {
    var nodes = document.querySelectorAll('#mainContent button.btn-submit');
    for (var i = 0; i < nodes.length; i++) nodes[i].disabled = locked;
  }

  function showProgress() {
    var fail = $('saveFailure');
    if (fail) fail.style.display = 'none';
    var el = $('saveProgress');
    if (el) {
      el.style.display = 'flex';
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }
    setSubmitLocked(true);
  }

  function showFailure() {
    var el = $('saveProgress');
    if (el) el.style.display = 'none';
    var fail = $('saveFailure');
    if (fail) {
      fail.style.display = 'block';
      try { fail.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }
    setSubmitLocked(false);
  }

  function showSuccess(name, waURL) {
    var el = $('saveProgress');
    if (el) el.style.display = 'none';
    var fail = $('saveFailure');
    if (fail) fail.style.display = 'none';
    var main = $('mainContent');
    if (main) main.style.display = 'none';
    var screen = $('successScreen');
    if (screen) screen.style.display = 'block';
    var suc = $('suc_name');
    if (suc) suc.textContent = name || '';
    var wa = $('waShareBtn');
    if (wa) {
      wa.href = waURL || '#';
      wa.style.display = 'flex';
    }
    try { if (screen) screen.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  }

  function backoffMs(attempt) {
    if (typeof global.BSD_SIGNING_BACKOFF_MS === 'number') return global.BSD_SIGNING_BACKOFF_MS;
    var steps = [1500, 4000, 9000, 18000, 35000, 60000];
    var base = steps[Math.min(Math.max(attempt, 1), steps.length) - 1];
    return base + Math.floor(Math.random() * 300);
  }

  function isRetryable(status) {
    if (status == null || status === 0) return true;
    if (status === 408 || status === 429) return true;
    return status >= 500;
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('no idb')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb')); };
    });
  }

  function idbPut(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('idb put')); };
      });
    });
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var r = tx.objectStore(DB_STORE).get(key);
        r.onsuccess = function () { db.close(); resolve(r.result || null); };
        r.onerror = function () { db.close(); reject(r.error || new Error('idb get')); };
      });
    });
  }

  function idbDel(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('idb del')); };
      });
    });
  }

  function writeMeta(record) {
    try {
      localStorage.setItem(LS_PREFIX + record.pageKey, JSON.stringify({
        pageKey: record.pageKey,
        endpoint: record.endpoint,
        headers: record.headers,
        requireEmailSent: !!record.requireEmailSent,
        signerName: record.signerName,
        waURL: record.waURL,
        filename: record.filename || '',
        attempts: record.attempts || 0,
        lastStatus: record.lastStatus || 0,
        autoRetry: record.autoRetry !== false,
        updatedAt: Date.now()
      }));
    } catch (e) {}
  }

  function persist(record) {
    state.record = record;
    writeMeta(record);
    return idbPut(record.pageKey, record).then(function () {
      try {
        var full = JSON.stringify(record);
        if (full.length <= 180000) localStorage.setItem(LS_PREFIX + record.pageKey + ':body', full);
        else localStorage.removeItem(LS_PREFIX + record.pageKey + ':body');
      } catch (e) {}
    }).catch(function (err) {
      console.warn('IndexedDB save failed', err);
      try {
        localStorage.setItem(LS_PREFIX + record.pageKey + ':body', JSON.stringify(record));
      } catch (e) {
        console.warn('localStorage save failed', e);
      }
    });
  }

  function clearPersisted(key) {
    try { localStorage.removeItem(LS_PREFIX + key); } catch (e) {}
    try { localStorage.removeItem(LS_PREFIX + key + ':body'); } catch (e) {}
    return idbDel(key).catch(function () {});
  }

  function loadPersisted(key) {
    if (state.record && state.record.pageKey === key && state.record.body) {
      return Promise.resolve(state.record);
    }
    return idbGet(key).catch(function () { return null; }).then(function (rec) {
      if (rec && rec.body) return rec;
      try {
        var raw = localStorage.getItem(LS_PREFIX + key + ':body');
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && parsed.body) return parsed;
        }
      } catch (e) {}
      return null;
    });
  }

  function postRecord(record) {
    var bodyStr = JSON.stringify(record.body);
    var useKeepalive = bodyStr.length <= KEEPALIVE_MAX;
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    state.abortController = controller;
    state.busySince = Date.now();
    var opts = {
      method: 'POST',
      headers: record.headers,
      body: bodyStr,
      keepalive: useKeepalive
    };
    if (controller) opts.signal = controller.signal;
    return fetch(record.endpoint, opts).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (result) {
        if (!result || typeof result !== 'object') result = {};
        if (record.requireEmailSent) {
          if (!response.ok || !result.ok) {
            var err = new Error(result.warning || result.error || 'שגיאה בהשלמת ההסכם');
            err.status = response.status || 0;
            throw err;
          }
          if (!result.email_sent) {
            var errMail = new Error(result.warning || 'ההסכם נשמר אך שליחת המייל לא אושרה');
            errMail.status = response.status || 0;
            errMail.emailNotSent = true;
            throw errMail;
          }
        } else if (!response.ok || result.success === false || result.success === 'false') {
          var errHttp = new Error(result.message || result.error || 'שגיאה בהשלמת ההסכם');
          errHttp.status = response.status || 0;
          throw errHttp;
        }
        return result;
      });
    }).catch(function (err) {
      if (!err || typeof err !== 'object') err = new Error(String(err));
      if (typeof err.status !== 'number') err.status = 0;
      throw err;
    });
  }

  function scheduleRetry(ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () { resumePending(); }, ms);
  }

  function deliver(record) {
    if (state.confirmed) return Promise.resolve();
    var gen = ++state.generation;
    state.busy = true;
    state.busySince = Date.now();
    state.record = record;
    showProgress();
    return postRecord(record).then(function () {
      if (gen !== state.generation) return;
      state.confirmed = true;
      state.busy = false;
      clearTimeout(state.timer);
      return clearPersisted(record.pageKey).then(function () {
        if (gen !== state.generation) return;
        showSuccess(record.signerName, record.waURL);
      });
    }).catch(function (err) {
      if (gen !== state.generation) return;
      console.error('שגיאה בהשלמת ההסכם:', err);
      var status = err && typeof err.status === 'number' ? err.status : 0;
      record.attempts = (record.attempts || 0) + 1;
      record.lastStatus = status;
      record.autoRetry = isRetryable(status) || !!(err && err.emailNotSent);
      return persist(record).then(function () {
        if (gen !== state.generation || state.confirmed) return;
        state.busy = false;
        showFailure();
        if (record.autoRetry && record.attempts < MAX_TIMER_ATTEMPTS) {
          scheduleRetry(backoffMs(record.attempts));
        }
      });
    });
  }

  function resumePending() {
    if (state.confirmed || state.busy || state.booting) return Promise.resolve();
    if (document.visibilityState === 'hidden') return Promise.resolve();
    state.booting = true;
    var key = pageKey();
    return loadPersisted(key).then(function (record) {
      state.booting = false;
      if (!record || !record.body || state.busy || state.confirmed) return;
      state.record = record;
      if (record.autoRetry === false) {
        showFailure();
        return;
      }
      return deliver(record);
    }).catch(function (err) {
      state.booting = false;
      console.error(err);
    });
  }

  function invalidateStuck() {
    if (!state.busy || !state.busySince) return;
    if (Date.now() - state.busySince < STUCK_MS) return;
    state.generation += 1;
    try { if (state.abortController) state.abortController.abort(); } catch (e) {}
    state.busy = false;
  }

  function onVisible() {
    if (document.visibilityState === 'hidden') return;
    if (state.confirmed) return;
    invalidateStuck();
    clearTimeout(state.timer);
    resumePending();
  }

  function onOnline() {
    if (state.busy || state.confirmed) return;
    if (document.visibilityState === 'hidden') return;
    clearTimeout(state.timer);
    resumePending();
  }

  function begin(job) {
    if (state.busy) return Promise.resolve();
    clearTimeout(state.timer);
    state.booting = false;
    state.confirmed = false;
    state.busy = true;
    state.busySince = Date.now();
    global.BSD_SIGNING_PAGE = job.pageKey;
    showProgress();
    return Promise.resolve()
      .then(function () { return job.buildBody(); })
      .then(function (built) {
        if (!built || !built.body) throw new Error('empty agreement payload');
        if (built.pdfDoc) {
          state.pdfDoc = built.pdfDoc;
          state.pdfName = built.filename || '';
        }
        var record = {
          pageKey: job.pageKey,
          endpoint: job.endpoint,
          headers: job.headers,
          requireEmailSent: !!job.requireEmailSent,
          signerName: job.signerName,
          waURL: job.waURL,
          filename: built.filename || job.filename || '',
          body: built.body,
          attempts: 0,
          lastStatus: 0,
          autoRetry: true
        };
        return persist(record).then(function () { return record; });
      })
      .then(function (record) {
        state.busy = false;
        return deliver(record);
      })
      .catch(function (err) {
        state.busy = false;
        console.error('שגיאה בהשלמת ההסכם:', err);
        showFailure();
      });
  }

  function retry() {
    if (state.confirmed) return;
    clearTimeout(state.timer);
    invalidateStuck();
    if (state.busy) return;
    var start = function (record) {
      record.autoRetry = true;
      record.lastStatus = 0;
      state.record = record;
      state.confirmed = false;
      deliver(record);
    };
    if (state.record && state.record.body) {
      start(state.record);
      return;
    }
    loadPersisted(pageKey()).then(function (record) {
      if (record && record.body) {
        start(record);
        return;
      }
      var btn = document.querySelector('#mainContent .btn-submit');
      if (btn) btn.disabled = false;
      if (typeof global.submitForm === 'function') global.submitForm();
    });
  }

  function downloadPdf() {
    var btn = $('failPdfBtn');
    var original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ מייצר PDF...'; }
    var done = function () {
      if (btn) { btn.disabled = false; btn.textContent = original || 'הורד PDF של ההסכם'; }
    };
    try {
      if (state.pdfDoc && typeof state.pdfDoc.save === 'function') {
        state.pdfDoc.save(state.pdfName || state.filename || 'agreement.pdf');
        done();
        return;
      }
    } catch (e) {
      console.error(e);
    }
    loadPersisted(pageKey()).then(function (record) {
      var dataUri = record && record.body && record.body.pdf_base64;
      var name = (record && (record.filename || record.body.filename)) || 'agreement.pdf';
      if (dataUri && typeof dataUri === 'string' && dataUri.indexOf('data:') === 0) {
        var a = document.createElement('a');
        a.href = dataUri;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        done();
        return;
      }
      if (typeof global.printContract === 'function') {
        try {
          var ret = global.printContract();
          if (ret && typeof ret.then === 'function') ret.then(done, done);
          else done();
        } catch (err) {
          console.error(err);
          done();
        }
        return;
      }
      done();
    }).catch(function (err) {
      console.error(err);
      done();
    });
  }

  function rememberPdf(pdf, filename) {
    state.pdfDoc = pdf;
    state.pdfName = filename || '';
  }

  function install() {
    if (state.installed) return;
    state.installed = true;
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('online', onOnline);
    var kick = function () { resumePending(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kick);
    else kick();
  }

  global.BsdSigningDelivery = {
    PDF_SCALE: PDF_SCALE,
    PDF_JPEG_QUALITY: PDF_JPEG_QUALITY,
    KEEPALIVE_MAX: KEEPALIVE_MAX,
    begin: begin,
    retry: retry,
    downloadPdf: downloadPdf,
    rememberPdf: rememberPdf,
    install: install
  };

  install();
})(window);
