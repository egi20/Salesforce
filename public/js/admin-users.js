/* eslint-env browser */
/**
 * /admin/users: the select-all boxes and the live count on "Delete Selected (N)" (ported from
 * SAP Hub).
 *
 * Nothing here decides anything. The server re-checks every id and every rule, and the bulk
 * erase is confirmed by typing `ERASE <n>`, which the server compares with the ids it
 * received — so a selection that changed between reading and pressing is refused rather than
 * acted on, and the page works with this file never loaded.
 */
(function () {
  'use strict';

  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-select]'));
  var allBoxes = Array.prototype.slice.call(document.querySelectorAll('[data-select-all]'));
  var openButton = document.querySelector('[data-bulk-open]');

  function refresh() {
    var n = rows.filter(function (r) { return r.checked; }).length;
    Array.prototype.forEach.call(document.querySelectorAll('[data-bulk-count]'), function (el) {
      el.textContent = String(n);
    });
    if (openButton) openButton.disabled = n === 0;
    allBoxes.forEach(function (box) {
      box.checked = rows.length > 0 && n === rows.length;
      box.indeterminate = n > 0 && n < rows.length;
    });
  }

  allBoxes.forEach(function (box) {
    box.addEventListener('change', function () {
      rows.forEach(function (r) { r.checked = box.checked; });
      refresh();
    });
  });
  rows.forEach(function (r) { r.addEventListener('change', refresh); });
  refresh();
}());
