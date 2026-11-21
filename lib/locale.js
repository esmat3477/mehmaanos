'use strict';
// Country, currency, tax and language settings. Shared by server and (copied) by the browser.

const LANGS = {
  en: { label: 'EN', rtl: false }, ar: { label: 'العربية', rtl: true }, fa: { label: 'دری', rtl: true },
  ps: { label: 'پښتو', rtl: true }, ur: { label: 'اردو', rtl: true }, hi: { label: 'हिन्दी', rtl: false }
};
// Digits after the decimal point actually used on menus.
const CURRENCIES = { AFN: 0, AED: 2, SAR: 2, QAR: 2, EUR: 2, GBP: 2, USD: 2, PKR: 0, INR: 0 };

// Presets only for countries whose rules were checked. Everything else: "Custom" + confirm with an accountant.
const PRESETS = {
  AF: { country: 'AF', currency: 'AFN', tax: { mode: 'none', rate: 0, label: 'Tax' }, languages: ['en', 'fa', 'ps'] },
  // UAE: displayed prices must include VAT (FTA); standard rate 5%.
  AE: { country: 'AE', currency: 'AED', tax: { mode: 'inclusive', rate: 500, label: 'VAT' }, languages: ['en', 'ar', 'hi', 'ur', 'fa'] }
};
const TAX_MODES = ['none', 'inclusive', 'exclusive']; // inclusive: price already contains tax; exclusive: tax added at the end

// rate is in basis points: 500 = 5.00 %
function taxOf(amount, rate, mode) {
  if (mode === 'none' || !rate) return 0;
  return mode === 'inclusive' ? Math.round(amount * rate / (10000 + rate)) : Math.round(amount * rate / 10000);
}

module.exports = { LANGS, CURRENCIES, PRESETS, TAX_MODES, taxOf };
