/* eslint-env browser */
(function () {
  'use strict';

  /**
   * Every fetch from this page carries the CSRF token from the meta tag.
   * Server-rendered forms carry it as a hidden field instead.
   */
  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = tokenMeta ? tokenMeta.getAttribute('content') : '';

  function apiFetch(url, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'X-CSRF-Token': csrfToken }, opts.headers || {});
    opts.credentials = 'same-origin';
    return fetch(url, opts);
  }

  /**
   * Unread notification badge.
   *
   * Fails silently: a 401 here simply means the session ended, and the page should not
   * grow an error banner because a decorative counter could not load.
   */
  function fillBadge(elementId, url) {
    var badge = document.getElementById(elementId);
    if (!badge) return;
    apiFetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.count > 0) {
          badge.textContent = data.count > 99 ? '99+' : String(data.count);
          badge.classList.remove('d-none');
        }
      })
      .catch(function () { /* decorative only */ });
  }

  fillBadge('notifCount', '/notifications/unread-count');
  fillBadge('messageCount', '/messages/unread-count');

  /**
   * Guard against a double-submitted form producing two writes.
   * The button is disabled after submit, but the form still submits normally, so this
   * degrades to no-op without JavaScript.
   */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.noGuard === 'true') return;
    var button = form.querySelector('button[type="submit"]');
    if (!button || button.disabled) return;
    window.setTimeout(function () {
      button.disabled = true;
      button.dataset.originalText = button.innerHTML;
      button.innerHTML = 'Working…';
    }, 0);
  });

  /**
   * Availability date is only meaningful for a profile that is actually available.
   * Purely a convenience: the server does not depend on it.
   */
  var availability = document.getElementById('availability');
  var availableFrom = document.getElementById('available_from');
  if (availability && availableFrom) {
    var sync = function () {
      availableFrom.disabled = availability.value === 'not_available';
    };
    availability.addEventListener('change', sync);
    sync();
  }

  /** Ending an experience and marking it current are mutually exclusive. */
  var isCurrent = document.getElementById('is_current');
  if (isCurrent) {
    var endedOn = document.querySelector('input[name="ended_on"]');
    var syncCurrent = function () {
      if (endedOn) endedOn.disabled = isCurrent.checked;
    };
    isCurrent.addEventListener('change', syncCurrent);
    syncCurrent();
  }
})();
