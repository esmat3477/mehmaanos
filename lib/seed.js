'use strict';
// DEMO data only. Prices are placeholders, not real restaurant prices.
// Dari/Pashto strings need native-speaker review before any live use.
// Allergen data is illustrative and marked unreviewed until a manager signs it off.

const t = (en, fa, ps) => ({ en, fa, ps });

function seed() {
  return {
    schema: 3,
    restaurant: { name: 'Afghanistan Restaurant', demo: true, country: 'AF', currency: 'AFN', tax: { mode: 'none', rate: 0, label: 'Tax' }, languages: ['en', 'fa', 'ps'], defaultLang: 'en' },
    settings: { requireApproval: true, orderingPaused: false },
    menu: {
      version: 1,
      publishedAt: new Date().toISOString(),
      categories: [
        { id: 'starters', name: t('Starters', 'پیش‌غذا', 'لومړنی خواړه') },
        { id: 'mains', name: t('Main dishes', 'غذای اصلی', 'اصلي خواړه') },
        { id: 'bread', name: t('Bread & sides', 'نان و مخلفات', 'ډوډۍ او ملګري خواړه') },
        { id: 'drinks', name: t('Drinks', 'نوشابه', 'څښاک') },
        { id: 'dessert', name: t('Dessert', 'شیرینی', 'خواږه') }
      ],
      items: [
        { id: 'bolani', cat: 'starters', price: 120, spicy: true, available: true,
          name: t('Bolani', 'بولانی', 'بولانۍ'),
          desc: t('Thin flatbread filled with potato and leek', 'نان نازک با پرکردهٔ کچالو و گندنه', 'نرۍ ډوډۍ د کچالو او ګندنې سره'),
          allergens: ['gluten'] },
        { id: 'aushak', cat: 'starters', price: 220, spicy: false, available: true,
          name: t('Aushak', 'آشک', 'آشک'),
          desc: t('Leek dumplings with yoghurt and meat sauce', 'آشک گندنه با ماست و قورمه', 'د ګندنې آشک د مستو او غوښې سره'),
          allergens: ['gluten', 'milk'] },
        { id: 'kabuli', cat: 'mains', price: 350, spicy: false, available: true,
          name: t('Kabuli Pulao', 'قابلی پلو', 'کابلي پلاو'),
          desc: t('Rice with lamb, carrots and raisins', 'برنج با گوشت گوسفند، زردک و کشمش', 'وريجې د پسه غوښې، ګازرو او کشمشو سره'),
          allergens: ['nuts'] },
        { id: 'mantu', cat: 'mains', price: 280, spicy: true, available: true,
          name: t('Mantu', 'منتو', 'منتو'),
          desc: t('Steamed beef dumplings, lentil sauce, yoghurt', 'منتوی گوشت گاو با دال و ماست', 'د غوښې منتو د دال او مستو سره'),
          allergens: ['gluten', 'milk'] },
        { id: 'kabab', cat: 'mains', price: 320, spicy: true, available: true,
          name: t('Chopan Kabab', 'کباب چوپان', 'چوپان کباب'),
          desc: t('Grilled lamb skewers with naan', 'سیخ گوشت گوسفند کبابی با نان', 'د پسه غوښې کباب د ډوډۍ سره'),
          allergens: ['gluten'] },
        { id: 'qorma', cat: 'mains', price: 260, spicy: true, available: true,
          name: t('Sabzi Qorma', 'قورمه سبزی', 'سابه قورمه'),
          desc: t('Spinach stew with lamb', 'قورمهٔ پالک با گوشت', 'د پالکو قورمه د غوښې سره'),
          allergens: [] },
        { id: 'naan', cat: 'bread', price: 30, spicy: false, available: true,
          name: t('Afghan naan', 'نان افغانی', 'افغانۍ ډوډۍ'),
          desc: t('Fresh tandoor bread', 'نان تازهٔ تنوری', 'تازه تنوري ډوډۍ'),
          allergens: ['gluten', 'sesame'] },
        { id: 'salad', cat: 'bread', price: 60, spicy: false, available: true,
          name: t('Salata', 'سلاته', 'سلاته'),
          desc: t('Tomato, cucumber, onion, lemon', 'بادنجان رومی، بادرنگ، پیاز، لیمو', 'رومي بانجان، بادرنګ، پیاز، لیمو'),
          allergens: [] },
        { id: 'doogh', cat: 'drinks', price: 50, spicy: false, available: true,
          name: t('Doogh', 'دوغ', 'شلومبې'),
          desc: t('Yoghurt drink with mint', 'دوغ با نعناع', 'شلومبې د پودينې سره'),
          allergens: ['milk'] },
        { id: 'chai', cat: 'drinks', price: 40, spicy: false, available: true,
          name: t('Green tea (pot)', 'چای سبز (چاینک)', 'شنه چای (چاینک)'),
          desc: t('With cardamom', 'با هیل', 'د هیلو سره'),
          allergens: [] },
        { id: 'firni', cat: 'dessert', price: 90, spicy: false, available: true,
          name: t('Firni', 'فرنی', 'فرني'),
          desc: t('Milk pudding with pistachio', 'فرنی با پسته', 'فرني د پستې سره'),
          allergens: ['milk', 'nuts'] }
      ],
      allergenReview: null // { by, at } once a manager signs it off
    },
    tables: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map(id => ({ id, label: id, nonce: 1 })),
    orders: [],
    requests: [],
    users: [],
    audit: [],
    counters: { order: 0, request: 0, user: 0 }
  };
}

// EU 14 allergen keys (Regulation 1169/2011 Annex II).
const ALLERGENS = ['gluten', 'crustaceans', 'egg', 'fish', 'peanuts', 'soy', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'];

// Bring older saved documents up to the current schema without losing data.
function migrate(doc) {
  doc.schema = doc.schema || 1;
  if (doc.schema < 2) { doc.users = doc.users || []; doc.counters.user = doc.counters.user || 0; doc.schema = 2; }
  if (doc.schema < 3) {
    const r = doc.restaurant;
    r.country = r.country || 'AF'; r.currency = r.currency || 'AFN';
    r.tax = r.tax || { mode: 'none', rate: 0, label: 'Tax' };
    r.languages = r.languages || ['en', 'fa', 'ps']; r.defaultLang = r.defaultLang || 'en';
    doc.schema = 3;
  }
  doc.users = doc.users || [];
  return doc;
}

module.exports = { seed, migrate, ALLERGENS };
