/* global window, document */
/* Main-page T123 bootstrap. Replace the previous friendship period script. */
(function (window, document) {
  'use strict';
  function boot() {
    if (window.phSubscriptions) return;
    if (!window.PadlHubZeroBlock || window.PadlHubZeroBlock.version !== '2.0.1') {
      throw new Error('Подключите актуальный PadlHub Zero Block перед вставкой главной');
    }
    var period = 'month';
    var restorers = [];
    function rememberAttribute(element, name) {
      var before = element.getAttribute(name);
      restorers.push(function () { if (before === null) element.removeAttribute(name); else element.setAttribute(name, before); });
    }
    var roles = ['price', 'remaining', 'total', 'status', 'buy', 'counter', 'card'];
    var bindings = roles.map(function (role) {
      return {
        role: role,
        elements: Array.from(document.querySelectorAll(
          '.ph-' + role + '-friendship,.ph-' + role + '-friendship-year,' +
          '[data-ph-' + role + '="friendship"],[data-ph-' + role + '="friendship-year"]'
        ))
      };
    });
    function atom(element) { return element.matches('.tn-atom') ? element : element.querySelector('.tn-atom') || element; }
    bindings.forEach(function (binding) {
      binding.elements.forEach(function (element) { rememberAttribute(element, 'class'); rememberAttribute(element, 'data-ph-' + binding.role); });
    });
    document.querySelectorAll('.ph-period-month,.ph-period-year').forEach(function (element) {
      rememberAttribute(element, 'class'); rememberAttribute(atom(element), 'aria-pressed');
      rememberAttribute(atom(element), 'role'); rememberAttribute(atom(element), 'tabindex');
      atom(element).setAttribute('role', 'button'); atom(element).setAttribute('tabindex', '0');
    });
    document.querySelectorAll('.ph-period-label').forEach(function (element) {
      var target = atom(element), before = target.innerHTML;
      restorers.push(function () { target.innerHTML = before; });
    });
    document.querySelectorAll('.count-box').forEach(function (element) { rememberAttribute(element, 'class'); });
    function renderPeriod() {
      var annual = period === 'year';
      var key = annual ? 'friendship-year' : 'friendship';
      bindings.forEach(function (binding) {
        binding.elements.forEach(function (element) {
          element.classList.remove('ph-' + binding.role + '-friendship', 'ph-' + binding.role + '-friendship-year');
          element.classList.add('ph-' + binding.role + '-' + key);
          element.setAttribute('data-ph-' + binding.role, key);
        });
      });
      document.querySelectorAll('.ph-period-month,.ph-period-year').forEach(function (element) {
        var selected = element.classList.contains(annual ? 'ph-period-year' : 'ph-period-month');
        element.classList.toggle('active', selected);
        atom(element).setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      document.querySelectorAll('.ph-period-label').forEach(function (element) { atom(element).textContent = annual ? '/ год' : '/ мес'; });
      // Existing main-page artwork reserves the count-box for the monthly offer.
      document.querySelectorAll('.count-box').forEach(function (element) { element.classList.toggle('is-hidden', annual); });
      window.phSubscriptionsActiveKey = key;
      if (window.phSubscriptions) window.phSubscriptions.refreshBindings();
    }
    renderPeriod();
    window.phSubscriptions = window.PadlHubZeroBlock.init({
      offerKeys: ['friendship', 'friendship-year', 'ra', 'academy', 'energy5'],
      channel: 'prod',
      refreshMs: 30000
    });
    function onPeriodClick(event) {
      if (!(event.target instanceof window.Element)) return;
      var tab = event.target.closest('.ph-period-month,.ph-period-year');
      if (!tab) return;
      event.preventDefault();
      period = tab.classList.contains('ph-period-year') ? 'year' : 'month';
      renderPeriod();
    }
    function onPeriodKey(event) {
      if ((event.key !== 'Enter' && event.key !== ' ') || !(event.target instanceof window.Element)) return;
      var tab = event.target.closest('.ph-period-month,.ph-period-year');
      if (!tab) return;
      var control = atom(tab);
      if (control.tagName === 'BUTTON' || (control.tagName === 'A' && event.key === 'Enter')) return;
      onPeriodClick(event);
    }
    document.addEventListener('click', onPeriodClick);
    document.addEventListener('keydown', onPeriodKey);
    var destroy = window.phSubscriptions.destroy;
    window.phSubscriptions.destroy = function () {
      if (!destroy()) return false;
      document.removeEventListener('click', onPeriodClick);
      document.removeEventListener('keydown', onPeriodKey);
      restorers.reverse().forEach(function (restore) { restore(); });
      delete window.phSubscriptionsActiveKey;
      window.phSubscriptions = null;
      return true;
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(window, document);
