/* global document, window */
import { arenaData as arenaCatalog } from './tenant-config.js';
import * as Viva from "./viva-booking.js";
import * as Payment from "./viva-payment.js";
import { buildInquiry, managerLink, managerAppLink } from "./inquiries.js";
import { pickupGames, participationPaymentUrl } from "./pickup-games.js";
import { findMetroStations, nearestArenas, searchText } from "./metro-search.js";
const clockReady = Viva.syncClock().catch(() => {});
const scenarioPages = { rent: "booking", game: "pickup-games", events: "events" };

// Each desktop column owns its state, requests and dialog. Mobile uses the same
// shared flow in the document; desktop instances are isolated Shadow DOM roots.
export function createBookingApp(root = document, initialMode = null, oauthResult = null) {
const defaultMode = initialMode || "rent";
const defaultPage = scenarioPages[defaultMode];
let paymentController = null;
let oauthError = oauthResult?.error || null;
const arenaData = arenaCatalog;
let slotsController = null;
let quoteController = null;
let slotsRequest = 0;
let quoteRequest = 0;
const state = {
  page: defaultPage,
  mode: defaultMode,
  step: 1,
  arenas: arenaData?.arenas || [],
  viva: null,
  rawSlots: null,
  durationMinutes: 60,
  selectedInterval: null,
  quote: null,
  arena: null,
  date: null,
  slots: []
};
if (state.page === 'booking' && oauthResult?.arenaId) {
  const resumedArena = state.arenas.find(arena => arena.id === oauthResult.arenaId);
  if (resumedArena) {
    state.arena = resumedArena;
    state.date = Viva.moscowDay();
    state.durationMinutes = Math.max(resumedArena.viva.minMinutes, 60);
    state.step = 2;
    const selection = oauthResult.selection;
    if (selection && Viva.selectionValid(selection, selection.minutes, resumedArena.viva)) {
      state.date = Viva.moscowDay(Date.parse(selection.timeFrom));
      state.durationMinutes = selection.minutes;
      state.selectedInterval = selection;
    } else if (selection) {
      oauthError ||= "Выбранное время устарело. Выберите другой интервал.";
    }
  }
}

const telegram = window.Telegram?.WebApp;
telegram?.ready();
telegram?.expand();

const content = root.querySelector("#bookingContent");
const stepLabel = root.querySelector("#stepLabel");
const progressBar = root.querySelector("#progressBar");
const stepLine = root.querySelector("#stepLine");
const homeNav = root.querySelector("#homeNav");
const toast = root.querySelector("#toast");

function formatDate(date) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(date);
}

function dates() {
  const window = Viva.bookingWindow(state.viva || state.arena?.viva);
  return Array.from({ length: 15 }, (_, index) => Viva.addDays(window.min, index)).filter(day => day <= window.max);
}

function setStep(step) {
  cancelRequests();
  state.page = "booking";
  state.step = step;
  render();
}

function setPage(page) {
  cancelRequests();
  state.page = page;
  render();
  root.querySelector(".booking-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function goHome() {
  closeQuote(); closeInquiry(); closeLocationPhoto();
  state.selectedInterval = null;
  state.quote = null;
  state.arena = null;
  state.date = null;
  state.slots = [];
  state.mode = defaultMode;
  state.step = 1;
  setPage(defaultPage);
}

function updateProgress() {
  homeNav.hidden = state.page === "events" || (state.page === "booking" && state.step === 1) || state.page === "pickup-games";
  root.querySelectorAll('[data-scenario]').forEach(button => {
    const active = button.dataset.scenario === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (root.host) {
    root.host.dataset.page = state.page;
    root.host.dataset.step = String(state.step);
  }
  if (state.page === "events" || state.page === "pickup-games") {
    stepLine.hidden = true;
    return;
  }
  stepLine.hidden = false;
  const number = state.step;
  const total = 3;
  stepLabel.textContent = `${String(number).padStart(2, "0")} / 0${total}`;
  progressBar.style.width = `${number / total * 100}%`;
}

function switchScenario(mode) {
  closeQuote(); closeInquiry(); closeLocationPhoto(); cancelRequests();
  state.mode = mode; state.step = 1;
  state.selectedInterval = null; state.quote = null; state.arena = null; state.date = null;
  state.page = scenarioPages[mode];
  render();
}

function renderPickupGames() {
  const games = pickupGames.filter(game => state.arenas.some(arena => arena.id === game.arenaId));
  content.innerHTML = `<p class="card-eyebrow">ФУТБОЛ / МЕСТО ДЛЯ КАЖДОГО</p><h2 class="step-title">Сборные игры</h2><p class="step-description">Приходи один или с друзьями. Выбери игру и оплати только своё участие — собирать целую команду не нужно.</p><div class="pickup-list">${games.map(game => {
    const arena = state.arenas.find(item => item.id === game.arenaId);
    const pay = participationPaymentUrl(game);
    return `<article class="pickup-card"><div class="pickup-card-photo"><img src="${esc(arena.photo)}" alt="${esc(arena.name)} — футбольное поле" loading="lazy"><span>${pay ? 'ЗАПИСЬ ОТКРЫТА' : game.confirmed ? 'ЗАПИСЬ СКОРО ОТКРОЕТСЯ' : 'АНОНС / ПРИМЕР ВРЕМЕНИ'}</span><strong>${esc(game.time)}</strong></div><div class="pickup-body"><p class="pickup-date">${game.date ? esc(formatDate(dateFromKey(game.date))) : 'Дата игры уточняется'}</p><h3>${esc(arena.name)}</h3><p class="pickup-address">${esc(arena.address)}</p><div class="pickup-price"><span>Участие одного игрока</span><strong>${typeof game.pricePerPerson === 'number' ? new Intl.NumberFormat('ru-RU').format(game.pricePerPerson) + ' ₽' : 'Стоимость уточняется'}</strong></div><button type="button" class="primary" data-join-game="${esc(game.id)}">Принять участие <span aria-hidden="true">↗</span></button></div></article>`;
  }).join('')}</div>${games.some(game => !game.confirmed) ? '<p class="demo-note">Время 21:00 показано как пример. Даты и стоимость участия будут подтверждены перед открытием оплаты.</p>' : ''}<button type="button" class="secondary" id="askPickup">Вопрос по сборным играм? Написать менеджеру ↗</button>`;
  content.querySelectorAll('[data-join-game]').forEach(button => button.onclick = () => openParticipation(games.find(game => game.id === button.dataset.joinGame)));
  content.querySelector('#askPickup').onclick = () => openInquiry('games');
}

function openParticipation(game) {
  closeInquiry(); closeQuote();
  const arena = state.arenas.find(item => item.id === game.arenaId);
  if (!arena) return;
  const popup = root.querySelector('#quotePopup'), link = participationPaymentUrl(game);
  quoteReturnFocus = root.activeElement || document.activeElement;
  popup.innerHTML = `<div class="quote-top"><p class="card-eyebrow">СБОРНАЯ ИГРА / ОДИН УЧАСТНИК</p><button type="button" class="quote-close" aria-label="Закрыть">×</button></div><h2 id="quoteTitle">${esc(arena.name)}</h2><p class="quote-address">${esc(arena.address)}</p><img class="participation-photo" src="${esc(arena.photo)}" alt="Футбольная площадка — ${esc(arena.name)}"><dl class="quote-details"><div><dt>Дата</dt><dd>${game.date ? esc(formatDate(dateFromKey(game.date))) : 'Уточняется'}</dd></div><div><dt>Начало · МСК</dt><dd>${esc(game.time)}</dd></div><div><dt>Участников в заявке</dt><dd>1 человек</dd></div><div class="quote-total"><dt>Стоимость за человека</dt><dd>${typeof game.pricePerPerson === 'number' ? new Intl.NumberFormat('ru-RU').format(game.pricePerPerson) + ' ₽' : 'Уточняется'}</dd></div></dl>${link ? `<a class="primary participation-pay" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Оплатить участие ↗</a><p class="demo-note">Откроется оплата одного места на выбранную игру.</p>` : '<p class="quote-notice">Это предварительный анонс. Дата, стоимость и ссылка на оплату участия пока не подтверждены.</p><button class="primary" type="button" disabled>Оплата пока недоступна</button>'}<button type="button" class="secondary" id="askParticipation">Уточнить у менеджера ↗</button>`;
  popup.querySelector('.quote-close').onclick = closeQuote;
  popup.querySelector('#askParticipation').onclick = () => {
    closeQuote();
    openInquiry('games', '', { arena:arena.name, date:game.date || '', request:`Хочу принять участие в сборной игре на станции ${arena.name}, начало в ${game.time}. Подскажите дату и стоимость за одного человека.` });
  };
  popup.showModal();
  popup.querySelector('.quote-close').focus();
}

function renderEvents() {
  content.innerHTML = `
    <p class="card-eyebrow">ФУТБОЛЬНЫЕ МЕРОПРИЯТИЯ</p>
    <h2 class="step-title">Игра, которую запомнят</h2>
    <p class="step-description">Соберите коллег или друзей на футбольной площадке. Выберите свой повод — мы поможем подобрать манеж, время и формат игры.</p>
    <div class="event-showcase">
      <article class="event-product event-product-corporate">
        <div class="event-product-head"><span>01 / ДЛЯ КОМАНДЫ</span><span>КОМАНДНЫЙ ДУХ ↗</span></div>
        <h3>Корпоративный<br><em>спорт</em></h3>
        <p class="event-product-lead">Организуем для вашей компании футбольное событие под ключ — от первого обсуждения до финального свистка.</p>
        <p class="event-product-copy">Подберём манеж, продумаем формат под количество участников, составим расписание и возьмём на себя проведение игр.</p>
        <p class="event-product-copy event-product-copy-follow">Это может быть один большой матч, серия регулярных встреч или еженедельные тренировки для оздоровления коллектива и развития корпоративной культуры. Соберём программу под вашу команду, чтобы коллеги получили не просто время на поле, а полноценное событие, которое захочется повторить.</p>
        <button class="event-product-action" type="button" data-event="Корпоративный спорт">Оставить заявку <b aria-hidden="true">↗</b></button>
      </article>
      <article class="event-product event-product-birthday">
        <div class="event-product-head"><span>02 / ДЛЯ СВОИХ</span><span>ВАШ ДЕНЬ ↗</span></div>
        <h3>День<br><em>рождения</em></h3>
        <p class="event-product-lead">Соберите друзей на поле и превратите обычную встречу в футбольный праздник.</p>
        <p class="event-product-copy">Подберём манеж для вашей компании, согласуем удобное время и формат игры. Мячи и манишки есть на площадке; тренера можно обсудить отдельно.</p>
        <div class="event-product-tags" aria-label="Что можно обсудить"><span>Игра с друзьями</span><span>Площадка и время</span><span>Тренер по запросу</span></div>
        <button class="event-product-action" type="button" data-event="День рождения">Обсудить день рождения <b aria-hidden="true">↗</b></button>
      </article>
    </div>
    <div class="manager-card"><div><span>НЕ ЗНАЕТЕ, С ЧЕГО НАЧАТЬ?</span><h3>Расскажите об идее</h3><p>Напишите дату, примерное число участников и пожелания. Менеджер поможет выбрать площадку и обсудит детали.</p></div><button class="primary" id="askEvent">Оставить запрос ↗</button><a class="manager-direct" href="https://t.me/ffc_manager">Написать @ffc_manager</a></div>`;
  content.querySelectorAll('[data-event]').forEach(button => button.onclick = () => openInquiry('events', button.dataset.event, { request: `Хочу организовать ${button.dataset.event.toLowerCase()}. ` }));
  content.querySelector('#askEvent').onclick = () => openInquiry('events');
}

let inquiryReturnFocus = null;
const inquiryDrafts = new Map();
function closeInquiry() {
  const popup = root.querySelector('#inquiryPopup');
  if (popup?.open) popup.close();
}
function openInquiry(category, occasion = '', context = {}) {
  closeQuote();
  const popup = root.querySelector('#inquiryPopup');
  if (!popup) return;
  const saved = { ...(inquiryDrafts.get(category) || {}), ...context };
  const categoryTitle = category === 'events' ? 'Мероприятия' : category === 'games' ? 'Сборные игры' : 'Выбрать манеж';
  inquiryReturnFocus = root.activeElement || document.activeElement;
  popup.innerHTML = `<div class="quote-top"><p class="card-eyebrow">ЗАПРОС МЕНЕДЖЕРУ / ${categoryTitle}</p><button type="button" class="quote-close" aria-label="Закрыть форму">×</button></div><h2 id="inquiryTitle">Расскажи<br><em>о своей игре</em></h2><p class="inquiry-intro">${category === 'events' ? 'Какой повод, сколько гостей и что хочется организовать?' : category === 'games' ? 'Хотите собрать команду, присоединиться к игре или обсудить формат?' : 'Нужна помощь с площадкой, временем или форматом игры?'}</p><form id="inquiryForm" class="inquiry-form"><label class="field">КАК К ВАМ ОБРАЩАТЬСЯ<input name="name" autocomplete="given-name" maxlength="60" placeholder="Ваше имя" value="${esc(saved.name || '')}" required></label><div class="inquiry-row"><label class="field">МАНЕЖ<select name="arena"><option value="">Помогите выбрать</option>${state.arenas.map(arena => `<option value="${esc(arena.name)}" ${(saved.arena || state.arena?.name) === arena.name ? 'selected' : ''}>${esc(arena.name)}</option>`).join('')}</select></label><label class="field">ЖЕЛАЕМАЯ ДАТА · НЕОБЯЗАТЕЛЬНО<input name="date" type="date" min="${Viva.moscowDay()}" value="${esc(saved.date || state.date || '')}"></label></div><label class="field">ВАШ ЗАПРОС<textarea name="request" minlength="10" maxlength="700" rows="5" placeholder="Сколько вас, когда хотите играть и какая помощь нужна?" required>${esc(saved.request || (occasion ? `Хочу организовать ${occasion.toLowerCase()}. ` : ''))}</textarea><span class="inquiry-count">До 700 символов</span></label><p id="inquiryError" class="payment-error" role="alert"></p><button type="submit" class="primary">Перейти в Telegram <span aria-hidden="true">↗</span></button><p class="inquiry-hint">Откроется чат с <a href="https://t.me/ffc_manager">@ffc_manager</a>. Проверьте заявку и нажмите «Отправить» в Telegram.</p></form><div id="inquiryResult" hidden></div>`;
  const form = popup.querySelector('#inquiryForm');
  const readDraft = () => Object.fromEntries(['name','arena','date','request'].map(name => [name, form.querySelector(`[name="${name}"]`).value]));
  form.oninput = () => inquiryDrafts.set(category, readDraft());
  form.onsubmit = event => {
    event.preventDefault();
    const error = popup.querySelector('#inquiryError'); error.textContent = '';
    let text;
    try { text = buildInquiry({ category, ...readDraft(), plan: '' }); }
    catch (issue) { error.textContent = issue.message; return; }
    const url = managerLink(text);
    inquiryDrafts.set(category, readDraft());
    const result = popup.querySelector('#inquiryResult');
    result.hidden = false;
    result.innerHTML = `<div class="inquiry-ready"><span class="ready-mark">↗</span><h3>Заявка подготовлена</h3><p>Если переход не сработал, откройте чат с менеджером кнопкой ниже. Затем нажмите «Отправить» в Telegram. Текст можно скопировать.</p><a class="primary inquiry-open" href="${esc(url)}">Открыть чат @ffc_manager ↗</a><a class="secondary inquiry-native" href="${esc(managerAppLink(text))}">Открыть приложение Telegram ↗</a><button type="button" class="secondary" id="copyInquiry">Скопировать заявку</button><details class="inquiry-preview"><summary>Текст заявки</summary><pre></pre></details></div>`;
    result.querySelector('pre').textContent = text;
    result.querySelector('#copyInquiry').onclick = async () => {
      try { await navigator.clipboard.writeText(text); result.querySelector('#copyInquiry').textContent = 'Заявка скопирована'; }
      catch { result.querySelector('details').open = true; result.querySelector('#copyInquiry').textContent = 'Выделите и скопируйте текст ниже'; }
    };
    form.hidden = true;
    result.scrollIntoView({ block:'nearest', behavior:'smooth' });
    if (telegram?.initData && telegram?.openTelegramLink) {
      try { telegram.openTelegramLink(url); return; }
      catch { /* The direct HTTPS link below still works outside Telegram. */ }
    }
    window.location.assign(url);
  };
  popup.querySelector('.quote-close').onclick = closeInquiry;
  if (!popup.open) popup.showModal();
  popup.querySelector('[name="name"]').focus();
}
const inquiryPopup = root.querySelector('#inquiryPopup');
inquiryPopup?.addEventListener('close', () => inquiryReturnFocus?.focus());
inquiryPopup?.addEventListener('click', event => {
  if (event.target !== inquiryPopup) return;
  const box = inquiryPopup.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeInquiry();
});

let photoReturnFocus = null;
function closeLocationPhoto() { root.querySelector('#photoPopup')?.close(); }
function openLocationPhoto(arena) {
  const popup = root.querySelector('#photoPopup');
  if (!popup) return;
  photoReturnFocus = root.activeElement || document.activeElement;
  popup.innerHTML = `<div class="quote-top"><h2 id="photoTitle">${esc(arena.name)}</h2><button type="button" class="quote-close" aria-label="Закрыть фотографию">×</button></div><img src="${esc(arena.photo)}" alt="Полная фотография футбольной площадки — ${esc(arena.name)}">`;
  popup.querySelector('.quote-close').onclick = closeLocationPhoto;
  popup.showModal(); popup.querySelector('.quote-close').focus();
}
root.querySelector('#photoPopup')?.addEventListener('close', () => photoReturnFocus?.focus());

function flash(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function renderArenaStep() {
  content.innerHTML = `
    <p class="card-eyebrow">01 / ВЫБОР ПЛОЩАДКИ</p>
    <h2 class="step-title">Выбери манеж</h2>
    <p class="step-description">Нажми на площадку, чтобы посмотреть свободное время.</p>
    ${oauthError ? `<p class="payment-error" role="alert">${esc(oauthError)}</p>` : ''}
    <label class="arena-search"><span>ПОИСК ПО МЕТРО ИЛИ АДРЕСУ</span><input id="arenaSearch" type="search" placeholder="Например, Планерная" autocomplete="off"></label>
    <div class="metro-choices" id="metroChoices" role="group" aria-label="Уточните станцию" hidden></div>
    <p class="arena-search-result" id="arenaSearchResult" hidden></p>
    <div class="arena-list">
      ${state.arenas.map((arena) => `
        <div class="arena-item" data-arena="${arena.id}" data-search="${esc(searchText(`${arena.name} ${arena.address}`))}">
          <button type="button" class="arena-option ${state.arena?.id === arena.id ? "active" : ""}" data-accent="${arena.accent}">
            <span class="arena-thumbnail"><picture><source media="(min-width: 1024px)" srcset="${esc(arena.photo)}"><img src="${esc(arena.thumbnail)}" alt="" loading="lazy" width="260" height="173"></picture></span>
            <span class="arena-details"><span class="arena-name">${arena.name}</span><span class="arena-meta">${arena.address}</span><span class="arena-distance" hidden></span></span>
            <span class="arrow">›</span>
          </button>
          <a class="arena-route" target="_blank" rel="noopener noreferrer" aria-label="Как добраться до манежа «${esc(arena.name)}» в Яндекс Картах" hidden>
            Как добраться <span aria-hidden="true">↗</span>
          </a>
        </div>`).join("")}
    </div>
    <button class="secondary" id="backButton">Нужна помощь? Написать менеджеру ↗</button>`;
  const arenaList = content.querySelector('.arena-list');
  const arenaItems = [...arenaList.querySelectorAll('[data-arena]')];
  const itemsById = new Map(arenaItems.map(item => [item.dataset.arena, item]));
  const searchInput = content.querySelector('#arenaSearch');
  const choices = content.querySelector('#metroChoices');
  const result = content.querySelector('#arenaSearchResult');
  const kmFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  let showingNearest = false;

  function showNearest(station) {
    const matches = nearestArenas(station, state.arenas);
    for (const item of arenaItems) item.hidden = true;
    const nearestItems = matches.map(({ arena, km }) => {
      const item = itemsById.get(arena.id);
      const distance = item.querySelector('.arena-distance');
      const label = km < 0.1 ? 'Менее 100 м' : `${kmFormat.format(km)} км`;
      distance.textContent = `${label} по прямой`;
      distance.hidden = false;

      const route = item.querySelector('.arena-route');
      const url = new URL('https://yandex.ru/maps/');
      url.searchParams.set('mode', 'routes');
      url.searchParams.set('rtt', 'mt');
      url.searchParams.set('rtext', `${station.coordinates.join(',')}~${arena.address}`);
      route.href = url.href;
      route.hidden = false;
      item.hidden = false;
      return item;
    });
    arenaList.prepend(...nearestItems);
    showingNearest = true;
    choices.hidden = true;
    result.hidden = false;
    result.textContent = matches.length
      ? `Ближайшие манежи от станции «${station.name}»`
      : 'Манежи не найдены.';
  }

  searchInput.oninput = () => {
    const query = searchText(searchInput.value);
    const stations = findMetroStations(searchInput.value);
    if (stations.length === 1) {
      showNearest(stations[0]);
      return;
    }

    if (showingNearest) {
      arenaList.append(...arenaItems);
      showingNearest = false;
    }
    let hasArena = false;
    for (const item of arenaItems) {
      item.hidden = !item.dataset.search.includes(query);
      item.querySelector('.arena-distance').hidden = true;
      item.querySelector('.arena-route').hidden = true;
      hasArena ||= !item.hidden;
    }

    choices.hidden = stations.length === 0;
    choices.replaceChildren();
    for (const station of stations.slice(0, 6)) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = `${station.name} · ${station.line}`;
      option.onclick = () => {
        searchInput.value = station.name;
        showNearest(station);
        searchInput.focus();
      };
      choices.append(option);
    }
    result.hidden = hasArena && !stations.length;
    result.textContent = stations.length
      ? 'Уточните название или выберите станцию из списка.'
      : 'Станция или манеж не найдены. Проверьте название или введите адрес площадки.';
  };
  arenaItems.forEach((item) => item.querySelector('.arena-option').addEventListener("click", () => {
    oauthError = null;
    state.arena = state.arenas.find((arena) => arena.id === item.dataset.arena);
    state.date = Viva.moscowDay();
    state.selectedInterval = null;
    state.rawSlots = null;
    state.viva = null;
    state.quote = null;
    state.durationMinutes = Math.max(state.arena.viva.minMinutes, 60);
    setStep(2);
  }));
  content.querySelector("#backButton").onclick = () => openInquiry("rent");
}

function cancelRequests() {
  slotsController?.abort();
  quoteController?.abort();
  slotsRequest += 1;
  quoteRequest += 1;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function minutesLabel(minutes) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} ч` : "", rest ? `${rest} мин` : ""].filter(Boolean).join(" ");
}

function dateFromKey(day) { return new Date(`${day}T12:00:00`); }

function dateButtons() {
  return dates().map(day => {
    const date = dateFromKey(day);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date).replace(".", "");
    const month = new Intl.DateTimeFormat("ru-RU", { month: "short" }).format(date).replace(".", "");
    return `<button class="date-option ${state.date === day ? "active" : ""}" data-date="${day}" aria-pressed="${state.date === day}" aria-label="${esc(formatDate(date))}"><small>${weekday}</small><b>${date.getDate()}</b><small>${month}</small></button>`;
  }).join("");
}

function renderDurations() {
  const holder = content.querySelector("#durationHolder");
  if (!holder || !state.viva) return;
  const min = state.viva.minMinutes, step = state.viva.stepMinutes;
  const values = Array.from({ length: Math.floor((Math.max(180, min) - min) / step) + 1 }, (_, i) => min + i * step);
  if (!values.includes(state.durationMinutes)) state.durationMinutes = values[0];
  holder.innerHTML = `<label class="field">СКОЛЬКО ИГРАЕМ<select id="durationSelect">${values.map(value => `<option value="${value}" ${value === state.durationMinutes ? "selected" : ""}>${minutesLabel(value)}</option>`).join("")}</select></label><p class="demo-note">Минимум ${minutesLabel(min)} · шаг ${minutesLabel(step)} · время московское</p>`;
  holder.querySelector("select").onchange = event => {
    quoteController?.abort(); quoteRequest += 1;
    state.durationMinutes = Number(event.target.value);
    state.selectedInterval = null; state.quote = null;
    renderSlots();
  };
}

async function renderDateStep(restoredInterval = null) {
  slotsController?.abort();
  slotsController = new AbortController();
  const signal = slotsController.signal, request = ++slotsRequest;
  const arena = state.arena, day = state.date;
  const current = () => !signal.aborted && request === slotsRequest && state.page === "booking" && state.step === 2 && state.arena?.id === arena.id && state.date === day;
  state.rawSlots = null; state.selectedInterval = null; state.quote = null;
  content.innerHTML = `
    <h2 class="step-title">${esc(arena.name)}</h2>
    <p class="venue-address">${esc(arena.address)}</p>
    ${oauthError ? `<p class="payment-error" role="alert">${esc(oauthError)}</p>` : ''}
    <button type="button" class="arena-cover" id="viewLocationPhoto" aria-label="Увеличить фотографию площадки ${esc(arena.name)}"><img src="${esc(arena.photo)}" alt="Футбольное поле — ${esc(arena.name)}"><span>Посмотреть фото ↗</span></button>
    <p class="step-description venue-time-title">Когда играем?</p>
    <p class="date-range">Ближайшие две недели · московское время</p>
    <div class="date-strip" role="group" aria-label="Дата игры">${dateButtons()}</div>
    <div id="durationHolder"></div>
    <div class="section-label"><strong>Свободное время</strong><button type="button" class="refresh-slots" id="refreshSlots">Обновить ↻</button></div>
    <div class="slots game-slots" id="slots" aria-busy="true"><p class="empty-slots">Получаем свободное время…</p></div>
    <p class="demo-note">Время проверяется по актуальному расписанию. Выбор интервала пока не создаёт бронь.</p>
    <button class="primary" id="nextButton" disabled>Выберите время</button>
    <p class="payment-error" id="quoteError" role="alert" hidden></p>
    <button class="secondary" id="backButton">Назад</button>`;
  content.querySelectorAll("[data-date]").forEach(button => button.onclick = () => {
    if (!Viva.validDay(button.dataset.date, state.viva || arena.viva)) return;
    quoteController?.abort(); quoteRequest += 1;
    state.date = button.dataset.date;
    renderDateStep();
  });
  content.querySelector("#viewLocationPhoto").onclick = () => openLocationPhoto(arena);
  content.querySelector("#backButton").onclick = () => setStep(1);
  content.querySelector("#refreshSlots").onclick = () => renderDateStep();
  renderDurations();
  const strip = content.querySelector(".date-strip"), selected = content.querySelector(".date-option.active");
  if (strip && selected) strip.scrollLeft = Math.max(0, selected.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + selected.clientWidth / 2);
  try {
    await clockReady;
    if (!current()) return;
    const settings = await Viva.settingsFor(arena.viva, signal);
    if (!current()) return;
    state.viva = settings;
    if (!Viva.validDay(day, settings)) {
      state.date = Viva.bookingWindow(settings).min;
      return renderDateStep();
    }
    content.querySelector(".date-strip").innerHTML = dateButtons();
    content.querySelectorAll("[data-date]").forEach(button => button.onclick = () => {
      if (!Viva.validDay(button.dataset.date, state.viva)) return;
      quoteController?.abort(); quoteRequest += 1; state.date = button.dataset.date; renderDateStep();
    });
    renderDurations();
    const raw = await Viva.slotsFor(settings, day, signal);
    if (!current()) return;
    state.rawSlots = raw;
    if (restoredInterval?.minutes === state.durationMinutes) {
      const from = Date.parse(restoredInterval.timeFrom), to = Date.parse(restoredInterval.timeTo);
      state.selectedInterval = Viva.intervalsFor(raw, settings, day, state.durationMinutes)
        .find(interval => Date.parse(interval.timeFrom) === from && Date.parse(interval.timeTo) === to) || null;
    }
    renderSlots();
    if (state.selectedInterval) void showQuote(false);
    if (restoredInterval && !state.selectedInterval) flash("Выбранное время больше недоступно. Выберите другой интервал.");
  } catch (error) {
    if (!current()) return;
    content.querySelector("#slots").innerHTML = `<p class="empty-slots">${esc(error.message)}<br>Нажмите «Обновить», чтобы повторить.</p>`;
    content.querySelector("#refreshSlots").onclick = () => renderDateStep(restoredInterval);
  } finally {
    if (current()) content.querySelector("#slots")?.setAttribute("aria-busy", "false");
  }
}

function renderSlots() {
  const holder = content.querySelector("#slots"), next = content.querySelector("#nextButton");
  if (!holder || !next || !state.rawSlots || !state.viva) return;
  const options = Viva.intervalsFor(state.rawSlots, state.viva, state.date, state.durationMinutes);
  state.slots = options;
  if (!options.some(option => option.timeFrom === state.selectedInterval?.timeFrom && option.timeTo === state.selectedInterval?.timeTo)) state.selectedInterval = null;
  holder.innerHTML = options.map((option, index) => `<button class="slot block-slot ${option.timeFrom === state.selectedInterval?.timeFrom ? "selected" : ""}" data-interval="${index}" aria-pressed="${option.timeFrom === state.selectedInterval?.timeFrom}">${Viva.timeLabel(option.timeFrom)} – ${Viva.timeLabel(option.timeTo)}${Viva.moscowDay(Date.parse(option.timeTo)) !== state.date ? '<small>следующий день</small>' : ''}</button>`).join("") || `<p class="empty-slots">На эту дату нет свободных интервалов на ${minutesLabel(state.durationMinutes)} подряд. Выберите другой день, длительность или манеж.</p>`;
  holder.querySelectorAll("[data-interval]").forEach(button => button.onclick = () => {
    quoteController?.abort(); quoteRequest += 1;
    state.selectedInterval = options[Number(button.dataset.interval)];
    state.quote = null; renderSlots();
    void showQuote(false);
  });
  next.disabled = !state.selectedInterval || !state.quote;
  next.textContent = state.quote
    ? `Перейти к оплате · ${new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(state.quote.amount)}`
    : state.selectedInterval ? "Рассчитываем стоимость…" : "Выберите время";
  next.onclick = () => showQuote(Boolean(state.quote));
}

async function showQuote(openDialog = true) {
  const displayedQuote = state.quote;
  if (!state.selectedInterval || !state.viva) return;
  quoteController?.abort(); quoteController = new AbortController();
  const signal = quoteController.signal, request = ++quoteRequest;
  const arena = state.arena, interval = { ...state.selectedInterval }, settings = { ...state.viva }, minutes = state.durationMinutes, day = state.date;
  const current = () => !signal.aborted && request === quoteRequest && state.page === "booking" && state.step === 2 && state.arena?.id === arena.id && state.date === day && state.selectedInterval?.timeFrom === interval.timeFrom && state.durationMinutes === minutes;
  const button = content.querySelector("#nextButton");
  const message = content.querySelector("#quoteError");
  if (message) { message.hidden = true; message.textContent = ""; }
  button.disabled = true; button.setAttribute("aria-busy", "true");
  button.textContent = openDialog ? "Проверяем время и стоимость…" : "Рассчитываем стоимость…";
  try {
    const quote = await Viva.quoteFor(settings, interval, minutes, signal);
    if (!current()) return;
    state.quote = quote;
    if (openDialog && displayedQuote && Math.abs(displayedQuote.amount - quote.amount) > .005) {
      const notice = "Стоимость изменилась. Проверьте новую сумму на кнопке и подтвердите переход к оплате.";
      flash(notice);
      if (message) { message.hidden = false; message.textContent = notice; }
      return;
    }
    if (openDialog && displayedQuote) openQuote(arena, quote, true);
  } catch (error) {
    if (!current()) return;
    state.quote = null;
    flash(error.message);
    if (message) { message.hidden = false; message.textContent = error.message; }
    if (error.code === "SLOT_UNAVAILABLE") { state.selectedInterval = null; renderDateStep(); }
  } finally {
    if (current()) {
      button.disabled = false; button.setAttribute("aria-busy", "false");
      button.textContent = state.quote
        ? `Перейти к оплате · ${new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(state.quote.amount)}`
        : "Повторить расчёт стоимости";
    }
  }
}

let quoteReturnFocus = null;
function openQuote(arena, quote, autoRequest = false) {
  closeQuote();
  quoteReturnFocus = root.activeElement || document.activeElement;
  const popup = root.querySelector("#quotePopup");
  const startDay = Viva.moscowDay(Date.parse(quote.timeFrom)), endDay = Viva.moscowDay(Date.parse(quote.timeTo));
  popup.innerHTML = `<div class="quote-top"><p class="card-eyebrow">03 / ВХОД И ОПЛАТА</p><button type="button" class="quote-close" aria-label="Закрыть">×</button></div><h2 id="quoteTitle">Время для вашей игры</h2><p class="quote-arena">${esc(arena.name)}</p><p class="quote-address">${esc(arena.address)}</p><dl class="quote-details"><div><dt>Дата</dt><dd>${esc(formatDate(dateFromKey(startDay)))}${endDay !== startDay ? ` → ${esc(formatDate(dateFromKey(endDay)))}` : ''}</dd></div><div><dt>Время · МСК</dt><dd>${Viva.timeLabel(quote.timeFrom)} – ${Viva.timeLabel(quote.timeTo)}</dd></div><div><dt>Длительность</dt><dd>${minutesLabel(quote.minutes)}</dd></div><div class="quote-total"><dt>Стоимость игры</dt><dd>${new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(quote.amount)}</dd></div></dl><p class="quote-notice">Время и стоимость проверены. Для получения ссылки на оплату нужна действующая сессия Viva.</p><button class="primary" type="button" id="payButton">Получить ссылку на оплату</button><div id="paymentPanel" aria-live="polite"></div>`;
  popup.querySelector(".quote-close").onclick = closeQuote;
  const binding = { ...state.viva };
  popup.querySelector("#payButton").onclick = () => requestPayment(binding, quote);
  const previous = Payment.previousAttempt(binding, quote);
  if (previous) renderPaymentResponse(binding, quote, previous);
  popup.showModal();
  popup.querySelector(".quote-close").focus();
  if (autoRequest && !previous) queueMicrotask(() => requestPayment(binding, quote));
}
function closeQuote() {
  paymentController?.abort();
  const popup = root.querySelector("#quotePopup");
  if (popup?.open) { popup.close(); quoteReturnFocus?.focus(); }
}

function paymentError(error) {
  if (error.code === "PAYMENT_UNKNOWN") return "Ответ на запрос не получен. Viva могла создать платёж. Повторно запрос не отправляем, чтобы избежать дубля.";
  if (error instanceof TypeError) return "Не удалось связаться с Viva. Проверьте соединение.";
  return error.message || "Не удалось получить ответ Viva.";
}
function showPaymentError(error) {
  const panel = root.querySelector("#paymentPanel");
  if (!panel) return;
  panel.innerHTML = `<section class="payment-message payment-message-error" role="alert"><strong>Не удалось получить ссылку</strong><p>${esc(paymentError(error))}</p></section>`;
}
async function requestPayment(binding, quote) {
  const popup = root.querySelector("#quotePopup"), button = popup.querySelector("#payButton");
  if (!popup.open || button.disabled) return;
  paymentController?.abort(); paymentController = new AbortController();
  const signal = paymentController.signal;
  button.disabled = true; button.textContent = "Проверяем вход и выбранное время…";
  root.querySelector("#paymentPanel").textContent = "";
  try {
    const result = await Payment.createPayment(binding, quote, quote.minutes, signal, () => {
      if (!signal.aborted) button.textContent = "Запрашиваем ссылку на оплату…";
    });
    if (signal.aborted || !popup.open) return;
    renderPaymentResponse(binding, quote, result);
    if (result.id && !Payment.paymentLink(result.response)) await readPaymentStatus(binding, quote, signal);
  } catch (error) {
    if (signal.aborted || !popup.open) return;
    if (error.code === "AUTH_REQUIRED" || error.status === 401) {
      button.disabled = false; button.textContent = "Получить ссылку на оплату";
      renderVivaLogin(binding, quote);
    } else {
      showPaymentError(error);
      const previous = Payment.previousAttempt(binding, quote);
      button.disabled = Boolean(previous);
      button.textContent = previous ? "Запрос уже отправлен" : "Получить ссылку на оплату";
    }
  }
}
function mountVivaLogin(panel, binding, authSignal, options = {}) {
  const description = options.description || "Войдите по телефону, чтобы получить ссылку на оплату для своего аккаунта.";
  const submitLabel = options.submitLabel || "Войти в Viva";
  panel.innerHTML = `<section class="viva-login"><h3>Вход в Viva</h3><p>${esc(description)}</p><div class="viva-oauth-actions"><button type="button" class="viva-oauth-button" data-oauth="yandex">Войти через Яндекс ↗</button><button type="button" class="viva-oauth-button" data-oauth="vkid">Войти через VK ↗</button></div><p class="viva-login-separator">ИЛИ ПО НОМЕРУ ТЕЛЕФОНА</p><form id="vivaPhoneForm" class="form-grid"><label class="field">ТЕЛЕФОН<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 999 123-45-67" required></label><button type="submit" class="secondary">Получить код</button></form><p id="authMessage" class="demo-note" role="status"></p></section>`;
  const section = panel.querySelector(".viva-login"), phoneForm = panel.querySelector("#vivaPhoneForm"), message = panel.querySelector("#authMessage");
  if (options.error) message.textContent = options.error;
  const active = () => !authSignal.aborted && panel.contains(section);
  const authError = error => paymentError(error) + (error.status ? ` (HTTP ${error.status})` : "");
  section.querySelectorAll('[data-oauth]').forEach(button => button.onclick = async () => {
    section.querySelectorAll('[data-oauth]').forEach(item => { item.disabled = true; });
    message.textContent = 'Открываем вход Viva…';
    try { await Payment.startOAuthLogin(binding.tenantKey, button.dataset.oauth, state.arena?.id, options.selection); }
    catch (error) {
      if (!active()) return;
      message.textContent = paymentError(error);
      section.querySelectorAll('[data-oauth]').forEach(item => { item.disabled = false; });
    }
  });
  function showCode(result) {
    let busy = false;
    phoneForm.innerHTML = `<p class="demo-note">Код для ${esc(result.phone)}. Проверьте сообщения и, при наличии, почту вашего аккаунта Viva.</p><p id="vivaDelivery" class="demo-note"></p><label class="field">КОД<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required></label><button type="submit" class="secondary">${esc(submitLabel)}</button><button type="button" id="vivaResend" class="secondary">Получить код по SMS</button><button type="button" id="vivaChangePhone" class="secondary">Изменить номер</button>`;
    const confirm = phoneForm.querySelector('[type="submit"]'), resend = phoneForm.querySelector("#vivaResend"), change = phoneForm.querySelector("#vivaChangePhone"), delivery = phoneForm.querySelector("#vivaDelivery");
    message.textContent = `Viva приняла запрос (HTTP ${result.httpStatus}). Это ещё не подтверждение доставки сообщения.`;
    const update = () => {
      if (!active()) { clearInterval(timer); return; }
      const seconds = Math.max(0, Math.ceil((result.retryAt - Viva.now()) / 1000));
      resend.disabled = busy || seconds > 0;
      resend.textContent = seconds > 0 ? `Получить код по SMS через ${seconds} сек.` : "Получить код по SMS";
      const elapsed = Math.max(0, Viva.now() - result.sentAt);
      const index = Math.min(Math.floor(elapsed / 60000), result.channels.length - 1);
      delivery.textContent = result.channel === "sms" ? "Запрошена отправка по SMS." : result.channels.length ? `Каналы Viva: ${result.channels.map(Payment.loginChannelLabel).join(" → ")}. ${seconds > 0 ? `Текущий этап: ${Payment.loginChannelLabel(result.channels[index])}.` : 'Если код не пришёл, запросите его по SMS.'}` : "Viva выбирает канал доставки. Если код не пришёл, запросите его по SMS после таймера.";
    };
    const timer = setInterval(update, 1000);
    authSignal.addEventListener("abort", () => clearInterval(timer), { once: true });
    update();
    change.onclick = () => { clearInterval(timer); mountVivaLogin(panel, binding, authSignal, options); };
    resend.onclick = async () => {
      if (busy || resend.disabled) return;
      busy = true; confirm.disabled = true; change.disabled = true; update(); message.textContent = "Запрашиваем код по SMS…";
      try {
        const next = await Payment.requestLoginCode(binding.tenantKey, result.phone, authSignal, "sms");
        if (!active()) return;
        result = next; phoneForm.elements.code.value = "";
        message.textContent = `Viva приняла запрос SMS (HTTP ${next.httpStatus}). Если сообщение не придёт, доставку нужно проверить в Viva.`;
      } catch (error) { if (active()) message.textContent = authError(error); }
      finally { if (active()) { busy = false; confirm.disabled = false; change.disabled = false; update(); } }
    };
    phoneForm.onsubmit = async event => {
      event.preventDefault(); if (busy) return;
      busy = true; confirm.disabled = true; change.disabled = true; update(); message.textContent = "Проверяем код…";
      try {
        await Payment.verifyLoginCode(binding.tenantKey, result.phone, new FormData(phoneForm).get("code"), authSignal);
        if (!active()) return;
        clearInterval(timer);
        panel.innerHTML = '<p class="auth-success">Вход подтверждён. Переходим дальше…</p>';
        options.onSuccess?.();
      } catch (error) { if (active()) message.textContent = error.status === 400 || error.status === 401 ? "Код неверный или истёк. Проверьте последний полученный код." : authError(error); }
      finally { if (active()) { busy = false; confirm.disabled = false; change.disabled = false; update(); } }
    };
    phoneForm.querySelector("input").focus();
  }
  phoneForm.onsubmit = async event => {
    event.preventDefault();
    const submit = phoneForm.querySelector("button"); submit.disabled = true;
    message.textContent = "Запрашиваем код…";
    try {
      const result = await Payment.requestLoginCode(binding.tenantKey, new FormData(phoneForm).get("phone"), authSignal);
      if (active()) showCode(result);
    } catch (error) { if (active()) { message.textContent = authError(error); submit.disabled = false; } }
  };
  panel.querySelector("input").focus();
}
function renderVivaLogin(binding, quote) {
  const panel = root.querySelector("#paymentPanel");
  const authSignal = paymentController.signal;
  mountVivaLogin(panel, binding, authSignal, {
    description: "Войдите в Viva, чтобы получить ссылку на оплату выбранного времени.",
    submitLabel: "Войти и получить ссылку",
    selection: { timeFrom: quote.timeFrom, timeTo: quote.timeTo, minutes: quote.minutes },
    onSuccess: () => queueMicrotask(() => requestPayment(binding, quote))
  });
}
function renderPaymentResponse(binding, quote, result) {
  const button = root.querySelector("#payButton"), panel = root.querySelector("#paymentPanel");
  if (!button || !panel) return;
  button.disabled = true; button.textContent = result.phase === "unknown" || result.phase === "sending" ? "Запрос уже отправлен" : "Ответ Viva получен";
  const link = Payment.paymentLink(result.operation) || Payment.paymentLink(result.response);
  const failed = result.operation?.status === "FAILED";
  if (link) {
    button.hidden = true;
    panel.innerHTML = `<section class="payment-success"><div class="payment-success-mark" aria-hidden="true">✓</div><p class="card-eyebrow">ССЫЛКА ГОТОВА</p><h3>Перейдите к оплате</h3><p>Откроется защищённая страница оплаты Viva.</p><a class="primary payment-checkout" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Перейти к оплате <span aria-hidden="true">↗</span></a><small>Страница оплаты открывается в отдельном окне браузера.</small></section>`;
    return;
  }
  button.hidden = false;
  const status = result.phase === "unknown" || result.phase === "sending"
    ? "Viva обрабатывает запрос. Повторно не отправляем его, чтобы не создать дубль."
    : failed
      ? "Viva не смогла создать страницу оплаты."
      : result.id
        ? "Viva приняла запрос. Получаем ссылку на оплату…"
        : "Viva не вернула ссылку на оплату.";
  panel.innerHTML = `<section class="payment-message ${failed ? 'payment-message-error' : ''}" role="status"><strong>${failed ? 'Оплата не создана' : 'Готовим оплату'}</strong><p>${esc(status)}</p></section>${result.id && !failed ? '<button type="button" class="secondary" id="refreshPaymentStatus">Проверить ещё раз</button>' : ''}`;
  panel.querySelector("#refreshPaymentStatus")?.addEventListener("click", async () => {
    paymentController?.abort(); paymentController = new AbortController();
    await readPaymentStatus(binding, quote, paymentController.signal);
  });
}
function paymentDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, {once:true});
  });
}
async function readPaymentStatus(binding, quote, signal) {
  const popup = root.querySelector("#quotePopup");
  try {
    for (let index = 0; index < 12; index += 1) {
      const result = await Payment.operationStatus(binding, quote, signal);
      if (signal.aborted || !popup.open) return;
      renderPaymentResponse(binding, quote, result);
      if (Payment.paymentLink(result.operation) || ["COMPLETED", "FAILED", "UNKNOWN"].includes(result.operation?.status)) break;
      await paymentDelay(2000, signal);
    }
    if (!signal.aborted && popup.open) {
      const text = popup.querySelector(".payment-status");
      const operation = Payment.previousAttempt(binding, quote)?.operation;
      if (text && !Payment.paymentLink(operation) && operation?.status !== "FAILED") text.textContent = operation?.status === "COMPLETED" ? "Операция завершена. В ответе Viva нет ссылки на оплату; проверьте JSON ниже." : "Ответ запроса показан ниже. Если ссылка ещё не появилась, проверьте статус операции.";
    }
  } catch (error) {
    if (signal.aborted || !popup.open) return;
    const message = popup.querySelector(".payment-status");
    if (message) message.textContent = "Не удалось получить статус операции. Исходный ответ сохранён; повторный запрос оплаты не отправляется.";
    if (error.status === 401) flash("Сессия Viva истекла. Войдите заново для проверки статуса.");
  }
}

function render() {
  updateProgress();
  if (state.page === "events") return renderEvents();
  if (state.page === "pickup-games") return renderPickupGames();
  if (state.step === 1) return renderArenaStep();
  if (state.step === 2) return renderDateStep(state.selectedInterval);
}

root.querySelector("#helpButton").addEventListener("click", () => openInquiry(state.mode === "game" ? "games" : state.mode === "events" ? "events" : "rent"));
root.querySelectorAll('[data-scenario]').forEach(button => button.onclick = () => switchScenario(button.dataset.scenario));
root.querySelectorAll('[data-manager]').forEach(button => button.onclick = () => openInquiry(state.mode === "game" ? "games" : state.mode === "events" ? "events" : "rent"));
root.querySelector("#homeButton").addEventListener("click", goHome);
root.querySelector("#homeLink")?.addEventListener("click", (event) => {
  event.preventDefault();
  goHome();
});
const quotePopup = root.querySelector("#quotePopup");
quotePopup.addEventListener("click", event => {
  if (event.target === quotePopup) {
    const box = quotePopup.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeQuote();
  }
});
quotePopup.addEventListener("close", () => { paymentController?.abort(); quoteReturnFocus?.focus(); });
render();
// The API clock is synchronized before loading the first schedule.

return { reset: goHome };
}
