/*
 * /tax-optimization: the calculator's wiring and the stories slider.
 *
 * The arithmetic is in tax-calculator.js and nowhere else; this file reads the inputs, asks
 * it, and writes the answer with textContent. Nothing is sent anywhere — there is no fetch
 * here, and a test asserts it stays that way. Without scripting the page still reads: the
 * calculator says it needs JavaScript and the stories row scrolls by itself.
 */
(function () {
  'use strict';

  function setupCalculator() {
    var form = document.getElementById('tax-calc');
    var data = document.getElementById('tax-payroll');
    var result = document.getElementById('tax-result');
    if (!form || !data || !result || !window.TaxCalculator) return;

    var config;
    try {
      config = JSON.parse(data.textContent);
    } catch (e) {
      return;
    }
    var calc = window.TaxCalculator;
    var error = document.getElementById('tax-calc-error');
    var format = new Intl.NumberFormat('en-GB', { style: 'currency', currency: config.currency, maximumFractionDigits: 0 });
    var exact = new Intl.NumberFormat('en-GB', { style: 'currency', currency: config.currency });

    function out(key) {
      return result.querySelector('[data-out="' + key + '"]');
    }

    function signed(minor) {
      var text = format.format(Math.abs(minor) / 100);
      return (minor > 0 ? '+' : minor < 0 ? '−' : '') + text;
    }

    function fail(message) {
      error.textContent = message;
      error.hidden = false;
      result.hidden = true;
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var gross = calc.parseAmount(document.getElementById('tax-gross').value);
      var net = calc.parseAmount(document.getElementById('tax-net').value);
      if (!(gross > 0)) return fail('Enter your gross monthly pay, for example 6,000.');
      if (!(net >= 0)) return fail('Enter what you take home each month, for example 3,600.');
      if (net > gross) return fail('Your take-home cannot be more than your gross.');

      var r = calc.calculate(config.payroll, { grossMinor: gross, currentNetMinor: net });
      if (!r) return fail('We could not calculate that. Please check the two amounts.');
      error.hidden = true;

      out('net').textContent = format.format(r.newNetMinor / 100);
      var month = out('month');
      var year = out('year');
      month.textContent = signed(r.differenceMonthlyMinor);
      year.textContent = signed(r.differenceYearlyMinor);
      [month, year].forEach(function (el) {
        el.classList.toggle('is-gain', r.differenceMonthlyMinor > 0);
        el.classList.toggle('is-loss', r.differenceMonthlyMinor < 0);
      });

      var list = out('lines');
      while (list.firstChild) list.removeChild(list.firstChild);
      r.lines.forEach(function (line) {
        var li = document.createElement('li');
        var label = document.createElement('span');
        var amount = document.createElement('span');
        label.textContent = line.label;
        amount.textContent = exact.format(line.amountMinor / 100);
        li.appendChild(label);
        li.appendChild(amount);
        list.appendChild(li);
      });

      var country = document.getElementById('tax-country').value;
      out('country').textContent = country ? ' in ' + country : '';
      result.hidden = false;
    });
  }

  function setupSlider() {
    var track = document.getElementById('tax-stories');
    if (!track) return;
    var nav = document.querySelector('.tax-slider-nav');
    if (nav) nav.removeAttribute('aria-hidden');
    document.querySelectorAll('[data-slide]').forEach(function (button) {
      button.addEventListener('click', function () {
        var card = track.querySelector('.tax-story-card');
        var step = card ? card.getBoundingClientRect().width + 16 : track.clientWidth;
        track.scrollBy({ left: Number(button.getAttribute('data-slide')) * step, behavior: 'smooth' });
      });
    });
  }

  function start() {
    setupCalculator();
    setupSlider();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
