'use strict';

const SETTINGS = {
  DOM_SELECTORS: {
    ADD_DOCUMENT_BUTTON: 'div[role="button"].v-button.v-widget.v-has-width.p-ui-button.v-button-p-ui-button.icon-doc-text.v-button-icon-doc-text',
    DOCUMENT_DIALOG: 'div.v-window.v-widget.p-ui-dialog-window.list-detail',
    TEXT_FIELD: 'input.v-textfield.v-widget.v-has-width:not(.v-datefield-textfield)',
    DATE_FIELD: 'input.v-textfield.v-datefield-textfield',
    SUBMIT_BUTTON: 'div[role="button"], button[type="submit"], .v-button-primary, .primary'
  },
  DELAYS: { OBSERVER_TIMEOUT: 5e3, FOCUS: 100, VALIDATION: 50, PREDICTION: 80, BLUR_HIDE: 120, SUBMIT_LOCK: 100 },
  ALLOWED_YEARS: { min: 1900, max: 2030 },
  DEFAULT_VALUES: { TITLE: '', CONTENT: '', START_DATE: '01.01.2015', END_DATE: '31.12.2015' },
  FREQUENCY: { PERSIST: true, STORAGE_KEY: 'fio-suggest-frequency-v3', MAX_SUGGESTIONS: 5, BOOST_ON_SUBMIT: 1, NORMALIZE_YO: true }
};

let nextCaseNumber = 3201;

const NAME_STATISTICS = {
  0: [],
  1: [],
  2: []
};

const DATE_MASK = '\\d{2}\\.\\d{2}\\.\\d{4}';
const PATTERNS = Object.freeze({
  DATE: /^(\d{2})\.(\d{2})\.(\d{4})$/,
  TITLE_WORD: /^[А-ЯЁа-яё]+$/i,
  TITLE_GENDER_SUFFIX: /(?:^|\s)([мМжЖ])\s*$/,
  CONTENT_ALLOWED: /^[А-ЯЁа-яё0-9\s,.\-()]+$/,
  CYRILLIC_FILTER: /[^А-ЯЁа-яё\s-\d()]/g,
  DIGITS_FILTER: /[^\d.]/g,
  CONTENT_FILTER: /[^А-ЯЁа-яё\s,.\d()]/g,
  CAPITALIZE_AFTER_PAREN: /\(([a-zа-яё])/gi,
  EIGHT_DIGITS: /\D/g,
  RAW_EIGHT_DIGITS: /(?<![\d.])(\d{8})(?![\d])/g,
  TWO_DATES: new RegExp(`^(${DATE_MASK})\\s*\\((${DATE_MASK})\\)$`),
  DATE_WITH_TEXT: new RegExp(`^(${DATE_MASK})\\s*,\\s*(.+)$`)
});

const MAX_DATE_DIGITS = 8;
let predictionTimer = null;
const appState = { currentDialog: null, observer: null };

const asArray = v => Array.isArray(v) ? v : [v];
const addListeners = (el, ev, fn, o) => el && asArray(ev).forEach(t => el.addEventListener(t, fn, o));
const dispatchEvents = (el, ev) => asArray(ev).forEach(t => el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true, composed: true })));
const isDotPosition = i => i === 2 || i === 4;
const capitalizeWord = w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
const normalizeKey = w => { const s = w.trim().toLowerCase(); return SETTINGS.FREQUENCY.NORMALIZE_YO ? s.replace(/ё/g, 'е') : s; };

const GENDER_STATS = {
  maleNames: new Set([
    'александр','алексей','анатолий','андрей','антон','аркадий','арсений','артем','артём',
    'борис','вадим','валентин','валерий','василий','виктор','виталий','владимир','владислав',
    'вячеслав','геннадий','георгий','глеб','григорий','даниил','даниял','денис','дмитрий',
    'евгений','егор','захар','иван','игорь','илья','кирилл','константин','лев','леонид',
    'максим','марат','марк','матвей','мирон','михаил','никита','николай','олег','павел',
    'петр','пётр','платон','прохор','роман','руслан','савелий','семен','семён','сергей',
    'станислав','степан','тимофей','тимур','федор','фёдор','филипп','эдуард','юрий','яков','ярослав'
  ]),
  femaleNames: new Set([
    'александра','алина','алла','альбина','анастасия','ангелина','анна','антонина',
    'валентина','валерия','вера','вероника','виктория','галина','дарья','диана','динара',
    'евгения','екатерина','елена','елизавета','жанна','зоя','инна','ирина','клавдия',
    'кристина','ксения','лариса','лидия','лилия','любовь','людмила','мадина','маргарита',
    'марина','мария','надежда','наталья','наталия','нелли','нина','оксана','олеся','ольга',
    'полина','раиса','светлана','софия','софья','таисия','тамара','татьяна','эльвира','юлия','яна'
  ]),
  patronymicFemale: ['инична','овна','евна','ична'],
  patronymicMale: ['ович','евич','ич'],
  surnameRules: [
    [/(ова|ева|ёва|ина|ына)$/, 'f'],
    [/(ская|цкая)$/, 'f'],
    [/(ов|ев|ёв|ин|ын)$/, 'm'],
    [/(ский|цкий|ской|цкой)$/, 'm']
  ]
};

const genderFromSurname = (w) => {
  if (!w) return null;
  const n = normalizeKey(w);
  for (let i = 0; i < GENDER_STATS.surnameRules.length; i++) {
    const [re, g] = GENDER_STATS.surnameRules[i];
    if (re.test(n)) return g;
  }
  return null;
};

const genderFromFirstName = (w) => {
  if (!w) return null;
  const n = normalizeKey(w);
  if (GENDER_STATS.maleNames.has(n)) return 'm';
  if (GENDER_STATS.femaleNames.has(n)) return 'f';
  return null;
};

const genderFromPatronymic = (w) => {
  if (!w) return null;
  const n = normalizeKey(w);
  for (let i = 0; i < GENDER_STATS.patronymicFemale.length; i++) {
    if (n.endsWith(GENDER_STATS.patronymicFemale[i])) return 'f';
  }
  for (let i = 0; i < GENDER_STATS.patronymicMale.length; i++) {
    if (n.endsWith(GENDER_STATS.patronymicMale[i])) return 'm';
  }
  return null;
};

const genderByPartIndex = (word, partIdx) => {
  if (!word) return null;
  if (partIdx === 0) return genderFromSurname(word);
  if (partIdx === 1) return genderFromFirstName(word);
  return genderFromPatronymic(word);
};

const stripGenderSuffix = (raw) => String(raw || '').replace(/\s*\((?:М|Ж)\)\s*$/i, ' ').replace(/\s+/g, ' ').trim();

const detectGender = (rawName) => {
  const cleaned = stripGenderSuffix(rawName);
  if (!cleaned) return null;
  const parts = cleaned.split(' ').filter(Boolean);
  const g1 = genderFromSurname(parts[0]);
  if (g1) return g1;
  const g2 = parts[1] ? genderFromFirstName(parts[1]) : null;
  if (g2) return g2;
  if (parts[2]) return genderFromPatronymic(parts[2]);
  return null;
};

const detectGenderFromParts = (partsArr) => {
  const filtered = partsArr.filter(Boolean);
  if (!filtered.length) return null;
  return detectGender(filtered.join(' '));
};

const nameFrequencyStore = (() => {
  const frequencies = [new Map(), new Map(), new Map()];
  const genderMap = [new Map(), new Map(), new Map()];

  const upsert = (partIdx, key, display, delta, absolute, gender) => {
    const existing = frequencies[partIdx].get(key);
    if (existing) {
      existing.freq = absolute ? delta : existing.freq + delta;
      if (!existing.display && display) existing.display = display;
    } else {
      frequencies[partIdx].set(key, { display: display || capitalizeWord(key), freq: delta });
    }
    if (gender === 'm' || gender === 'f') genderMap[partIdx].set(key, gender);
  };

  [0, 1, 2].forEach(idx => NAME_STATISTICS[idx].forEach(([word, freq]) => {
    const g = genderByPartIndex(word, idx);
    upsert(idx, normalizeKey(word), capitalizeWord(word), freq, false, g);
  }));

  if (SETTINGS.FREQUENCY.PERSIST) {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS.FREQUENCY.STORAGE_KEY) || 'null');
      saved?.frequency?.forEach((obj, idx) => {
        if (obj && typeof obj === 'object') Object.entries(obj).forEach(([k, e]) => {
          if (e && typeof e === 'object') upsert(idx, k, e.display, e.freq || 0, false);
        });
      });
      saved?.gender?.forEach((obj, idx) => {
        if (obj && typeof obj === 'object') Object.entries(obj).forEach(([k, g]) => {
          if (g === 'm' || g === 'f') genderMap[idx].set(k, g);
        });
      });
    } catch (_) { }
  }

  const persist = () => {
    if (!SETTINGS.FREQUENCY.PERSIST) return;
    try {
      localStorage.setItem(SETTINGS.FREQUENCY.STORAGE_KEY, JSON.stringify({
        frequency: frequencies.map(m => Object.fromEntries(m)),
        gender: genderMap.map(m => Object.fromEntries(m))
      }));
    } catch (_) { }
  };

  return {
    update(word, partIdx, absolute = false) {
      const w = String(word || '').trim();
      if (!w || partIdx < 0 || partIdx > 2) return;
      const key = normalizeKey(w);
      const g = genderByPartIndex(w, partIdx);
      upsert(partIdx, key, capitalizeWord(w), SETTINGS.FREQUENCY.BOOST_ON_SUBMIT, absolute, g);
      persist();
    },
    score: (word, partIdx) => frequencies[partIdx].get(normalizeKey(word))?.freq || 0,
    genderOf(word, partIdx) {
      if (!word || partIdx < 0 || partIdx > 2) return null;
      const key = normalizeKey(word);
      return genderMap[partIdx].get(key) || genderByPartIndex(word, partIdx) || null;
    },
    getSorted(partIdx, prefix = '') {
      const p = normalizeKey(prefix), res = [];
      for (const [k, e] of frequencies[partIdx].entries()) {
        if (!p || k.startsWith(p)) res.push({ display: e.display, freq: e.freq, gender: genderMap[partIdx].get(k) || null, key: k });
      }
      return res.sort((a, b) => b.freq - a.freq || a.display.localeCompare(b.display, 'ru'));
    },
    processFullName(raw) {
      const cleaned = stripGenderSuffix(raw);
      if (!cleaned) return;
      const words = cleaned.split(' ').filter(Boolean).slice(0, 3);
      words.forEach((w, i) => {
        this.update(w, i);
        const g = genderByPartIndex(w, i);
        if (g && !genderMap[i].has(normalizeKey(w))) {
          genderMap[i].set(normalizeKey(w), g);
        }
      });
      persist();
    }
  };
})();

const suggestionPopup = {
  element: null, targetInput: null, options: [], activeIndex: -1,
  ensureCreated() {
    if (this.element) return;
    const popup = this.element = document.createElement('div');
    popup.className = 'fio-suggest-box';
    popup.setAttribute('role', 'listbox');
    Object.assign(popup.style, { position: 'fixed', zIndex: 100000, background: '#fff', border: '1px solid #d0d0d0', borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,.15)', maxHeight: '260px', overflowY: 'auto', minWidth: '180px', display: 'none', font: '16px/1.3 system-ui, -apple-system, sans-serif' });
    popup.addEventListener('mousedown', e => { const itemEl = e.target.closest('[data-idx]'); if (itemEl) { e.preventDefault(); this.selectOption(+itemEl.dataset.idx); } });
    document.body.appendChild(popup);
    document.addEventListener('mousedown', e => { if (e.target !== popup && !popup.contains(e.target) && e.target !== this.targetInput) this.hide(); }, true);
  },
  show(input, suggestions) {
    this.ensureCreated();
    if (!suggestions.length) return this.hide();
    const normalized = suggestions.map(s => typeof s === 'string'
      ? { value: s, score: 0, gender: null }
      : { value: s.value, score: s.score || 0, gender: s.gender || null });
    const sameInput = this.targetInput === input;
    if (sameInput && this.options.length === normalized.length && this.options.every((o, i) => o.value === normalized[i].value && o.score === normalized[i].score && o.gender === normalized[i].gender)) return this.position(input);
    this.targetInput = input; this.options = normalized;
    this.activeIndex = sameInput ? Math.min(this.activeIndex, normalized.length - 1) : -1;
    this.element.innerHTML = normalized.map((opt, idx) => {
      const badge = opt.score > 0 ? `<span style="float:right;color:#8a8a8a;font-size:11px;margin-left:8px;">×${opt.score}</span>` : '';
      const genderBadge = opt.gender === 'm' ? '<span style="color:#3b6fd6;margin-right:4px">♂</span>'
                        : opt.gender === 'f' ? '<span style="color:#d63b8e;margin-right:4px">♀</span>'
                        : '';
      const safeValue = String(opt.value).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
      return `<div role="option" data-idx="${idx}" style="padding:6px 10px;cursor:pointer;${idx ? 'border-top:1px solid #f0f0f0;' : ''}${idx === this.activeIndex ? 'background:#eef4ff;' : ''}">${genderBadge}${safeValue}${badge}</div>`;
    }).join('');
    this.position(input); this.element.style.display = 'block';
  },
  position(input) { const rect = input.getBoundingClientRect(); Object.assign(this.element.style, { left: rect.left + 'px', top: rect.bottom + 2 + 'px', width: rect.width + 'px' }); },
  hide() { if (this.element) this.element.style.display = 'none'; this.options = []; this.activeIndex = -1; this.targetInput = null; },
  move(step) {
    if (!this.options.length) return;
    this.activeIndex = (this.activeIndex + step + this.options.length) % this.options.length;
    [...this.element.children].forEach((child, idx) => child.style.background = idx === this.activeIndex ? '#eef4ff' : '');
    this.element.children[this.activeIndex]?.scrollIntoView({ block: 'nearest' });
  },
  selectOption(idx) {
    const option = this.options[idx], input = this.targetInput;
    if (!option || !input) return;
    input.value = option.value;
    input.setSelectionRange(option.value.length, option.value.length);
    domUtils.updateVaadinValue(input);
    input.__predictions = null;
    this.hide(); input.focus();
    if (input.__validateFn) applyValidationStyle(input, input.__validateFn(input.value));
  }
};

const applyValidationStyle = (input, isValid) => {
  if (!input) return;
  input.__valid = isValid;
  const focused = document.activeElement === input;
  input.style.boxShadow = (!isValid && !focused && input.value.trim()) ? 'inset 0 0 0 1px #e57373' : '';
};

const domUtils = {
  triggerEvents: elements => elements.forEach(el => el && dispatchEvents(el, ['input', 'change'])),
  focusElement(element, delay = SETTINGS.DELAYS.FOCUS) {
    if (element && !element.disabled && element.offsetParent !== null) setTimeout(() => element.focus(), delay);
  },
  updateVaadinValue(input) {
    if (!input) return;
    dispatchEvents(input, ['input', 'change', 'blur', 'focusout']);
    input.closest('[class*="v-textfield"]')?.dispatchEvent(new Event('value-change', { bubbles: true }));
    if (typeof input.validate === 'function') input.validate();
  }
};

const detectDesiredGender = (prefixParts) => {
  if (!prefixParts.length) return null;
  const cascade = detectGenderFromParts(prefixParts);
  if (cascade) return cascade;
  for (let i = 0; i < prefixParts.length; i++) {
    const g = nameFrequencyStore.genderOf(prefixParts[i], i);
    if (g) return g;
  }
  return null;
};

const prioritizeByGender = (candidates, desiredGender, partIdx) => {
  if (!desiredGender) return candidates;
  const resolveGender = (c) => {
    if (c.gender === 'm' || c.gender === 'f') return c.gender;
    const detected = genderByPartIndex(c.display, partIdx);
    if (detected) return detected;
    if (c.key) {
      const byKey = genderByPartIndex(c.key, partIdx);
      if (byKey) return byKey;
    }
    return null;
  };
  return candidates.slice().sort((a, b) => {
    const ga = resolveGender(a) === desiredGender ? 1 : resolveGender(a) === null ? 0 : -1;
    const gb = resolveGender(b) === desiredGender ? 1 : resolveGender(b) === null ? 0 : -1;
    if (ga !== gb) return gb - ga;
    if (b.freq !== a.freq) return b.freq - a.freq;
    return a.display.localeCompare(b.display, 'ru');
  });
};

const suggestFullName = (input) => {
  const rawValue = input.value;
  if (/(?:М|Ж)\s*$/i.test(rawValue)) return suggestionPopup.hide();

  const textBeforeCaret = rawValue.slice(0, input.selectionStart ?? rawValue.length);
  const parts = textBeforeCaret.split(/\s+/);
  const partIndex = Math.min(parts.length - 1, 2);
  const prefix = parts[partIndex] || '';
  const precedingParts = parts.slice(0, partIndex).filter(Boolean);

  const desiredGender = detectDesiredGender(precedingParts);

  let candidates = nameFrequencyStore.getSorted(partIndex, prefix);
  candidates = prioritizeByGender(candidates, desiredGender, partIndex);

  let matches = candidates.slice(0, SETTINGS.FREQUENCY.MAX_SUGGESTIONS);
  if (matches.length === 1 && normalizeKey(matches[0].display) === normalizeKey(prefix)) matches = [];

  const options = matches.map(m => ({
    value: precedingParts.length ? `${precedingParts.join(' ')} ${m.display}` : m.display,
    score: m.freq,
    gender: m.gender || genderByPartIndex(m.display, partIndex)
  }));

  input.__predictions = { options };
  options.length ? suggestionPopup.show(input, options) : suggestionPopup.hide();
};

const acceptTopPrediction = (input, validateFn) => {
  if (suggestionPopup.targetInput === input && suggestionPopup.activeIndex >= 0) { suggestionPopup.selectOption(suggestionPopup.activeIndex); return true; }
  const predictions = input.__predictions;
  if (!predictions?.options.length || predictions.options[0].value === input.value) return false;
  const topOption = predictions.options[0];
  input.value = topOption.value;
  input.setSelectionRange(topOption.value.length, topOption.value.length);
  domUtils.updateVaadinValue(input);
  applyValidationStyle(input, validateFn(input.value));
  suggestionPopup.hide();
  return true;
};

const schedulePrediction = (input) => { clearTimeout(predictionTimer); predictionTimer = setTimeout(() => suggestFullName(input), SETTINGS.DELAYS.PREDICTION); };

const countDigitsBefore = (value, caret) => {
  let count = 0;
  for (let i = 0; i < caret && i < value.length; i++) {
    const ch = value[i];
    if (/\d/.test(ch)) count++;
    else if (ch === '.' && isDotPosition(count)) continue;
    else break;
  }
  return count;
};

const caretFromDigitCount = (masked, digitCount) => {
  if (digitCount <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (/\d/.test(ch)) { if (++seen === digitCount) return i + 1; }
    else if (ch === '.' && isDotPosition(seen)) continue;
    else break;
  }
  return masked.length;
};

const extractDateDigits = (value) => {
  let digits = '', i = 0;
  while (i < value.length && digits.length < MAX_DATE_DIGITS) {
    const ch = value[i];
    if (/\d/.test(ch)) digits += ch;
    else if (!(ch === '.' && isDotPosition(digits.length))) break;
    i++;
  }
  return { digits, endIndex: i };
};

const applyDateMask = (digits) => { let out = ''; for (let i = 0; i < digits.length; i++) { if (isDotPosition(i)) out += '.'; out += digits[i]; } return out; };

const rebuildDateValue = (value) => { const { digits, endIndex } = extractDateDigits(value); return { masked: applyDateMask(digits), tail: value.slice(endIndex), digits, endIndex }; };

const isValidDate = (str) => {
  const match = str.match(PATTERNS.DATE);
  if (!match) return false;
  const [day, month, year] = [+match[1], +match[2], +match[3]];
  if (month < 1 || month > 12) return false;
  const { min, max } = SETTINGS.ALLOWED_YEARS;
  return day >= 1 && day <= new Date(year, month, 0).getDate() && year >= min && year <= max;
};

const fieldValidators = {
  caseTitle(value) {
    if (!value.trim()) return false;
    if (['Неизвестный', 'Неизвестная'].includes(value)) return true;
    const words = value.replace(/\s*\((?:М|Ж)\)$/i, '').trim().split(/\s+/).filter(Boolean);
    return words.length >= 2 && words.every(w => w.split('-').every(p => p && PATTERNS.TITLE_WORD.test(p)));
  },
  date: v => isValidDate(v.trim()),
  contentInput(value) {
    const t = value.trim();
    if (!t) return false;
    const two = t.match(PATTERNS.TWO_DATES);
    if (two) return isValidDate(two[1]) && isValidDate(two[2]);
    const wt = t.match(PATTERNS.DATE_WITH_TEXT);
    if (wt) return isValidDate(wt[1]) && !!wt[2].trim() && PATTERNS.CONTENT_ALLOWED.test(wt[2].trim());
    return PATTERNS.DATE.test(t) && isValidDate(t);
  }
};

const inputFilters = {
  cyrillic: v => v.replace(PATTERNS.CYRILLIC_FILTER, ''),
  digits: v => v.replace(PATTERNS.DIGITS_FILTER, ''),
  content: v => v.replace(PATTERNS.CONTENT_FILTER, '')
};

const autoFormatDate = (v) => {
  const d = v.replace(PATTERNS.EIGHT_DIGITS, '').slice(0, MAX_DATE_DIGITS);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}.${d.slice(2)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}`;
};

const valueFormatters = {
  title: v => v.replace(/([^\s-]+)/g, w => w.split('-').map(p => p ? (p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).replace(PATTERNS.CAPITALIZE_AFTER_PAREN, (_, l) => `(${l.toUpperCase()}`) : '').join('-'))
};

const isDocumentFormComplete = (documentFields) => [documentFields.title, documentFields.firstDate, documentFields.lastDate, documentFields.content].every(f => f && f.__valid === true);

const keyboardActions = {
  blockEnter(input, isFormComplete) {
    addListeners(input, 'keydown', e => { if (e.key === 'Enter' && !isFormComplete()) { e.preventDefault(); e.stopPropagation(); } });
  },
  acceptPredictionOnEnter(input, validateFn) {
    addListeners(input, 'keydown', (e) => {
      const popupOpen = suggestionPopup.targetInput === input && suggestionPopup.options.length > 0;
      if (popupOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); return suggestionPopup.move(1); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); e.stopPropagation(); return suggestionPopup.move(-1); }
        if (e.key === 'Escape')    { e.preventDefault(); e.stopPropagation(); return suggestionPopup.hide(); }
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault(); e.stopPropagation(); return acceptTopPrediction(input, validateFn);
        }
      }
    }, true);
  },
  createTabHandler(titleField, contentField, firstDateField, lastDateField) {
    const focusAfter = target => setTimeout(() => target?.focus(), SETTINGS.DELAYS.VALIDATION);
    const onTab = (e) => {
      if (e.key !== 'Tab' || e.shiftKey) return;
      const activeEl = document.activeElement;
      if (activeEl === titleField) {
        e.preventDefault();
        titleField.value = titleField.value.trim();
        suggestionPopup.hide();
        if (PATTERNS.TITLE_GENDER_SUFFIX.test(titleField.value)) {
          titleField.value = titleField.value.replace(PATTERNS.TITLE_GENDER_SUFFIX, (_, g) => ` (${g.toUpperCase()})`);
          domUtils.updateVaadinValue(titleField);
          const yearSuffix = `(${SETTINGS.DEFAULT_VALUES.START_DATE.slice(-4)})`;
          if (contentField.value.trim().slice(-6) !== yearSuffix) contentField.value += ` ${yearSuffix}`;
          contentField.setSelectionRange(0, 0);
          domUtils.updateVaadinValue(contentField);
        } else contentField.setSelectionRange(0, 0);
        focusAfter(firstDateField.value.trim().startsWith('01.01') ? contentField : firstDateField);
      } else if (activeEl === firstDateField) {
        const currentValue = firstDateField.value.trim();
        if (currentValue.startsWith('01.01') || !currentValue) return;
        e.preventDefault();
        setTimeout(() => { lastDateField.value = currentValue; domUtils.updateVaadinValue(lastDateField); contentField.focus(); }, SETTINGS.DELAYS.VALIDATION);
      } else if (activeEl === lastDateField) { e.preventDefault(); focusAfter(contentField); }
      else if (activeEl === contentField) { e.preventDefault(); focusAfter(titleField); }
    };
    [titleField, firstDateField, lastDateField, contentField].forEach(el => addListeners(el, 'keydown', onTab));
  }
};

const configureField = ({ input, filter, validate, format = null, autoFormat = null, isFormComplete = null, extras = {}, enablePrediction = false }) => {
  if (!input) return;
  if (format) { const formatted = format(input.value); if (formatted !== input.value) { input.value = formatted; domUtils.updateVaadinValue(input); } }
  input.__validateFn = validate;
  addListeners(input, 'input', function () {
    const caretPos = this.selectionStart, oldValue = this.value;
    const newValue = autoFormat ? autoFormat(filter(this.value)) : filter(this.value);
    applyValidationStyle(this, validate(newValue));
    if (newValue !== oldValue) {
      this.value = newValue;
      const adjustedCaret = Math.max(0, Math.min(caretPos + (newValue.length - oldValue.length), newValue.length));
      this.setSelectionRange(adjustedCaret, adjustedCaret);
      domUtils.updateVaadinValue(this);
    }
    if (enablePrediction) this.__predictions = null;
    extras.onInput?.(this);
  });
  addListeners(input, 'blur', function () {
    const processed = format ? format(this.value) : this.value;
    applyValidationStyle(this, validate(processed));
    if (processed !== this.value) { this.value = processed; domUtils.updateVaadinValue(this); }
    if (enablePrediction) {
      this.__predictions = null;
      setTimeout(() => { if (document.activeElement !== this) suggestionPopup.hide(); }, SETTINGS.DELAYS.BLUR_HIDE);
    }
    extras.onBlur?.(this);
  });
  addListeners(input, 'focus', function () {
    if (this.selectionStart === 0 && this.value) this.setSelectionRange(this.value.length, this.value.length);
    if (enablePrediction) schedulePrediction(this);
  });
  if (enablePrediction) keyboardActions.acceptPredictionOnEnter(input, validate);
  if (isFormComplete) keyboardActions.blockEnter(input, isFormComplete);
  applyValidationStyle(input, validate(input.value));
};

const moveCaretInsideParentheses = (el) => {
  const { digits, endIndex } = extractDateDigits(el.value);
  if (digits.length < MAX_DATE_DIGITS) return false;
  const parenIdx = el.value.slice(endIndex).indexOf('(');
  if (parenIdx === -1) return false;
  const parenPos = endIndex + parenIdx + 1;
  if (el.selectionStart > parenPos) return false;
  el.setSelectionRange(parenPos, parenPos);
  return true;
};

const configureContentField = (input, isFormComplete) => {
  if (!input) return;
  const applyMask = (el, digitCount, emitChange = true) => {
    const { masked, tail } = rebuildDateValue(el.value);
    const newValue = masked + tail;
    if (newValue !== el.value) {
      el.value = newValue;
      const caret = caretFromDigitCount(newValue, digitCount);
      el.setSelectionRange(caret, caret);
      if (emitChange) domUtils.updateVaadinValue(el);
    }
    applyValidationStyle(el, fieldValidators.contentInput(el.value));
  };
  addListeners(input, 'keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = this, { selectionStart: start, selectionEnd: end, value } = el;
    if (start !== end) return;
    const isBackspaceOnDot = e.key === 'Backspace' && start > 0 && value[start - 1] === '.';
    const isDeleteOnDot = e.key === 'Delete' && start < value.length && value[start] === '.';
    if (!isBackspaceOnDot && !isDeleteOnDot) return;
    const digitCount = countDigitsBefore(value, start);
    if (!isDotPosition(digitCount)) return;
    e.preventDefault();
    let idx = isBackspaceOnDot ? start - 2 : start + 1;
    const step = isBackspaceOnDot ? -1 : 1;
    while (idx >= 0 && idx < value.length && !/\d/.test(value[idx])) idx += step;
    if (idx < 0 || idx >= value.length) return;
    el.value = value.slice(0, idx) + value.slice(idx + 1);
    const newCount = isBackspaceOnDot ? digitCount - 1 : digitCount;
    applyMask(el, newCount);
    const caret = caretFromDigitCount(el.value, newCount);
    el.setSelectionRange(caret, caret);
  });
  addListeners(input, 'input', function () {
    const el = this;
    let value = el.value.replace(PATTERNS.CONTENT_FILTER, '').replace(PATTERNS.RAW_EIGHT_DIGITS, (_, d) => `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}`);
    if (value !== el.value) el.value = value;
    const caretNow = el.selectionStart;
    const { endIndex } = extractDateDigits(el.value);
    if (caretNow <= endIndex) applyMask(el, countDigitsBefore(el.value, caretNow));
    else {
      const { masked, tail } = rebuildDateValue(el.value);
      const newValue = masked + tail;
      if (newValue !== el.value) { el.value = newValue; domUtils.updateVaadinValue(el); }
      applyValidationStyle(el, fieldValidators.contentInput(el.value));
    }
    moveCaretInsideParentheses(el);
  });
  addListeners(input, 'blur', function () { applyValidationStyle(this, fieldValidators.contentInput(this.value)); });
  addListeners(input, 'value-change', function () { applyMask(this, extractDateDigits(this.value).digits.length); moveCaretInsideParentheses(this); });
  if (isFormComplete) keyboardActions.blockEnter(input, isFormComplete);
  applyValidationStyle(input, fieldValidators.contentInput(input.value));
};

const learnFromTitle = (titleField) => {
  const cleanedTitle = titleField.value.trim();
  if (fieldValidators.caseTitle(cleanedTitle)) nameFrequencyStore.processFullName(cleanedTitle);
};

const setupSubmitHandlers = (dialog, documentFields) => {
  let submitLocked = false;
  const onSubmit = (e) => {
    if (e?.type === 'keydown' && e.key !== 'Enter') return;
    if (submitLocked) return;
    submitLocked = true;
    setTimeout(() => { submitLocked = false; }, SETTINGS.DELAYS.SUBMIT_LOCK);
    const formattedTitle = valueFormatters.title(documentFields.title.value);
    if (formattedTitle !== documentFields.title.value) { documentFields.title.value = formattedTitle; domUtils.updateVaadinValue(documentFields.title); }
    if (isDocumentFormComplete(documentFields)) learnFromTitle(documentFields.title);
  };
  addListeners(documentFields.caseNumber, 'keydown', e => { if (e.key === 'Enter') onSubmit(e); });
  dialog.querySelectorAll(SETTINGS.DOM_SELECTORS.SUBMIT_BUTTON).forEach(btn => addListeners(btn, 'click', onSubmit));
  dialog.closest('form')?.addEventListener('submit', onSubmit);
};

const fillDefaultValues = (textFields, dateFields) => {
  const setIfEmpty = (el, value) => { if (el && !el.value?.trim()) el.value = value; };
  setIfEmpty(textFields[1], String(nextCaseNumber++));
  setIfEmpty(textFields[2], SETTINGS.DEFAULT_VALUES.TITLE);
  setIfEmpty(dateFields[1], SETTINGS.DEFAULT_VALUES.START_DATE);
  setIfEmpty(dateFields[2], SETTINGS.DEFAULT_VALUES.END_DATE);
  setIfEmpty(textFields[4], SETTINGS.DEFAULT_VALUES.CONTENT);
  if (textFields[2]) textFields[2].value = inputFilters.cyrillic(textFields[2].value);
};

const setupDocumentDialog = (dialog) => {
  appState.currentDialog = dialog;
  suggestionPopup.hide();
  const textFields = [...dialog.querySelectorAll(SETTINGS.DOM_SELECTORS.TEXT_FIELD)];
  const dateFields = [...dialog.querySelectorAll(SETTINGS.DOM_SELECTORS.DATE_FIELD)];
  fillDefaultValues(textFields, dateFields);
  domUtils.triggerEvents([...textFields, ...dateFields]);
  const documentFields = { caseNumber: textFields[1], title: textFields[2], content: textFields[4], firstDate: dateFields[1], lastDate: dateFields[2] };
  const isFormComplete = () => isDocumentFormComplete(documentFields);
  const handleEnterLearning = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!isFormComplete()) return;
    learnFromTitle(documentFields.title);
  };
  [documentFields.title, documentFields.firstDate, documentFields.lastDate, documentFields.content].forEach(el => addListeners(el, 'keydown', handleEnterLearning));
  configureField({ input: documentFields.title, filter: inputFilters.cyrillic, validate: fieldValidators.caseTitle, format: valueFormatters.title, isFormComplete, extras: { onInput: schedulePrediction }, enablePrediction: true });
  configureField({ input: documentFields.firstDate, filter: inputFilters.digits, validate: fieldValidators.date, autoFormat: autoFormatDate, isFormComplete });
  configureField({ input: documentFields.lastDate, filter: inputFilters.digits, validate: fieldValidators.date, autoFormat: autoFormatDate, isFormComplete });
  configureContentField(documentFields.content, isFormComplete);
  keyboardActions.createTabHandler(documentFields.title, documentFields.content, documentFields.firstDate, documentFields.lastDate);
  domUtils.focusElement(documentFields.title);
  setupSubmitHandlers(dialog, documentFields);
};

const watchForDocumentDialog = () => {
  appState.observer?.disconnect();
  appState.observer = new MutationObserver((_, observer) => {
    const dialog = document.querySelector(SETTINGS.DOM_SELECTORS.DOCUMENT_DIALOG);
    if (dialog && dialog !== appState.currentDialog) {
      observer.disconnect();
      appState.observer = null;
      setupDocumentDialog(dialog);
    }
  });
  appState.observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { appState.observer?.disconnect(); appState.observer = null; }, SETTINGS.DELAYS.OBSERVER_TIMEOUT);
};

const initializeApp = () => {
  const addDocumentButton = document.querySelector(SETTINGS.DOM_SELECTORS.ADD_DOCUMENT_BUTTON);
  if (addDocumentButton) addListeners(addDocumentButton, 'click', watchForDocumentDialog);
};

initializeApp();