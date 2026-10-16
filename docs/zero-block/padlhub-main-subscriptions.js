/* global window, document */
/* Main-page T123 bootstrap. Replace the previous friendship period script. */
(function (window, document) {
  'use strict';
  function boot() {
    if (window.phSubscriptions || window.PADLHUB_MAIN_CHECKOUT_DISABLED === true) return;
    // Missing/new Tilda block or another adapter must leave the real catalog links working.
    var root = document.getElementById('rec4807682401');
    if (!root || !window.PadlHubZeroBlock || window.PadlHubZeroBlock.version !== '2.1.0') return;
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
        elements: Array.from(root.querySelectorAll(
          '.ph-' + role + '-friendship,.ph-' + role + '-friendship-year,' +
          '[data-ph-' + role + '="friendship"],[data-ph-' + role + '="friendship-year"]'
        ))
      };
    });
    function atom(element) { return element.matches('.tn-atom') ? element : element.querySelector('.tn-atom') || element; }
    bindings.forEach(function (binding) {
      binding.elements.forEach(function (element) { rememberAttribute(element, 'class'); rememberAttribute(element, 'data-ph-' + binding.role); });
    });
    root.querySelectorAll('.ph-period-month,.ph-period-year').forEach(function (element) {
      rememberAttribute(element, 'class'); rememberAttribute(atom(element), 'aria-pressed');
      rememberAttribute(atom(element), 'role'); rememberAttribute(atom(element), 'tabindex');
      atom(element).setAttribute('role', 'button'); atom(element).setAttribute('tabindex', '0');
    });
    root.querySelectorAll('.ph-period-label').forEach(function (element) {
      var target = atom(element), before = target.innerHTML;
      restorers.push(function () { target.innerHTML = before; });
    });
    root.querySelectorAll('.count-box').forEach(function (element) { rememberAttribute(element, 'class'); });
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
      root.querySelectorAll('.ph-period-month,.ph-period-year').forEach(function (element) {
        var selected = element.classList.contains(annual ? 'ph-period-year' : 'ph-period-month');
        element.classList.toggle('active', selected);
        atom(element).setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      root.querySelectorAll('.ph-period-label').forEach(function (element) { atom(element).textContent = annual ? '/ год' : '/ мес'; });
      // Existing main-page artwork reserves the count-box for the monthly offer.
      root.querySelectorAll('.count-box').forEach(function (element) { element.classList.toggle('is-hidden', annual); });
      window.phSubscriptionsActiveKey = key;
      if (window.phSubscriptions) window.phSubscriptions.refreshBindings();
    }
    renderPeriod();
    function onIntent(event) {
      if (event.detail.key === 'friendship' || event.detail.key === 'friendship-year') {
        period = event.detail.key === 'friendship-year' ? 'year' : 'month'; renderPeriod();
      }
    }
    root.addEventListener('padlhub:checkout-intent', onIntent);
    window.phSubscriptions = window.PadlHubZeroBlock.init({
      root: root,
      offerKeys: ['friendship', 'friendship-year', 'ra', 'academy', 'energy5'],
      channel: 'prod',
      lazyCheckout: true,
      fallbackToCatalog: true,
      requireIsolation: true,
      observeVisibility: true,
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
    root.addEventListener('click', onPeriodClick);
    root.addEventListener('keydown', onPeriodKey);
    var destroy = window.phSubscriptions.destroy;
    window.phSubscriptions.destroy = function () {
      if (!destroy()) return false;
      root.removeEventListener('click', onPeriodClick);
      root.removeEventListener('keydown', onPeriodKey);
      root.removeEventListener('padlhub:checkout-intent', onIntent);
      restorers.reverse().forEach(function (restore) { restore(); });
      delete window.phSubscriptionsActiveKey;
      window.phSubscriptions = null;
      return true;
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(window, document);
