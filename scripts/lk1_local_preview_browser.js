/* global window, location, XMLHttpRequest, document, Element */
(function () {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  const blocked = () => nativeFetch('/__lk1_local/blocked', { method: 'GET', credentials: 'omit', cache: 'no-store' });
  window.fetch = function (input, init) {
    const request = new Request(input instanceof Request ? input : new URL(String(input), location.href), init);
    if (new URL(request.url).origin !== location.origin || !['GET', 'HEAD'].includes(request.method)) return blocked();
    return nativeFetch(request);
  };
  navigator.sendBeacon = () => false;
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (new URL(String(url), location.href).origin !== location.origin || !['GET', 'HEAD'].includes(String(method).toUpperCase())) {
      throw new Error('LK1_LOCAL_EXTERNAL_ACCESS_DISABLED');
    }
    return nativeOpen.call(this, method, url, ...rest);
  };
  window.open = () => null;
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link && new URL(link.href, location.href).origin !== location.origin) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
})();
