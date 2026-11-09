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
    var result = document.getElementById('tax-result');
    var unavailable = document.getElementById('tax-unavailable');
    var calc = window.TaxCalculator;
    if (!form || !result || !unavailable || !calc) return;

    // No #tax-payroll means the program's rates are not published: the form still validates,
    // and a valid submit says so rather than showing a number.
    var config = null;
    var data = document.getElementById('tax-payroll');
    if (data) {
      try {
        config = JSON.parse(data.textContent);
      } catch (e) {
        config = null;
      }
    }
    var currency = config ? config.currency : 'EUR';
    var format = new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency, maximumFractionDigits: 0 });
    var exact = new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency });
    var grossInput = document.getElementById('tax-gross');
    var netInput = document.getElementById('tax-net');

    function out(key) {
      return result.querySelector('[data-out="' + key + '"]');
    }

    function signed(minor) {
      var text = format.format(Math.abs(minor) / 100);
      return (minor > 0 ? '+' : minor < 0 ? '−' : '') + text;
    }

    function setError(input, message) {
      var feedback = document.getElementById(input.id + '-error');
      feedback.textContent = message || '';
      input.classList.toggle('is-invalid', Boolean(message));
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }

    function fill(list, lines) {
      while (list.firstChild) list.removeChild(list.firstChild);
      // A €0.00 line (a 0 % band, an unused contribution) is noise in the breakdown; it is
      // still part of the calculation, it just withholds nothing.
      lines.filter(function (line) { return line.amountMinor !== 0; }).forEach(function (line) {
        var li = document.createElement('li');
        var label = document.createElement('span');
        var amount = document.createElement('span');
        label.textContent = line.label;
        amount.textContent = exact.format(line.amountMinor / 100);
        li.appendChild(label);
        li.appendChild(amount);
        list.appendChild(li);
      });
    }

    [grossInput, netInput].forEach(function (input) {
      input.addEventListener('input', function () { setError(input, ''); });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      result.hidden = true;
      unavailable.hidden = true;

      var gross = calc.parseAmount(grossInput.value);
      var net = calc.parseAmount(netInput.value);
      var grossError = !(gross > 0) ? 'Enter your gross monthly salary, for example 8000.' : '';
      var netError = !(net > 0) ? 'Enter what you take home each month, for example 5200.' : '';
      if (!grossError && !netError && net >= gross) netError = 'Your take-home must be lower than your gross salary.';
      setError(grossInput, grossError);
      setError(netInput, netError);
      if (grossError || netError) {
        (grossError ? grossInput : netInput).focus();
        return;
      }

      var r = config ? calc.calculate(config.payroll, { grossMinor: gross, currentNetMinor: net }) : null;
      if (!r) {
        unavailable.hidden = false;
        return;
      }

      out('net').textContent = format.format(r.newNetMinor / 100);
      var month = out('month');
      var year = out('year');
      month.textContent = signed(r.differenceMonthlyMinor);
      year.textContent = signed(r.differenceYearlyMinor);
      [month, year].forEach(function (el) {
        el.classList.toggle('is-gain', r.differenceMonthlyMinor > 0);
        el.classList.toggle('is-loss', r.differenceMonthlyMinor < 0);
      });

      fill(out('lines'), r.lines);
      fill(out('ontop'), r.onTop);
      out('ontop-intro').hidden = !r.onTop.some(function (line) { return line.amountMinor !== 0; });

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
