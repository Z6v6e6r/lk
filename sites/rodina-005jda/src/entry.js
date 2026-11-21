/* global CSS, window, matchMedia */
import { createBookingApp } from './app.js';
import { finishOAuthRedirect } from './viva-payment.js';

export async function mountSite(siteRoot, panelStyles) {
const floatingBooking = siteRoot.querySelector('#floatingBooking');
const hasScrollAnimation = CSS.supports('animation-timeline', 'scroll(root block)') && CSS.supports('animation-range', '0px 38svh');
if (!hasScrollAnimation) {
  const hero = siteRoot.querySelector('.landing-hero');
  let revealDistance;

  function updateBookingReveal() {
    const progress = Math.min(1, Math.max(0, window.scrollY / revealDistance));
    floatingBooking.style.setProperty('--booking-reveal', progress);
    floatingBooking.style.setProperty('--booking-visibility', progress > 0 ? 'visible' : 'hidden');
  }

  function measureBookingReveal() {
    revealDistance = Math.max(1, hero.clientHeight * 0.38);
    updateBookingReveal();
  }

  measureBookingReveal();
  window.addEventListener('scroll', updateBookingReveal, { passive: true });
  window.addEventListener('resize', measureBookingReveal);
  window.addEventListener('pageshow', measureBookingReveal);
}

// Complete the one-time OAuth callback before either responsive app reads Viva tokens.
const oauthResult = await finishOAuthRedirect();

// Mobile opens the primary quick-match flow; desktop columns remain independent.
const mobileExperience = siteRoot.querySelector('#mobileExperience');
createBookingApp(mobileExperience, null, oauthResult);

const desktop = matchMedia('(min-width: 1024px)');
let desktopReady = false;
function mountDesktop() {
  if (!desktop.matches || desktopReady) return;
  desktopReady = true;
  for (const [selector, mode] of [['#desktopRentApp', 'rent'], ['#desktopEventsApp', 'events']]) {
    const host = siteRoot.querySelector(selector);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${panelStyles}</style>
      <div class="pane-toolbar"><nav id="homeNav" aria-label="Управление разделом"><button class="pane-reset" id="homeButton" type="button">↶ К началу раздела</button></nav><button class="help-button" id="helpButton" type="button" aria-label="${mode === 'events' ? 'Помощь с организацией мероприятия' : 'Помощь по бронированию'}">?</button></div>
      <div class="booking-card" aria-live="polite">
        <div class="step-line" id="stepLine"><span id="stepLabel"></span><div><i id="progressBar"></i></div></div>
        <div id="bookingContent"></div>
      </div>
      <div class="toast" id="toast" role="status"></div>
      <dialog id="quotePopup" class="quote-popup" aria-labelledby="quoteTitle"></dialog>
      <dialog id="inquiryPopup" class="inquiry-popup" aria-labelledby="inquiryTitle"></dialog>
      <dialog id="photoPopup" class="photo-popup" aria-labelledby="photoTitle"></dialog>`;
    const booking = createBookingApp(root, mode, mode === 'rent' ? oauthResult : null);
    if (mode === 'rent') {
      siteRoot.querySelector('#arenaListLink').addEventListener('click', event => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        booking.reset();
        host.focus({ preventScroll: true });
      });
    }
  }
}
mountDesktop();
desktop.addEventListener('change', mountDesktop);

function focusBooking() {
  const booking = desktop.matches
    ? siteRoot.querySelector('#desktopRentApp')
    : mobileExperience.querySelector('.booking-card');
  booking.focus({ preventScroll: true });
  booking.scrollIntoView({ block: 'start' });
}

if (oauthResult?.arenaId) focusBooking();

function isPlainClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

floatingBooking.addEventListener('click', event => {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  if (!desktop.matches) {
    mobileExperience.querySelector('[data-scenario="rent"][aria-pressed="false"]')?.click();
  }
  focusBooking();
});

}
